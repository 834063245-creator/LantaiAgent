// shell:done 丢失自愈（watchdog）回归 —— 「shell 跑完挂起」症状类修复：
// Rust 侧命令结束即 remove_job + emit shell:done；done 偶发未达 WebView 时，
// 工具 promise 不得干等 600s 兜底（用户体感 = 永久挂起），应在探测周期内
// 按 ledger 状态（bash_output 三态）合成结算。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { legacyRpcShim } from './helpers/kernel-envelope';

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
  // P2-4 信封化：shell 命令经 tool_call 寻址 builtin.shell——shim 翻译回旧
  // (method, params) 形状（args 键 snake 化：streamToolId → stream_tool_id）
  mockRpc.mockImplementation(
    legacyRpcShim(async (name: string, params: Record<string, unknown>) => {
      if (name === 'exec_command') {
        capturedSid = String(params.stream_tool_id ?? '');
        return JSON.stringify({
          streamId: capturedSid,
          status: 'started',
          job_id: 7,
          resolvedCwd: 'D:/ws-x',
        });
      }
      if (name === 'bash_output') {
        const step = bashScript[Math.min(bashCalls, bashScript.length - 1)];
        bashCalls++;
        const r = step ? step() : '[任务运行中, 已运行: 1s]\n';
        if (r.startsWith('ERR:')) throw new Error(r.slice(4));
        return r;
      }
      return '';
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
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
