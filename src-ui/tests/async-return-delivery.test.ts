// 回传链路体检（2026-09-20）：异步子 Agent 回件 / 后台任务通知 —— 「消息真的回到父卷了吗」。
//
// 用户裁定（2026-09-20）：**async 子 Agent 与后台任务在父轮收尾后仍活着时不算「在跑」**
// ——正因如此，回传是唯一叫醒父卷的通道，必须单独体检（landmine L5 的「不算在跑」是
// 产品语义，不豁免「消息必须送到」）。
//
// 覆盖面：
//   ① 真 `spawnSubAgentImpl`（真 Agent 子实例 + 真 bus）async 完成 → 空闲父卷被唤醒 +
//      回件进父卷上下文；子 Agent 的注销时序（回传先于注销）一并钉住。
//   ② 父轮**在跑**时回件到达 → 不打断本轮；轮末由「收尾后补唤醒」（v43 从 default-loop
//      上移到 `Agent.run` finally）起新一轮把回件注入 —— v43 改动的关键路径。
//   ③ 后台任务通知（bg:note 的 bus 段）→ 空闲父卷被唤醒 + 通知进上下文；owner 不在册
//      = 投递被拒（null）——记档：通知留在 Rust 有界队列，靠 bash_output 兜底拉取。

import { describe, expect, it, vi } from 'vitest';
// 批 6c：出厂 hook 实现（state-hooks 产物）在生产由装载器常驻登记；
// service 类 ⇒ 缺实现装配期 fail-loud——本文件自行装配 Agent，须先复现该登记态。
import { installStateHooksForTest } from './helpers/state-hooks-impl';

installStateHooksForTest();

// 批 6d-2：压缩实现（compaction 产物）在生产由装载器常驻登记；service 类 ⇒ 缺实现 fail-loud。
import { installCompactionForTest } from './helpers/compaction-impl';

installCompactionForTest();

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
import { createExecState } from '../src/agent/execution-state';
import type { MessageBus } from '../src/agent/message-bus';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import { type SubAgentSpawnHost, spawnSubAgentImpl } from '../src/agent/subagent-spawn';
import { ToolRegistry } from '../src/agent/tool';
import { MeshTopology } from '../src/agent/topology';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';

/** 跑一轮就结束的 provider（记 stream 调用次数——「有没有真的起新一轮」的判据）。 */
function textProvider(text: string): { provider: Provider; calls: () => number } {
  let calls = 0;
  const provider: Provider = {
    name: () => 'mock',
    model: () => 'mock',
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        calls += 1;
        yield { type: ChunkType.Text, text };
        yield { type: ChunkType.Done };
      })(),
  };
  return { provider, calls: () => calls };
}

interface Harness {
  agent: Agent;
  bus: MessageBus;
}

/** 真 runtime 句柄 + 真 Agent + 真 bus（拓扑按生产默认面显式设 mesh）。 */
async function harness(provider: Provider): Promise<Harness> {
  const runtime = new AgentRuntime();
  const bus = runtime.getBus();
  bus.setTopology(new MeshTopology());
  const handle = await runtime.createAgent({
    agentId: 'main-return',
    parentId: null,
    projectPath: 'D:/wsReturn',
    provider,
    tools: new ToolRegistry(),
    systemPrompt: 'sys',
    eventSink: () => {},
    contextWindow: 8192,
    execState: createExecState(),
  });
  const agent = (handle as unknown as { _getAgent(): Agent })._getAgent();
  return { agent, bus };
}

/** 轮询到条件成立（确定性）。 */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error('until(): 条件未在超时内成立');
}

/** 父卷会话里是否出现了某段文本（回件注入的落点 = 一条 system-reminder 用户消息）。 */
function sessionHas(agent: Agent, needle: string): boolean {
  return agent.getSession().some((m) => typeof m.content === 'string' && m.content.includes(needle));
}

describe('回传链路：异步子 Agent 回件', () => {
  it('① 真 spawn 链路：子 Agent async 完成 → 空闲父卷被唤醒 + 回件进上下文（from=子 Agent id）', async () => {
    const sub = textProvider('子 Agent 的结论：src/a.ts 已改好');
    const h = await harness(sub.provider);

    await spawnSubAgentImpl(
      h.agent as unknown as SubAgentSpawnHost,
      '改一处',
      '把 src/a.ts 改好',
      undefined,
      'fresh',
      null,
      undefined,
      true, // asyncMode：调用方不等它，完成后经 bus 回传
      'sub-return-1',
      null,
    );

    // 回传先于注销（顺序钉在 subagent-spawn 尾部）——注销后父卷若还没处理，消息仍在父卷 inbox 里
    expect(h.bus.isRegistered('sub-return-1')).toBe(false);
    // 链路成立的证据：父卷被唤醒、真跑了一轮、把回件注入上下文
    await until(() => sessionHas(h.agent, '子 Agent 的结论'));
    expect(sessionHas(h.agent, 'from:sub-return-1')).toBe(true);
    expect(sub.calls()).toBeGreaterThan(0); // 子 Agent 真跑过（继承父 provider）
  });

  it('② 父轮在跑时回件到达：不打断本轮，轮末补唤醒起新一轮注入（v43 关键路径）', async () => {
    let sent = false;
    const base = textProvider('父轮产出');
    let bus: MessageBus | null = null;
    let parentId = '';
    // 第一轮 stream 期间投一条回件（模拟「父轮跑到一半，子 Agent 完成了」）；
    // 只投一次——否则每一轮都会再投一条，唤醒链永不收敛（这是被测语义之外的噪声）
    const provider: Provider = {
      name: () => 'mock',
      model: () => 'mock',
      stream: (signal) => {
        const inner = base.provider.stream(signal);
        return (async function* (): AsyncGenerator<Chunk> {
          for await (const chunk of inner) {
            if (chunk.type === ChunkType.Text && !sent && bus) {
              sent = true;
              bus.send({ from: 'sub-late', to: parentId, type: 'result', payload: '迟到的子 Agent 回件' });
            }
            yield chunk;
          }
        })();
      },
    };
    const h = await harness(provider);
    bus = h.bus;
    parentId = h.agent.id;
    h.bus.register({ agentId: 'sub-late', parentId: null, depth: 1 });

    const exec = createExecState();
    const run = h.agent.run(exec.beginRun('turn').signal, '父轮的输入');
    await run; // 本轮正常收尾（回件没打断它：本轮产出照常落下）
    expect(sessionHas(h.agent, '父轮产出')).toBe(true);

    // 轮末补唤醒（`Agent.run` finally 里排的微任务，早于本 await 的续体）→ 新一轮把回件注入
    await until(() => sessionHas(h.agent, '迟到的子 Agent 回件'));
    expect(sessionHas(h.agent, 'from:sub-late')).toBe(true);
    expect(base.calls()).toBeGreaterThanOrEqual(2); // 父轮 + 补唤醒轮（回件不是被本轮吞掉的）
    await until(() => !h.agent.isRunning); // 全部收尾后账上空闲（不留幽灵运行态）
  });

  it('③ 后台任务通知（bg 段）：systemNotify → 空闲父卷被唤醒 + 通知进上下文；owner 不在册 = 投递被拒', async () => {
    const base = textProvider('父轮产出');
    const h = await harness(base.provider);

    const notes = '[任务已完成, exit code: 0, 耗时: 12s] ✓ tests/a.test.ts (3 tests)';
    expect(h.bus.systemNotify(h.agent.id, 'bg', notes)).not.toBeNull();
    await until(() => sessionHas(h.agent, '任务已完成'));
    expect(sessionHas(h.agent, 'tests/a.test.ts')).toBe(true);
    expect(base.calls()).toBeGreaterThan(0); // 唤醒轮真跑过

    // owner 已消亡（子 Agent 结束注销 / 卷已关闭）= 投递被拒：通知留在 Rust 有界队列，
    // 靠 bash_output(jobId) 兜底拉取（workspace 监听面的既有判据，见其头注）。
    expect(h.bus.systemNotify('ghost-owner-gone', 'bg', notes)).toBeNull();
  });
});
