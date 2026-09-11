// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 默认 agent loop（平台化 Phase 5 · D13，2026-08-28）——Agent 流式循环的
// 第一方默认实现。机械迁移自 agent.ts runLoop（行为逐字节一致）：
//   - `this.X` → `host.X`（宿主面 = AgentLoopHost，由 Agent._loopHost()
//     以闭包构建——私有成员不出类，活性由引用/get·set 闭包保证）；
//   - 模块级依赖（typedRpc / EventKind / StreamingToolExecutor /
//     finishReasonMessage / resolveGuardToolName / parseFilePathArg / log）
//     随体迁入本模块 import；
//   - 行为钉子：convergence phase-5 session-projection trace + phase-2
//     trace fixture + 全量 agent 测试组（turn/step/request 事件序、
//     session 溯源、压缩埋点、storm breaker 语义不变）。
//
// 替换契约：ctx.agentLoop 注册表后注册胜——替换实现只需满足 AgentLoop
// 接口（拿到同一宿主面即可接管全生命周期）。

import { kernelReadFile, typedRpcWithTimeout } from '../../rpc-contract';
import { type AgentEvent, EventKind } from '../agent-types';
import { log } from '../logger';
import { finishReasonMessage, parseFilePathArg } from '../loop-helpers';
import { StreamingToolExecutor } from '../streaming-executor';
import { resolveGuardToolName } from '../tools/domains';
import type { AgentLoopHost } from './types';

/** 默认实现寻址 id（ctx.agentLoop 注册表；后注册的替换实现胜出）。 */
export const DEFAULT_AGENT_LOOP_ID = 'builtin/default';

/** 每步 best-effort RPC 的超时兜底。本地 sqlite/文件读取正常毫秒级；
 *  3s 只在 Rust 侧卡死或回包丢失时触发——落回各自的跳过分支，
 *  循环不死等在无界 await 上（run() 永不 settle = UI 永卡运行态）。 */
const STEP_RPC_TIMEOUT_MS = 3_000;

/** promise 超时兜底（fs 域收口后 kernelReadFile 等 helper 直呼不经
 *  typedRpcWithTimeout——需保持超时的调用点本地包一层）。超时后底层
 *  promise 仍可能在途：调用方须保证超时分支的跳过是安全的（同
 *  typedRpcWithTimeout 语义）。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 默认 agent loop（出厂实现——AgentOptions 缺省 + ctx.agentLoop 构造期登记）。 */
export const defaultAgentLoop: import('./types').AgentLoop = {
  id: DEFAULT_AGENT_LOOP_ID,
  run: runDefaultLoop,
};

export async function runDefaultLoop(host: AgentLoopHost, signal: AbortSignal): Promise<void> {
  const turnStart = performance.now();
  let turnErr: unknown = null;

  try {
    host.isRunning = true;
    host.currentRunSignal = signal; // 子 Agent 派生时合并此 signal 用于级联中止
    host.sink({ kind: EventKind.TurnStarted });
    // Phase 5：轮次边界事件（无消息投影 — 回放/审计用）
    host.sessionLog.append('turn/start', { provider: host.prov.name(), model: host.prov.model() });
    // D4：turn/start 监听面广播（可观测，非模型可见——见 events.ts R1 声明）
    host.loopEvents.emitLoopEvent('turn/start', {
      agentId: host.id,
      provider: host.prov.name(),
      model: host.prov.model(),
    });

    for (let step = 0; ; step++) {
      host.loopEvents.emitLoopEvent('step/start', { agentId: host.id, step });
      // 清除上一步的临时提醒 — 提醒只应对本轮 LLM 可见。
      host.transientReminders = [];

      // Plan 模式提醒注入 — 去重逻辑在 PlanModeInjector 内部
      if (host.planState && host.planInjector) {
        let planContent = '';
        if (host.planState.state.active && host.planState.state.planFilePath) {
          try {
            // fs 域收口（kernel-capability-c3-design.md）：plan 文件读取从
            // tool_call 信封（builtin.fs.read_file_content）换 kernelReadFile
            // 直呼（fs_cap read，用户路径 is_agent=false）。超时兜底保留——
            // 读卡死只丢 plan 提醒不拖 run（本段 try/catch 已兜 skip）。
            const raw = await withTimeout(
              kernelReadFile(host.planState.state.planFilePath),
              STEP_RPC_TIMEOUT_MS,
              'plan 文件读取超时',
            );
            planContent = raw;
          } catch {
            /* plan 文件尚未写入 — 正常 */
          }
        }
        const reminder = host.planInjector.getReminder(step, host.planState.state, planContent);
        if (reminder) {
          host.transientReminders = [...host.transientReminders, `<system-reminder>\n${reminder}\n</system-reminder>`];
        }
      }

      // 中止检查 — signal 覆盖用户停止 + 会话替换（通过 execState.stop）
      if (signal.aborted) throw new Error('aborted');

      // 在安全边界应用待插入的用户消息（工具结果提交后）
      host.applyPendingInserts();
      host.applyPendingMemoryUpdates();

      host.ui.progress?.(step + 1, 'thinking');

      // 在每次 stream() 调用前排空后台任务通知（临时 —
      // 轮次结束后进度更新无价值）。按 agent_id 路由排干：全局排干会把
      // 其他 agent（含并行子 Agent）的后台任务通知吸进本 agent 上下文。
      try {
        // R3-d 信封退役：drain_bg_notifications 经 process_cap 能力口直呼
        const notes = await typedRpcWithTimeout(
          'process_cap',
          { action: 'drain_bg_notifications', agent_id: host.id },
          STEP_RPC_TIMEOUT_MS,
        );
        if (notes) {
          host.transientReminders = [...host.transientReminders, `<system-reminder>\n${notes}\n</system-reminder>`];
        }
      } catch {
        // 尽力而为 — 排空失败不阻塞循环
      }

      // 注入未读 inbox 消息（窥探 — 不消费）
      host.injectInbox();

      // 注入其他 Agent 的新发现
      host.injectDiscoveries();

      // ── 预检上下文窗口（自动压缩主触发点，2026-09 迭代）──
      // 每 step 发送前用估算检查载荷压力；≥ compactRatio(默认 0.8，随模型
      // 窗口缩放) 即**同步**压缩后再发请求 —— 绝不带超压载荷上路。
      // 取代旧的「轮末异步 maybeCompact(0.55) + step 前 0.88 兜底」双线：
      // 轮末异步压完下一轮又涨回去（工具密集轮），且 0.55 在 DeepSeek 前缀
      // 缓存计价下压的是最便宜的活跃中段、净亏；0.8 + 发送前同步把触发
      // 收紧到压力真高、压缩有净收益的时刻（对齐 DSH thresholdRatio 0.8）。
      // 没有此检查，大量工具结果 + 注入会在下一轮导致 400 错误。
      if (host.contextWindow > 0) {
        const preFlight = host.tokenCountWithEstimation();
        const preFlightRatio = preFlight / host.contextWindow;
        if (preFlightRatio >= host.compactRatioOf()) {
          if (host.compactStuck) {
            log.warn('agent', 'pre-flight skipped: compact stuck', {
              estimated: preFlight,
              ratio: preFlightRatio.toFixed(2),
            });
            host.sink({
              kind: EventKind.Notice,
              level: 'warn',
              text: `上下文使用率 ${(preFlightRatio * 100).toFixed(0)}%，但压缩已卡住。建议 /new。`,
            });
          } else if (host.compactRunning) {
            log.info('agent', 'pre-flight skipped: compact already running', {
              estimated: preFlight,
              ratio: preFlightRatio.toFixed(2),
            });
          } else {
            log.info('agent', 'pre-flight compaction triggered', {
              estimated: preFlight,
              ratio: preFlightRatio.toFixed(2),
              contextWindow: host.contextWindow,
            });
            host.sink({
              kind: EventKind.Notice,
              level: 'warn',
              text: `上下文使用率 ${(preFlightRatio * 100).toFixed(0)}%，发送前压缩…`,
            });
            try {
              const outcome = await host.compactIfNeeded(signal);
              if (outcome === 'stuck') {
                host.sink({
                  kind: EventKind.Notice,
                  level: 'warn',
                  text: '压缩无法减少上下文——消息太少。建议 /new。',
                });
              }
            } catch {
              // compactIfNeeded 已发出自身错误 — 继续让 API 错误处理器
              // （stream 中的响应式压缩）捕获
              log.warn('agent', 'pre-flight compaction failed, falling through to API call');
            }
          }
        }
      }

      // ---- Stream（带流式工具执行器 + hooks）----
      host.compactionTracker.recordTurn();
      // 平台化 Phase 5：executor 收 eventBus（host.loopEvents）——planGate/
      // preflight/hooks 经 tool/guard·preflight·around 监听面运行（Agent
      // 构造期 attach* 接线），eventBus 是唯一管道。
      const executor = new StreamingToolExecutor(
        host.tools,
        (ev: AgentEvent) => host.sink(ev),
        host.isolationId,
        signal,
        host.loopEvents,
        // 通知路由身份（bus id）— bg job owner / bash_kill 所有权（executor 注入 _owner_id）
        host.id,
      );
      host.loopEvents.emitLoopEvent('request/start', {
        agentId: host.id,
        step: step + 1,
        provider: host.prov.name(),
        model: host.prov.model(),
      });
      let { text, reasoning, signature, calls, usage, err } = await host.stream(signal, step + 1, executor);
      host.loopEvents.emitLoopEvent('request/end', {
        agentId: host.id,
        step: step + 1,
        totalTokens: usage?.total_tokens ?? null,
        err: err ? String(err.message || err) : null,
      });
      if (err) {
        log.error('agent', 'stream error', { error: String(err.message || err) });
        // 流中途失败：executor 已实时执行了部分工具（资产生成等有副作用工具），
        // 其结果必须落进上下文——否则 UI 已渲染、session 无记录，Agent 下一轮
        // 会重复执行同一任务（会话 225 事故根因：流内错误丢资产生成结果）。
        // 先把已分发的工具调用与结果补 append 进 session，再抛 err 交上层处理。
        if (calls.length > 0) {
          log.info('agent', 'stream error: preserving executed tool results', {
            calls: calls.map((c) => c.name),
            error: String(err.message || err),
          });
          host.appendMessage('assistant/text', {
            role: 'assistant',
            content: text,
            reasoning_content: reasoning,
            reasoning_signature: signature,
            tool_calls: calls,
          });
          for (const call of calls) {
            host.sessionLog.append('tool/call', { call });
          }
          const pendingResults = await executor.awaitRemaining();
          const resultsByCallId = new Map(pendingResults.map((r) => [r.call.id, r]));
          for (const call of calls) {
            const r = resultsByCallId.get(call.id);
            const content = r
              ? r.output || `(工具 ${call.name} 执行成功，无输出)`
              : `error: tool "${call.name}" did not produce a result`;
            host.appendMessage('tool/result', {
              role: 'tool',
              content,
              tool_call_id: call.id,
              name: call.name,
            });
          }
        }
        throw err;
      }

      if (usage && usage.total_tokens > 0) {
        log.info('agent', 'llm response', {
          turn: step + 1,
          // 2026-09-12 拆碑：此处曾把 provider 名填进 `model` 字段——日志读起来
          // 像「模型 = commandcodegoat」，实际那是提供方身份。两字段分开报。
          provider: host.prov.name(),
          model: host.prov.model(),
          finish_reason: usage.finish_reason,
          total_tokens: usage.total_tokens,
          prompt_tokens: usage.prompt_tokens,
          cache_hit_tokens: usage.cache_hit_tokens,
          cache_miss_tokens: usage.cache_miss_tokens,
          cache_creation_tokens: usage.cache_creation_tokens,
          completion_tokens: usage.completion_tokens,
          reasoning_tokens: usage.reasoning_tokens,
          elapsed_ms: Math.round(performance.now() - turnStart),
        });
        host.diagTokenBreakdown(usage);
        host.cacheHitTotal += usage.cache_hit_tokens;
        host.cacheMissTotal += usage.cache_miss_tokens;
        host.lastUsage = usage;
        host.sink({
          kind: EventKind.Usage,
          usage,
          session_hit: host.cacheHitTotal,
          session_miss: host.cacheMissTotal,
        });
      }

      // 异常完成原因告警
      const warnMsg = finishReasonMessage(usage);
      if (warnMsg) {
        host.sink({ kind: EventKind.Notice, level: 'warn', text: warnMsg });
      }

      // 保护: DeepSeek 拒绝既无 content 也无 tool_calls 的 assistant 消息。
      if (!text && calls.length === 0) {
        if (host.pendingInserts.length > 0 || reasoning) {
          text = reasoning ? '(思考完成)' : '(等待中)';
        } else {
          log.warn('agent', 'empty assistant turn — skipping push to avoid API 400');
          host.sink({
            kind: EventKind.Notice,
            level: 'warn',
            text: 'Provider 本次调用了但无内容返回，已跳过此轮。',
          });
          return;
        }
      }

      // 存储 assistant 轮次（reasoning 保留用于显示，不重新上传）
      host.appendMessage('assistant/text', {
        role: 'assistant',
        content: text,
        reasoning_content: reasoning,
        reasoning_signature: signature,
        tool_calls: calls,
      });
      // 工具调用审计事件（每调用一条；消息投影取自上方事件内嵌的 tool_calls — 单一事实源）
      for (const call of calls) {
        host.sessionLog.append('tool/call', { call });
      }

      if (calls.length === 0 && host.pendingInserts.length === 0) {
        host.loopEvents.emitLoopEvent('step/end', { agentId: host.id, step, toolCalls: 0 });
        return;
      }

      // ---- 收集工具结果（流式执行器在 stream 期间已执行）----
      log.info('agent', 'collect streaming results', {
        tools: calls.map((c) => c.name),
        count: calls.length,
      });
      const pendingResults = await executor.awaitRemaining();
      // 按调用顺序构建结果
      const resultsByCallId = new Map(pendingResults.map((r) => [r.call.id, r]));

      // ── Storm breaker + 压缩埋点 ──
      // 两个调用点在 6e75046（StreamingToolExecutor 清理前）丢失；
      // 在此重新接线。Storm breaker 将模型从相同失败的循环中推开；
      // tracker 用真实损失数据喂给压缩自动调优。
      const stormNudge = host.stormNudge(calls, resultsByCallId);
      for (const call of calls) {
        // 领域调用（fs/shell/...）解析回旧语义名 — 压缩追踪按旧名统计
        let guardName: string;
        try {
          guardName = resolveGuardToolName(host.tools, call.name, JSON.parse(call.arguments || '{}'));
        } catch {
          guardName = call.name;
        }
        host.compactionTracker.recordToolCall(guardName, call.arguments || '{}');
        if (guardName === 'read_file_content' || guardName === 'read_file') {
          const fp = parseFilePathArg(call.arguments);
          if (fp) host.compactionTracker.recordFileRead(fp);
        }
      }

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const r = resultsByCallId.get(call.id);
        // r 存在但 output 为空 = 工具执行成功但无输出(如 git add 成功、git diff 无差异)。
        // 空字符串是 falsy,若用 `r?.output || error` 会把成功误判成"工具没结果",
        // 导致 Agent 看到 "did not produce a result" 而困惑/重试。
        // 仅当 r 不存在(流式重试丢失、未分发)才算真正失败。
        let content = r
          ? r.output || `(工具 ${call.name} 执行成功，无输出)`
          : `error: tool "${call.name}" did not produce a result`;
        if (!r) {
          // 补发 ToolResult 终止 UI 卡片（执行器 abort 已覆盖主流路径，
          // 此处兜底任何残留缺口，防止卡片永久"执行中"——会话 223 事故）。
          host.sink({
            kind: EventKind.ToolResult,
            tool: {
              id: call.id,
              name: call.name,
              args: call.arguments,
              output: content,
              err: 'did not produce a result',
              read_only: host.toolReadOnly(call.name),
            },
          });
        }
        if (stormNudge && i === 0) content += stormNudge;
        host.appendMessage('tool/result', {
          role: 'tool',
          content,
          tool_call_id: call.id,
          name: call.name,
        });
        // 通知面板自动刷新（workspace 注入的端口）
        host.ui.toolDone?.(
          call.name,
          (() => {
            try {
              return JSON.parse(call.arguments || '{}');
            } catch {
              return {};
            }
          })(),
          r?.output || '',
        );
      }

      // 2026-09 迭代：轮末异步压缩退役 — 自动压缩主触发已前移到下轮
      // step 头（pre-flight 同步 ≥compactRatio 判定），此处不再按 usage
      // 异步触发（异步压完下一轮又涨回去，且 0.55 线在前缀缓存计价下净亏）。
      host.loopEvents.emitLoopEvent('step/end', { agentId: host.id, step, toolCalls: calls.length });
    }
  } catch (e) {
    turnErr = e;
    throw e;
  } finally {
    host.isRunning = false;
    host.ui.onStatusChange?.(false);
    host.loopEvents.emitLoopEvent('turn/end', {
      agentId: host.id,
      ok: turnErr === null,
      aborted: signal.aborted,
    });
    // 重新检查新（尚未注入的）消息 — 避免本轮已注入但未 ack 的消息
    // 导致无限循环。
    if (!signal.aborted && host.bus) {
      const hasNew = host.bus.peekInbox(host.id).some((m) => !host.injectedMsgIds.has(m.id));
      if (hasNew) {
        queueMicrotask(() => {
          void host.onMessageDelivered();
        });
      }
    }
  }
}
