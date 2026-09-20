// 运行看门狗 —— 「不认 signal 的 await」的硬截止与遗弃语义（landmine L3 拆弹，2026-09-20）。
//
// 本文件前身是 L3 的**复现钉**（两条 `it.fails`，断的是「修好之后应有的行为」）。
// 修复落地后按原文件的交代**改写为正向断言**（不是删除、也不是新增重复用例）。
//
// 病灶原文（`docs/landmine-map.md` 第四批 L3）：「模型请求」这条链上唯一的活性守卫是
// `provider/idle-stream.ts` 的 30s 空闲计时器，而它只做一件事 —— abort 一个
// AbortController。等待方不认 signal（本机 IPC / 凭据解析 / 吞掉 abort 的适配器与
// SSE 读）时 `for await` 永不返回 ⇒ 连「停滞错误」都产不出来 ⇒ `provider/retry.ts`
// 的 15 分钟停滞预算永不生效 ⇒ `agent.run()` 永不 settle（停止钮无效）。
//
// 本文件的断言分四组：
//   ① 硬截止：永不产出、不认 signal 的 provider → run() 在阈值内以具名错误 settle，
//      且 finally 照常（记账注销 / 不补唤醒）；
//   ② 慢而不死**不得误杀**：每 4 分钟 1 token 的 provider 必须活到正常结束
//      ——脉搏定义（含 chunk 到达）错了就会砍到慢模型，这是本拆弹最大的回归风险；
//   ③ 遗弃语义：迟到 chunk / 迟到工具结果只留审计、不进 session 投影；重试循环
//      在作废后不再发下一次请求（否则硬截止白设）；
//   ④ 停止语义升级：停止后 loop 真解旋（`_loopDepth === 0`），不只是清账。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { log } from '../src/agent/logger';
import {
  isRunDeadlineExceeded,
  NO_PROGRESS_WARN_MS,
  RUN_ABANDON_MS,
  type RunWatchdogThresholds,
  setRunWatchdogThresholds,
} from '../src/agent/run-watchdog';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import { ToolRegistry } from '../src/agent/tool';
import { MeshTopology } from '../src/agent/topology';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';

/* ── 故障注入：不认 signal 的 provider（L3 配方原文）── */

/** 永不产出、永不结束的生成器（`await new Promise(()=>{})`，且无视 signal）。 */
function blackHoleProvider(): Provider {
  return {
    name: () => 'black-hole',
    model: () => 'black-hole',
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        await new Promise<void>(() => {}); // 永不落定；无视 signal
        yield { type: ChunkType.Text, text: '迟到的一口' };
      })(),
  };
}

/** 慢而不死的形态：**每 4 分钟 1 token**（生产阈值下 4min ≪ 20min 无进展窗）。
 *
 *  ⚠ 测试台机械：provider 那 4 分钟的等待要**切成 ≤30s 的片**。原因不是语义，
 *  是假时钟的排程伪影——`advanceTimersByTimeAsync` 先把假时钟推到目标时刻再逐
 *  个跑定时器，于是一次 40 分钟的推进会让看门狗每隔 30s 读到「距上次脉搏 4 分钟」
 *  （假时钟跳变，真实时钟不可能这样跳）。切片之后每次唤醒都紧跟在推进段内，
 *  与真机的「每 4 分钟一个 chunk」逐段等价（provider 侧多吐的切片标记见
 *  `HB_MARK`，断言前剥掉）。 */
const HB_TICK_MS = 4 * 60_000; // 一步心跳的间隔（4 分钟）
const HB_SLICE_MS = 30_000; // provider 侧切片粒度（≤ 看门狗巡检步长）
const HB_COUNT = 8;
const HB_MARK = '\u200b'; // 零宽空格：provider 侧保活标记，投影前剥掉

function heartbeatProvider(): Provider {
  return {
    name: () => 'heartbeat',
    model: () => 'heartbeat',
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        for (let i = 0; i < HB_COUNT; i++) {
          if (i > 0) {
            for (let waited = 0; waited < HB_TICK_MS; waited += HB_SLICE_MS) {
              const slice = Math.min(HB_SLICE_MS, HB_TICK_MS - waited);
              await new Promise<void>((r) => setTimeout(r, slice));
              // 切片本身不产出内容：只吐一个保活标记（断言前剥），4 分钟一到才吐真 token
              if (waited + slice < HB_TICK_MS) yield { type: ChunkType.Text, text: HB_MARK };
            }
          }
          yield { type: ChunkType.Text, text: `t${i}` };
        }
        yield { type: ChunkType.Done };
      })(),
  };
}

/** 「迟到者」：吐一段文本 + 一个工具调用（工具本体要 10 分钟才返回），挂住一段，
 *  最后**在作废之后**再吐一口迟到的文本。 */
const LATE_TEXT_AFTER_ABANDON = '作废之后才吐出来的迟到正文';
function lateChunkProvider(lateAfterMs = 5 * 60_000): Provider {
  return {
    name: () => 'late',
    model: () => 'late',
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        yield { type: ChunkType.Text, text: '迟到轮的前半段' };
        yield {
          type: ChunkType.ToolCall,
          tool_call: { id: 'c-late', name: 'slow_tool', arguments: '{}' },
        } as unknown as Chunk;
        // 挂住：作废点落在这里；作废之后**仍然吐一口**（生成器是孤儿的，
        // 那一口已经没有消费者——本文件的用例要证明的正是「它不会进投影」）
        await new Promise<void>((r) => setTimeout(r, lateAfterMs));
        lateYielded = true;
        yield { type: ChunkType.Text, text: LATE_TEXT_AFTER_ABANDON };
      })(),
  };
}
/** 上面那个「迟到一口」是否真的吐出来了（否则「没进投影」是假绿——压根没吐）。 */
let lateYielded = false;

/** 只记调用次数的 provider 包装（「有没有再发一次请求」的判据）。 */
function counting(prov: Provider): { prov: Provider; calls: () => number } {
  let calls = 0;
  return {
    prov: {
      name: prov.name,
      model: prov.model,
      stream: (signal: AbortSignal, req: unknown) => {
        calls += 1;
        return prov.stream(signal, req as never);
      },
    },
    calls: () => calls,
  };
}

/* ── 装配 ── */

async function harness(
  provider: Provider,
  exec = createExecState(),
): Promise<{ agent: Agent; exec: ExecStateInstance; runtime: AgentRuntime }> {
  const runtime = new AgentRuntime();
  const handle = await runtime.createAgent({
    agentId: 'main-l3',
    parentId: null,
    projectPath: 'D:/wsL3',
    provider,
    tools: new ToolRegistry(),
    systemPrompt: 'sys',
    eventSink: () => {},
    contextWindow: 0, // 关掉压缩：本文件的场景与压缩无关，别让压缩路径混进来
    execState: exec,
  });
  return { agent: (handle as unknown as { _getAgent(): Agent })._getAgent(), exec, runtime };
}

/** 走到 loop 真正用的那个投影入口（`AgentLoopHost.appendMessage` = `Agent._appendMessage`
 *  ——默认 loop 与第三方 loop 共用同一入口，投影栅栏就落在这里）。 */
function hostAppendMessage(agent: Agent): (kind: string, message: Record<string, unknown>) => void {
  const host = agent as unknown as {
    _loopHost(): { appendMessage(kind: string, message: Record<string, unknown>): void };
  };
  return (kind, message) => host._loopHost().appendMessage(kind, message);
}

function lateTool(): { tool: import('../src/agent/tool').Tool; settled: () => boolean } {
  let done = false;
  return {
    tool: {
      name: () => 'slow_tool',
      description: () => '10 分钟后才返回的工具',
      parameters: () => ({ type: 'object', properties: {}, required: [] }),
      readOnly: () => true,
      execute: async () => {
        await new Promise<void>((r) => setTimeout(r, 10 * 60_000));
        done = true;
        return '迟到的工具结果';
      },
    },
    settled: () => done,
  };
}

const SHORT: RunWatchdogThresholds = { warnMs: 60_000, abandonMs: 120_000 };

/** 排空微任务（假时钟下 `advanceTimersByTimeAsync` 不保证把「定时器唤醒后排队
 *  的续体」全部跑完——本文件里那一步是「迟到的一口被投影入口处理」）。 */
const flushMicrotasks = async (n = 50): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  setRunWatchdogThresholds({ warnMs: NO_PROGRESS_WARN_MS, abandonMs: RUN_ABANDON_MS });
});

describe('L3 硬截止 —— 到期语义是「无进展」而非绝对截止', () => {
  it('阈值口径：无进展 warn 5min / abandon 20min；绝对上限刻意不设', () => {
    expect(NO_PROGRESS_WARN_MS).toBe(5 * 60_000);
    expect(RUN_ABANDON_MS).toBe(20 * 60_000);
    // 注入面不止改常量：注进去的值就是生效的值（真机复现靠它把阈值临时调到 60s）
    setRunWatchdogThresholds({ abandonMs: 60_000 });
    expect(RUN_ABANDON_MS).toBe(20 * 60_000); // 常量不动
  });

  it('① 永不产出的 provider：run() 在阈值内以 RunDeadlineExceededError settle，finally 照常', async () => {
    vi.useFakeTimers();
    setRunWatchdogThresholds(SHORT);
    const { agent, exec } = await harness(blackHoleProvider());
    const run = exec.beginRun('turn'); // 认领：调用方铸 signal（生产形态）
    const startedAt = Date.now();

    let settledAt = Number.NaN;
    let caught: unknown;
    const settled = agent
      .run(run.signal, '问一句')
      .catch((e: unknown) => {
        caught = e;
      })
      .finally(() => {
        settledAt = Date.now();
      });

    await vi.advanceTimersByTimeAsync(SHORT.abandonMs + 5_000);
    await settled;

    // ① 具名错误（不是「aborted」那种要读文案猜的东西）
    expect(isRunDeadlineExceeded(caught), `期望 RunDeadlineExceededError，实收 ${String(caught)}`).toBe(true);
    // ② 在阈值内（+ 巡检步长余量）settle —— 旧行为：永不 settle
    expect(settledAt - startedAt).toBeLessThanOrEqual(SHORT.abandonMs + 35_000);
    // ③ finally 照常跑完：记账注销 + 运行账空闲（UI 不会卡在「在跑」）
    expect(exec.isRunning).toBe(false);
    // ④ 到期三件事都做了：栅栏（已由 RunPulse 打上，见下方投影断言）+ abort
    //   （认 signal 的等待方由此解旋；signal 由本账铸则本账有权中止）…
    expect(run.signal.aborted).toBe(true);
    // ⑤ 没收到的东西不许假装收到：这一轮的投影里没有助手消息（用户来文早在作废前已落）
    expect(agent.getSession().some((m) => m.role === 'assistant')).toBe(false);
    // ⑥ 日志面：作废行含身份与口径（真机取证面）
    const abandonLog = vi
      .mocked(log.warn)
      .mock.calls.map((c) => JSON.stringify(c))
      .find((s) => s.includes('无进展超硬截止'));
    expect(abandonLog, 'ui.log 里没有作废行').toBeDefined();
    expect(abandonLog).toContain('runId');
    expect(abandonLog).toContain('no_progress_ms');
    expect(abandonLog).toContain('last_pulse');
  });

  it('② 慢而不死不得误杀：每 4 分钟 1 token 的 provider 活到正常结束', async () => {
    vi.useFakeTimers();
    setRunWatchdogThresholds(SHORT); // 注入面生效的证明：这条若误杀，说明脉搏没算 chunk 到达
    const { agent } = await harness(heartbeatProvider());

    const run = agent.run(new AbortController().signal, '慢工出细活');
    // 一段一段推（每段 ≤ 心跳切片）：假时钟一把跳到顶会让看门狗读到**跳变量**
    // 当「无进展时长」（见 heartbeatProvider 头注），那不是被测语义。
    for (let i = 0; i < HB_COUNT; i++) {
      await vi.advanceTimersByTimeAsync(HB_TICK_MS + HB_SLICE_MS);
    }
    await expect(run).resolves.toBeUndefined();

    // 全部 8 口都进了卷（正常收尾，不是被砍在某一步）；保活标记剥掉
    const text = agent
      .getSession()
      .filter((m) => m.role === 'assistant')
      .map((m) => String(m.content))
      .join('')
      .split(HB_MARK)
      .join('');
    expect(text).toBe('t0t1t2t3t4t5t6t7');
    // 没有作废行（脉搏含「chunk 到达」——这是慢模型不被误杀的**唯一**依据）
    const abandons = vi.mocked(log.warn).mock.calls.filter((c) => JSON.stringify(c).includes('无进展超硬截止'));
    expect(abandons).toEqual([]);
  });

  it('无进展报警：只报一次（不刷屏），且不动行为（run 继续在跑）', async () => {
    vi.useFakeTimers();
    setRunWatchdogThresholds(SHORT);
    const { agent } = await harness(blackHoleProvider());
    const run = agent.run(new AbortController().signal, '问一句');
    const settled = run.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(SHORT.warnMs + 35_000);
    const warns = () => vi.mocked(log.warn).mock.calls.filter((c) => JSON.stringify(c).includes('仍未放弃'));
    expect(warns().length).toBe(1);
    // 报警不改行为：此刻还没到硬截止，这一轮仍在跑
    let done = false;
    void settled.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    // 继续推进（越过报警点很远）仍只有那一条
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warns().length).toBe(1);

    await vi.advanceTimersByTimeAsync(SHORT.abandonMs);
    await settled;
  });
});

describe('L3 遗弃语义 —— 迟到的事实只留审计，不进投影', () => {
  it('③ 作废后迟到 chunk 不改 session 投影；重试循环也不再发下一次请求', async () => {
    vi.useFakeTimers();
    setRunWatchdogThresholds(SHORT);
    // 形态：先吐一口正文与一个工具调用，挂住（作废点），**作废之后再吐一口正文**。
    // 那一口是「幽灵轮的迟到产物」原形：消费者（streamOnce 的 for await）此刻已经
    // 随 signal 中止退出了，它不再有任何人接收——**更不允许以任何路径进卷**。
    const { prov, calls } = counting(lateChunkProvider(5 * 60_000));
    const { agent, exec } = await harness(prov);
    lateYielded = false;

    const run = exec.beginRun('turn');
    const settled = agent.run(run.signal, '问一句').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SHORT.abandonMs + 5_000);
    const err = await settled;

    expect(isRunDeadlineExceeded(err)).toBe(true);
    // 基线取「本轮来文已落、助手还没落」的那一刻（run 前快照会把来文自己算成增量）
    const sessionAfterAbandon = agent.getSession().length;
    expect(agent.getSession().map((m) => m.role)).toEqual(['system', 'user']);
    // 推进到 10 分钟后：迟到的正文此刻确实已经吐出来了（越过作废点 5 分钟）
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flushMicrotasks();
    expect(lateYielded, '迟到的那一口根本没吐出来——下面的投影断言是假绿').toBe(true);
    expect(agent.getSession().length).toBe(sessionAfterAbandon);
    expect(agent.getSession().some((m) => m.role === 'assistant')).toBe(false);
    expect(agent.getSession().some((m) => String(m.content).includes(LATE_TEXT_AFTER_ABANDON))).toBe(false);
    // 作废 = 这一轮判死：不许「当成一次普通失败」再发下一发（否则硬截止白设）
    expect(calls()).toBe(1);
  });

  it('③b 投影入口的栅栏本身：作废之后任何 loop（含第三方）的 append 都被拒', async () => {
    vi.useFakeTimers();
    setRunWatchdogThresholds(SHORT);
    const { agent, exec } = await harness(blackHoleProvider());

    const run = exec.beginRun('turn');
    const settled = agent.run(run.signal, '问一句').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SHORT.abandonMs + 5_000);
    await settled;

    // 走 loop 真正用的那个入口（默认 loop 与第三方 loop 共用；栅栏落在它内部）
    const append = hostAppendMessage(agent);
    const before = agent.getSession().length;
    vi.mocked(log.warn).mockClear();
    append('assistant/text', { role: 'assistant', content: '作废之后还想写进卷的一口' });
    append('tool/result', { role: 'tool', content: '迟到的工具结果', tool_call_id: 'c-x', name: 'x' });

    expect(agent.getSession().length, '作废轮的迟到事实进了会话投影').toBe(before);
    const fenced = vi
      .mocked(log.warn)
      .mock.calls.filter((c) => JSON.stringify(c).includes('作废轮的迟到事实被栅栏拦下'));
    expect(fenced.length, '栅栏没留痕（宪法四：任何「放弃」都要有 warn）').toBe(2);
  });

  it('④ 作废后迟到工具调用：tool/call 审计事实在 session-log，会话投影里没有它', async () => {
    vi.useFakeTimers();
    setRunWatchdogThresholds(SHORT);
    const { tool, settled: toolSettled } = lateTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const runtime = new AgentRuntime();
    const exec = createExecState();
    const handle = await runtime.createAgent({
      agentId: 'main-l3-tool',
      parentId: null,
      projectPath: 'D:/wsL3',
      provider: lateChunkProvider(),
      tools: registry,
      systemPrompt: 'sys',
      eventSink: () => {},
      contextWindow: 0,
      execState: exec,
    });
    const agent = (handle as unknown as { _getAgent(): Agent })._getAgent();

    const run = exec.beginRun('turn');
    const settled = agent.run(run.signal, '问一句').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SHORT.abandonMs + 5_000);
    const err = await settled;
    expect(isRunDeadlineExceeded(err)).toBe(true);

    // 审计面：模型宣布过的那次调用留在事件日志里（「谁在什么时候想做什么」不丢）
    const auditKinds = agent
      .getSessionLog()
      .events()
      .map((e) => e.kind);
    expect(auditKinds).toContain('tool/call');
    // 投影面：会话里没有 tool 消息（结果永远没进卷）
    expect(agent.getSession().some((m) => m.role === 'tool')).toBe(false);

    // 工具本体在很久以后才真的返回（10 分钟）——迟到者不得把结果补进投影
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(toolSettled()).toBe(true); // 它确实跑完了（孤儿副作用：本雷的第二层代价，见 executor backstop）
    expect(agent.getSession().some((m) => m.role === 'tool')).toBe(false);
    expect(agent.getSession().length).toBe(agent.getSessionLog().deriveMessages().length); // 投影与日志仍然等价（没有绕过入口的写入）
  });

  it('⑤ 作废轮不补唤醒：inbox 里的消息留待下一次（不再顺手叫起新轮）', async () => {
    vi.useFakeTimers();
    setRunWatchdogThresholds(SHORT);
    const { prov, calls } = counting(blackHoleProvider());
    const runtime = new AgentRuntime();
    const bus = runtime.getBus();
    const handle = await runtime.createAgent({
      agentId: 'main-l3-wake',
      parentId: null,
      projectPath: 'D:/wsL3',
      provider: prov,
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
      eventSink: () => {},
      contextWindow: 0,
      execState: createExecState(),
    });
    const agent = (handle as unknown as { _getAgent(): Agent })._getAgent();
    const agentId = agent.id;
    bus.setTopology(new MeshTopology());
    bus.register({ agentId, parentId: null, depth: 0 });

    // 本轮：用户发起的回合（黑洞 provider——挂住，等硬截止）
    const run = agent.run(new AbortController().signal, '问一句').catch((e: unknown) => e);
    expect(calls()).toBe(1);

    // 迟到回件：**本轮进行中**投进 inbox（本轮 loop 已过注入点，收尾时它仍在 inbox 里）
    bus.send({ from: 'sub-late', to: agentId, type: 'result', payload: '作废之后才到的回件' });
    const before = calls();
    expect(bus.peekInbox(agentId).length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(SHORT.abandonMs + 5_000);
    await run;
    const orphanDepth = (agent as unknown as { _loopDepth: number })._loopDepth;
    // 作废之后 loop 还在栈上（它挂在认不得 signal 的 await 上）；给补唤醒的微任务
    // 足够的机会落地——若 v44 漏了那道判定，这里就会起新一轮（`calls()` 增长）。
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls(), '作废轮仍然补唤醒了新轮——「结果未知」的上下文被顺手接了下去').toBe(before);

    // 决定性探针：手动叫一次「消息到达」，若此刻真有空闲可入，它会立刻再发一发。
    // 这同时钉住上面那条断言不是「微任务没轮到」的假绿。
    if (orphanDepth > 0) {
      await (agent as unknown as { _onMessageDelivered(): Promise<void> })._onMessageDelivered();
      expect(calls(), 'loop 还在栈上却有新轮进来（并发闸门失效）').toBe(before);
    }
    // 消息没被消费（留待下次）：ack 语义不变
    expect(bus.peekInbox(agentId).some((m) => m.payload === '作废之后才到的回件')).toBe(true);
  });

  it('⑥ 与 v43 记账的交互：作废只作废点名记录，账上不留幽灵', async () => {
    vi.useFakeTimers();
    setRunWatchdogThresholds(SHORT);
    const { agent, exec } = await harness(blackHoleProvider());

    const runA = exec.beginRun('turn');
    const settled = agent.run(runA.signal, '问一句').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SHORT.abandonMs + 5_000);
    await settled;

    // 作废后：账上无活记录（UI 回空闲）、runStateOf 同口径、旧句柄再收尾 = no-op
    expect(exec.isRunning).toBe(false);
    expect(exec.runState.running).toBe(false);
    expect(() => runA.end()).not.toThrow();

    // 后来起的新轮**不受牵连**（discardRuns 只认点名的那条）
    const runB = exec.beginRun('turn');
    expect(exec.isRunning).toBe(true);
    expect(runB.signal.aborted).toBe(false);
  });
});

describe('L3 停止语义升级 —— 停止要真解旋，不只是清账', () => {
  it('⑦ 用户停止后 loop 深度归零（幽灵轮的判据）', async () => {
    const { agent, exec } = await harness(blackHoleProvider());
    const run = exec.beginRun('turn');
    void agent.run(run.signal, '问一句').catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    expect(exec.isRunning).toBe(true); // 在跑（诚实）
    exec.stopAll();
    expect(exec.isRunning).toBe(false); // UI 回空闲（v43 逃生舱）

    // 真解旋（本雷的靶心）：那条 loop 必须离开栈 —— v43 之后它曾永留 `_loopDepth > 0`
    await vi.waitFor(() => {
      expect((agent as unknown as { _loopDepth: number })._loopDepth).toBe(0);
    });
  });
});
