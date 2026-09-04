// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 流式 shell 执行 — 从 agent-builder 抽取，供 codingExec 与 merge-gate 共用。
//
// 2026-08-10 退役队列（shell-queue.ts 已删）：多 Agent 构建锁互斥下沉到
// Rust 侧 BuildLock（资源级原子检查 + 带路径打回，见 src-tauri/src/utils.rs）。
// 前端不再做串行化调度——互斥交给 OS/工具自带锁，决策交给 LLM。
//
// R3-d（kernel-capability-c3-design.md，shell 域收口）：invoke 目标从
// tool_call 信封（寻址 builtin.shell——插件已退役）换 process_cap 能力口直呼；
// 事件闭环（shell:output/shell:done 双事件 + 600s 兜底超时）零改。本函数收
// process_cap 顶层 snake 参数（provider 的 toCapArgs 已映射），自行附加
// stream_tool_id + capture_cwd。
//
// 粘性 cwd 截流（c3 §9：编排记忆归 TS）：capture_cwd=true 时 Rust 口按方言
// 包装命令（尾部 printf OSC marker 携带真实 PWD），marker 字节随 shell:output
// 事件流到本层——CwdMarkerFilter 截留（不进结果/进度），捕获成功即提交
// session-context 的 per-owner stickyCwd（agent 拆卸重置 = 切工作区即重置）。
//
// 职责：
//   - exec_command 的流式执行（shell:output/shell:done 事件监听 + 600s 兜底超时）
//   - 取消语义：signal abort 时 bash_kill 运行中进程（job_id 来自 Rust started 响应，
//     携带 owner 身份——Rust 侧校验只能 kill 自己发起的 job）

import { listen } from '../../bridge';
import { setStickyCwd } from '../session-context';
import { CwdMarkerFilter } from '../sticky-cwd';
import { agentInvoke } from '../tool';

const SHELL_TIMEOUT = 600_000;
/** 流式累积上限：只保留末尾，防止超长输出在 WebView/Agent 上下文里无界膨胀。 */
const STREAM_OUTPUT_CAP = 64 * 1024;
/** shell:done 丢失自愈的探测周期 —— ledger 查询（bash_output 三态判定）。 */
const SHELL_DONE_PROBE_MS = 10_000;

/** streamId → 事件解绑函数 — resolveOnce 时统一清理 */
const _shellCleanups = new Map<string, Array<() => void>>();

/** Rust started 响应：{"streamId","status","job_id","resolvedCwd"} */
function parseStartedJobId(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { job_id?: unknown };
    return typeof parsed.job_id === 'number' ? parsed.job_id : null;
  } catch {
    return null;
  }
}

/** 从 started 响应取生效起始目录（粘性 cwd 可见性回显）。 */
function parseResolvedCwd(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { resolvedCwd?: unknown };
    return typeof parsed.resolvedCwd === 'string' ? parsed.resolvedCwd : null;
  } catch {
    return null;
  }
}

/**
 * 执行前台流式 shell 命令。参数 = process_cap 顶层 snake 形（action 已是
 * 'exec_command'；codingExec 的 fg 检测后直入本函数）。
 * - signal abort：bash_kill 后 resolve 取消文案（owner 身份随命令身份透传，
 *   Rust 侧仅允许 kill 自己发起的 job）。
 * - 构建锁冲突由 Rust 侧 BuildLock 打回（返回错误信息，不排队）。
 */
export async function execStreamedShell(
  params: Record<string, unknown>,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  // 已 aborted 时根本不用建监听/发命令，直接返回取消文案。
  if (signal?.aborted) {
    return '[已取消] 命令执行被中止（agent 运行被中断）。';
  }

  // kill 所有权 / 粘性提交身份：bus id（_owner_id），回退 _agent_id（隔离子 Agent）。
  const ownerKey =
    typeof params._owner_id === 'string'
      ? params._owner_id
      : typeof params._agent_id === 'string'
        ? params._agent_id
        : undefined;
  /** Rust 侧 ledger job_id — started 响应到达前为 null（此窗口内 abort 无进程可杀） */
  let jobId: number | null = null;
  // process_cap 直呼（agentInvoke 注入 is_agent=true，与旧 tool_call 信封同构）
  const capInvoke = (capParams: Record<string, unknown>) => agentInvoke<string>('process_cap', capParams);
  const shellInvoke = (capParams: Record<string, unknown>) => capInvoke({ action: 'exec_command', ...capParams });

  const streamId = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return await new Promise<string>((resolve) => {
    void (async () => {
      let fullOutput = '';
      let streamTruncated = false;
      let resolvedCwd: string | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let probeTimer: ReturnType<typeof setInterval> | null = null;
      let settled = false;
      // 粘性 cwd 截流器（capture 包装的 marker 不进结果/进度；捕获即提交注册表）
      const cwdFilter = new CwdMarkerFilter();
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (probeTimer) {
          clearInterval(probeTimer);
          probeTimer = null;
        }
        const fns = _shellCleanups.get(streamId);
        if (fns) {
          for (const fn of fns) fn();
          _shellCleanups.delete(streamId);
        }
      };
      const resolveOnce = (v: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(v);
      };
      const appendOutput = (chunk: string) => {
        fullOutput += chunk;
        if (fullOutput.length > STREAM_OUTPUT_CAP) {
          fullOutput = fullOutput.slice(-STREAM_OUTPUT_CAP);
          streamTruncated = true;
        }
      };
      const withTruncationNote = (body: string) =>
        streamTruncated ? `[流式输出过长，只保留末尾 ${STREAM_OUTPUT_CAP} 字符]\n${body}` : body;
      /** 结果尾部追加 cwd 回显（粘性 cwd 可见性；started 响应携带生效起始目录）。 */
      const withCwdEcho = (body: string) => {
        if (!resolvedCwd) return body;
        const trimmed = body.replace(/\n+$/, '');
        return trimmed.length === 0 ? `[cwd: ${resolvedCwd}]` : `${trimmed}\n[cwd: ${resolvedCwd}]`;
      };

      const unOut = await listen<{ streamId: string; chunk: string }>('shell:output', (e) => {
        if (e.payload.streamId !== streamId) return;
        // 粘性 marker 截流：干净部分进结果/进度，捕获落点提交 per-owner 注册表
        const { clean, captured } = cwdFilter.push(e.payload.chunk);
        if (captured != null && ownerKey) setStickyCwd(ownerKey, captured);
        if (clean) {
          appendOutput(clean);
          onProgress?.(clean);
        }
      });
      const unDone = await listen<{ streamId: string; exitCode: number; error?: string }>('shell:done', (e) => {
        if (e.payload.streamId !== streamId) return;
        // 流结束：放行截流器挂起的一切（无 marker 的残段——自愈语义）
        const tail = cwdFilter.flush();
        if (tail) appendOutput(tail);
        if (e.payload.error)
          resolveOnce(
            withCwdEcho(withTruncationNote(`[exit ${e.payload.exitCode}]\n${fullOutput}\n${e.payload.error}`)),
          );
        else if (e.payload.exitCode !== 0)
          resolveOnce(withCwdEcho(withTruncationNote(`[exit ${e.payload.exitCode}]\n${fullOutput}`)));
        else resolveOnce(withCwdEcho(withTruncationNote(fullOutput || '(无输出)')));
      });
      _shellCleanups.set(streamId, [unOut, unDone]);
      timer = setTimeout(
        () =>
          resolveOnce(
            withCwdEcho(withTruncationNote(`[exit -1] shell 超时 (${SHELL_TIMEOUT / 1000}s)\n${fullOutput}`)),
          ),
        SHELL_TIMEOUT,
      );
      // 中止语义（2026-08-17 修复，会话 223 事故）：
      // 1) 监听器覆盖整个执行周期——之前 finally 里立刻摘掉，命令运行中
      //    按停止/新消息打断时 bash_kill 永不触发，进程与构建锁泄漏；
      // 2) abort 必须落地 promise（resolveOnce），否则调用方永远收不到结果，
      //    卡片停在"执行中"，且 runLoop 会追加误导性的 "did not produce a result"。
      const onAbort = () => {
        if (jobId != null) {
          void capInvoke({ action: 'bash_kill', job_id: jobId, agent_id: ownerKey }).catch(() => {});
        }
        resolveOnce(withTruncationNote(`[已取消] 命令执行被中止（agent 运行被中断）。\n${fullOutput}`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      // 如果信号在 addEventListener 前就已经 aborted（竞态窗口），手动补一次。
      if (signal?.aborted) {
        onAbort();
      }
      try {
        const startedRaw = await shellInvoke({
          ...params,
          stream_tool_id: streamId,
          // fg 前台命令请求落点捕获（Rust 口按方言包装；bg 不参与粘性）
          capture_cwd: true,
        });
        jobId = parseStartedJobId(startedRaw);
        resolvedCwd = parseResolvedCwd(startedRaw);
        // started 响应已返回：若此刻已 aborted（invoke 期间被中止），补一次 kill 并立即 resolve。
        if (signal?.aborted && jobId != null) {
          void capInvoke({ action: 'bash_kill', job_id: jobId, agent_id: ownerKey }).catch(() => {});
          resolveOnce(withTruncationNote(`[已取消] 命令执行被中止（agent 运行被中断）。\n${fullOutput}`));
        }
        // ── shell:done 丢失自愈（2026-09-03「跑完挂起」症状类修复）──
        // Rust 侧命令结束即 remove_job + emit done；done 偶发未达 WebView 时，
        // 本地只剩 600s 兜底（用户体感 = 永久挂起）。探测通道 = ledger 查询
        // （bash_output）：任务仍在 = Ok("[任务运行中]") → 继续等；探测撞上
        // 「进程刚退、monitor 未移除」窗口 = Ok("[任务已完成, exit code: N]")
        // 连终值一并带回 → 直接结算；job 已从 ledger 消失 = done 已发出但
        // 丢失 → 用本地累积输出合成结果。其它错误视为瞬时 → 下周期再探。
        // 所有失败模式都退化为「维持现状」，不引入新挂点。
        if (jobId != null) {
          probeTimer = setInterval(() => {
            void capInvoke({ action: 'bash_output', job_id: jobId })
              .then((out) => {
                if (settled) return;
                if (out.includes('[任务已完成')) resolveOnce(withCwdEcho(withTruncationNote(out)));
              })
              .catch((e: unknown) => {
                if (settled) return;
                const msg = e instanceof Error ? e.message : String(e);
                if (!msg.includes('不存在')) return;
                resolveOnce(
                  withCwdEcho(
                    withTruncationNote(
                      `[exit ?] shell:done 事件未到达（任务已从 ledger 移除），按已累积输出结算\n${fullOutput}`,
                    ),
                  ),
                );
              });
          }, SHELL_DONE_PROBE_MS);
        }
      } catch (e: unknown) {
        resolveOnce('错误: ' + e);
      }
    })();
  });
}
