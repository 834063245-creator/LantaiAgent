// shell:done 丢失自愈（watchdog）回归 —— 「shell 跑完挂起」症状类修复：
// Rust 侧命令结束即 remove_job + emit shell:done；done 偶发未达 WebView 时，
// 工具 promise 不得干等 600s 兜底（用户体感 = 永久挂起），应在探测周期内
// 按 ledger 状态（bash_output 三态）合成结算。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
/** 按事件名捕获 listener —— 测试侧模拟 shell:output / shell:done 事件到达。 */
const handlers: Record<string, (e: { payload: unknown }) => void> = {};
const mockListen = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
  handlers[event] = handler;
  return () => {
    delete handlers[event];
  };
});
vi.mock('../src/bridge', () => ({
  rpc: vi.fn((...args: any[]) => mockRpc(...args)),
  listen: vi.fn((...args: any[]) => mockListen(...args)),
  invoke: vi.fn(),
  isMockMode: () => false,
}));

import { execStreamedShell } from '../src/agent/runtime/queued-shell';
import { clearOwnerContextsForTest, registerOwnerContext, stickyCwdOf } from '../src/agent/session-context';
import { CWD_MARKER_END, CWD_MARKER_START } from '../src/agent/sticky-cwd';

let capturedSid = '';
let bashCalls = 0;
/** bash_output 探测脚本：每项返回终值字符串，'ERR:' 前缀表示 invoke 拒绝。 */
let bashScript: Array<() => string> = [];

beforeEach(() => {
  vi.useFakeTimers();
  capturedSid = '';
  bashCalls = 0;
  bashScript = [];
  mockRpc.mockReset();
  // R3-d 能力口直呼：process_cap 单方法 action 分派（builtin.shell 信封退役）。
  // 参数 = 顶层 snake（stream_tool_id / capture_cwd 由 queued-shell 附加）。
  mockRpc.mockImplementation(async (name: string, params: Record<string, unknown>) => {
    if (name === 'process_cap' && params.action === 'exec_command') {
      capturedSid = String(params.stream_tool_id ?? '');
      expect(params.capture_cwd).toBe(true);
      return JSON.stringify({
        streamId: capturedSid,
        status: 'started',
        job_id: 7,
        resolvedCwd: 'D:/ws-x',
      });
    }
    if (name === 'process_cap' && params.action === 'bash_output') {
      const step = bashScript[Math.min(bashCalls, bashScript.length - 1)];
      bashCalls++;
      const r = step ? step() : '[任务运行中, 已运行: 1s]\n';
      if (r.startsWith('ERR:')) throw new Error(r.slice(4));
      return r;
    }
    return '';
  });
});

afterEach(() => {
  vi.useRealTimers();
  clearOwnerContextsForTest();
});

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** 60s 哨兵 —— 600s 兜底之前、探测周期之后的判决窗口。 */
const NEVER = 'NEVER-SETTLED';
function withSentinel(p: Promise<string>): Promise<string> {
  return Promise.race([p, new Promise<string>((r) => setTimeout(() => r(NEVER), 60_000))]);
}

describe('execStreamedShell 的 shell:done 丢失自愈', () => {
  it('粘性 marker 截流（R3-d）：marker 不进结果/进度、捕获落点提交 per-owner 注册表', async () => {
    const dispose = registerOwnerContext('owner-1', 'D:/ws-x');
    const p = execStreamedShell({ command: 'cd sub', _owner_id: 'owner-1' });
    await flush();
    handlers['shell:output']({
      payload: { streamId: capturedSid, chunk: `out-line\n${CWD_MARKER_START}/d/ws-x/sub${CWD_MARKER_END}` },
    });
    handlers['shell:done']({ payload: { streamId: capturedSid, exitCode: 0 } });
    await flush();
    const result = await p;
    // marker 被截流（OSC 序列不进模型可见结果）
    expect(result).not.toContain('lantaicwd');
    expect(result).toContain('out-line');
    // 捕获落点已提交注册表（MSYS 归一化为 Windows 风格）
    expect(stickyCwdOf('owner-1')).toBe('d:/ws-x/sub');
    // started 回显目录（resolvedCwd）仍出现在结果尾部（粘性可见性）
    expect(result).toContain('[cwd: D:/ws-x]');
    dispose();
  });

  it('done 事件丢失 + ledger 已无任务 → 探测周期内按累积输出结算，不等 600s', async () => {
    bashScript = [() => '[任务运行中, 已运行: 5s]\n', () => 'ERR:后台任务不存在或已完成'];
    const p = execStreamedShell({ command: 'echo hi' });
    await flush();
    expect(handlers['shell:output']).toBeTruthy();
    handlers['shell:output']({ payload: { streamId: capturedSid, chunk: 'probe-accumulated\n' } });

    // 第一次探测：运行中 → 继续等；第二次探测：不存在 → 合成结算
    await vi.advanceTimersByTimeAsync(20_000);

    const result = await withSentinel(p);
    expect(result).not.toBe(NEVER);
    expect(result).toContain('probe-accumulated');
    expect(result).toContain('未到达');
  });

  it('探测撞上「进程刚退出、monitor 未移除」窗口 → bash_output 终态直接结算（含 exit code）', async () => {
    bashScript = [() => '[任务已完成, exit code: 0, 耗时: 2s]\nprobe-final-output'];
    const p = execStreamedShell({ command: 'echo hi' });
    await flush();
    handlers['shell:output']({ payload: { streamId: capturedSid, chunk: 'partial\n' } });

    await vi.advanceTimersByTimeAsync(10_000);

    const result = await withSentinel(p);
    expect(result).not.toBe(NEVER);
    expect(result).toContain('exit code: 0');
    expect(result).toContain('probe-final-output');
  });

  it('正常路径不受影响：done 事件到达即结算，探测通道不产生二次结算', async () => {
    bashScript = [() => '[任务运行中, 已运行: 5s]\n'];
    const p = execStreamedShell({ command: 'echo hi' });
    await flush();
    handlers['shell:output']({ payload: { streamId: capturedSid, chunk: 'normal-path\n' } });
    handlers['shell:done']({ payload: { streamId: capturedSid, exitCode: 0 } });
    await flush();

    const first = await Promise.race([p, new Promise<string>((r) => setTimeout(() => r(NEVER), 5_000))]);
    expect(first).toContain('normal-path');

    // done 后再走探测周期 —— resolveOnce 幂等，结算值不变
    await vi.advanceTimersByTimeAsync(25_000);
    const second = await p;
    expect(second).toBe(first);
  });
});

// ── 前台超时转后台（2026-11-12 DSH `promoted` 对齐批）──
//
// 语义：超时点之后不急杀，宽限窗用完仍没跑完 ⇒ 这条命令**变成** ledger 里的
// job（id 与 started 响应同号），监视线程接手（终态释放构建锁 + 推完成通知）。
// 模型侧唯一要记住的分支就是这段文案：它没失败、它有 job id、它该去 wait。
describe('前台超时转后台（promoted）', () => {
  it('promoted 结算：告诉模型「没失败 + job id + 去 wait」，并附已产生输出', async () => {
    bashScript = [() => '[任务运行中, 已运行: 300s]\n'];
    const p = execStreamedShell({ command: 'npm run build', _owner_id: 'owner-p1' });
    await flush();
    handlers['shell:output']({ payload: { streamId: capturedSid, chunk: 'compiling...\n' } });
    handlers['shell:done']({
      payload: { streamId: capturedSid, exitCode: -1, promotedJobId: 42 },
    });
    await flush();

    const result = await withSentinel(p);
    expect(result).not.toBe(NEVER);
    // 三个必须成立的事实
    expect(result).toContain('转入后台');
    expect(result).toContain('job 42');
    expect(result).toContain('没有失败');
    expect(result).toContain('不要重跑');
    // 可操作指引 = wait（不是 output 轮询）
    expect(result).toContain('bash_wait(42)');
    expect(result).not.toContain('bash_output(42)');
    // 已产生的输出照常带上（转后台不等于丢输出）
    expect(result).toContain('compiling...');
  });

  it('promoted 无任何输出也结算（空输出不是失败）', async () => {
    const p = execStreamedShell({ command: 'sleep 900' });
    await flush();
    handlers['shell:done']({ payload: { streamId: capturedSid, exitCode: -1, promotedJobId: 7 } });
    await flush();

    const result = await withSentinel(p);
    expect(result).not.toBe(NEVER);
    expect(result).toContain('job 7');
    expect(result).toContain('bash_wait(7)');
  });

  it('没带 promotedJobId 的 done 仍走原路径（普通超时/失败文案不变）', async () => {
    const p = execStreamedShell({ command: 'false' });
    await flush();
    handlers['shell:done']({ payload: { streamId: capturedSid, exitCode: 3 } });
    await flush();

    const result = await withSentinel(p);
    expect(result).toContain('[exit 3]');
    expect(result).not.toContain('转入后台');
  });

  it('转后台后按停止 ⇒ bash_kill 打的是同一个 job id（锁与进程都有人收）', async () => {
    bashScript = [() => '[任务运行中, 已运行: 300s]\n'];
    const ac = new AbortController();
    const p = execStreamedShell({ command: 'npm run build', _owner_id: 'owner-p2' }, undefined, ac.signal);
    await flush();
    // 先经历一次 promote（job 7 = started 响应里的同一个 id）
    handlers['shell:done']({ payload: { streamId: capturedSid, exitCode: -1, promotedJobId: 7 } });
    await flush();
    const promoted = await withSentinel(p);
    expect(promoted).toContain('job 7');

    // 注意：promote 已 resolve 这条 promise（前台调用结束）；后续的停止由模型
    // 对 job 7 发起 bash_kill —— 这里钉住「id 不变」这条不变量。
    ac.abort();
    await flush();
    // 已经 settle 的 promise 不会被 abort 二次改写（resolveOnce 幂等）
    expect(promoted).toContain('job 7');
  });
});
