// landmine L3 复现钉（2026-09-20）——「不认 signal 的 await 没有硬截止 ⇒ run() 永不 settle」。
//
// 为什么钉在这里：`docs/landmine-map.md` L3 只写了复现配方（文字），没有可执行证据；
// 本文件把它变成会跑的用例。**注意 `it.fails`**：用例断的是「修好之后应有的行为」，
// 今天必然失败 ⇒ it.fails 视为通过。**L3 一旦被拆，这两条会转红**——那时把它们改写为
// 正向断言（run() 在硬截止内以具名错误 settle / 停止能解旋），不要删掉了事。
//
// 现状机制（三层活性守卫，只有一层管「模型请求」这条链）：
//   ① `provider/idle-stream.ts`：30s 空闲计时 → **只 abort 一个 AbortController**
//      （`STREAM_IDLE_TIMEOUT_MS = 30_000`）。它兜得住「fetch 认 abort」的形态：
//      流中断 ⇒ `[响应超时]` 停滞错误 ⇒ `STALL_RETRY_BUDGET_MS`（15 分钟）预算内重试 ⇒
//      预算耗尽落可见失败。**兜不住不认 abort 的 await**：计时器 abort 的对象没人听，
//      `for await` 永不返回 ⇒ 重试循环根本没机会前进 ⇒ 15 分钟预算永不生效。
//   ② `streaming-executor` 的 `awaitRemaining()` 有 30 分钟 backstop（工具不返回时回合
//      仍能往前；但那条工具还在跑 = 孤儿副作用）。
//   ③ 就这些。「模型请求」这条链上（provider.stream 内部的本机 IPC / 凭据解析 /
//      任何自己 await 住不放的适配器）**没有任何绝对截止**。
//
// 用户可感知后果：
//   - 停止钮按下去不顶用（signal 已 abort，但对不认 signal 的 await 无效）；
//   - run() 不 settle ⇒ 调用方（chat-core 的 await / 唤醒链）那条 finally 永不执行；
//   - v43 之前：运行态**永远**是「在跑」（UI 永卡，重启才恢复）；
//   - v43 之后：记账在用户停止时注销 ⇒ UI 能回到空闲、能发新消息（逃生舱有了），
//     但那条 loop 仍在栈上（`_loopDepth > 0`），新轮会与它并发 → 并发留痕 log.error，
//     且该轮此后永远不会自己收尾——**症状从「卡住」变成「幽灵」**，根因未拆。

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/settings', () => ({
  loadSettings: () => ({ display: { language: 'zh', fontScale: 1 }, agent: {}, providers: [] }),
  getActiveProvider: () => ({ name: 'none', kind: 'openai', apiKey: '' }),
  modelContextWindow: () => 8192,
  providerId: (name: string) => name,
}));
vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(async () => '{}'),
  typedJsonRpc: vi.fn(async () => ({})),
  typedListen: vi.fn(async () => () => {}),
  parseJson: (raw: unknown) => JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw ?? 'null')),
  kernelGlobalMemoryDir: async () => 'D:/mock/global-memory',
  kernelCreateDirectory: async () => '',
  kernelReadFile: vi.fn(async () => ''),
  kernelWriteFile: vi.fn(async () => ''),
  kernelDeleteFile: vi.fn(async () => ''),
  kernelProcessCall: vi.fn(async () => '{}'),
}));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/bridge', () => ({ isMockMode: () => false }));

import type { Agent } from '../src/agent/agent';
import { createExecState, type ExecStateInstance } from '../src/agent/execution-state';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';

/** 不认 signal 的假 provider：`stream()` 立刻返回一个**永不产出、永不结束**的生成器
 *  （L3 配方原文：`await new Promise(()=>{})`，且不监听 abort）。 */
function blackHoleProvider(): Provider {
  return {
    name: () => 'black-hole',
    model: () => 'black-hole',
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        await new Promise<void>(() => {}); // 永不落定；无视 signal
        // eslint-disable-next-line no-unreachable
        yield { type: 0 } as unknown as Chunk;
      })(),
  };
}

async function harness(): Promise<{ agent: Agent; exec: ExecStateInstance }> {
  const runtime = new AgentRuntime();
  const exec = createExecState();
  const handle = await runtime.createAgent({
    agentId: 'main-l3',
    parentId: null,
    projectPath: 'D:/wsL3',
    provider: blackHoleProvider(),
    tools: new ToolRegistry(),
    systemPrompt: 'sys',
    eventSink: () => {},
    contextWindow: 8192,
    execState: exec,
  });
  return { agent: (handle as unknown as { _getAgent(): Agent })._getAgent(), exec };
}

describe('landmine L3：不认 signal 的 await 没有硬截止', () => {
  it.fails('① run() 永不 settle（停止钮按下后也不 settle）—— 修好后：应在硬截止内以具名错误收场', async () => {
    vi.useFakeTimers();
    try {
      const { agent, exec } = await harness();
      const run = exec.beginRun('turn');
      let settled = false;
      const p = agent.run(run.signal, '问一句').then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      // 推进 120s：30s 空闲守卫已 fire（abort 了一次没人听的 controller），15 分钟停滞
      // 预算也已在途——但「这一发」从未失败，重试循环无从前进。
      await vi.advanceTimersByTimeAsync(120_000);
      // 用户按停：signal abort + 记账注销（v43 的逃生舱）——对不认 signal 的 await 无效。
      exec.stopAll();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(settled).toBe(true); // ← 今天恒 false：run() 不 settle = L3
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it.fails('② 停止即注销记账（v43 逃生舱有），但那条 loop 永远留在栈上 —— 修好后：停止应能真正解旋', async () => {
    const { agent, exec } = await harness();
    const run = exec.beginRun('turn');
    void agent.run(run.signal, '问一句').catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    expect(exec.isRunning).toBe(true); // 在跑（诚实）
    exec.stopAll();
    expect(exec.isRunning).toBe(false); // UI 回空闲（逃生舱）
    expect(run.signal.aborted).toBe(true); // 停止已下达

    // 但 loop 仍挂在那个 await 上：`_loopDepth > 0`（执行面事实，见 Agent.runLoop 守卫）。
    // 修好之前这里恒为 true —— 「幽灵轮」：此后再起的轮次都会与它并发（并发留痕）。
    expect((agent as unknown as { _loopDepth: number })._loopDepth).toBe(0);
  });
});
