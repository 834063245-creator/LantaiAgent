// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 运行态单一权威源守卫 —— 「偶发：会话在跑着，运行态却丢了」（2026-09-17 诊断）。
//
// 不变式：**装配交给 Agent 的 exec 账本，必须就是 UI（注册表）读到的那个实例。**
// 此前三条装配路径（createNewSession / ensureSessionAgent / loadSessionFromDisk）
// 都在**工厂返回之后**往注册表塞了一个 `createExecState()` 新实例，而工厂
// （workspace.ts:920 `execState: chatPanel.getSessionExecState(sessionId)`）早已把
// **旧实例**交给了 Agent ⇒ 同卷两本账：Agent 一本、UI 一本。
//
// 后果只落在 **Agent 自起的轮次** 上——`_onMessageDelivered`（agent.ts:912
// `_execState.start()`）由总线投递唤醒：异步子 Agent 回件（subagent-spawn.ts:452
// `type:'result'`）/ 后台任务与延迟唤醒（workspace 的 `systemNotify('bg')`）/
// 通信族消息。这类轮次记在孤儿账本上：卷里事件照流、模型照跑，UI 却认为空闲
//（呼吸线不亮、书眉无「行卷中」、停止钮按不动——chat-core.abort() 读注册表实例，
// 因 `!isRunning` 直接 return）。UI 发起的轮次反而看不出问题，所以病象是「偶发」。
//
// 本文件走**真链路**：真 createNewSession/ensureSessionAgent + 真 AgentRuntime
// 句柄（含转发层）+ 真 Agent + 真 MessageBus 唤醒 → 只从注册表（UI 读法）断言。
// 转发层少接一跳（AgentHandleImpl 不转发 setExecState）本测试即红——同
// runtime-image-forward.test.ts 的 B3 事故形态。

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
import { agentSessionState } from '../src/agent/agent-session-state';
import { MessageBus } from '../src/agent/message-bus';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import { ToolRegistry } from '../src/agent/tool';
import { MeshTopology } from '../src/agent/topology';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import type { SessionContext } from '../src/ui/chat-session';
import { createNewSession, ensureSessionAgent, getSessionExecState, setAgentFactory } from '../src/ui/chat-session';
import { getChatStore } from '../src/ui/chat-store';

// ── 最小 SessionContext（同 composition-program-entry.test.ts：createNewSession 只用
//    storeId/getProjectPath + 这几个 UI 回调，其余能力位缺席 ⇒ 走降级分支）──

function makeCtx(storeId: string, projectPath = 'D:/wsExec'): SessionContext {
  return {
    storeId,
    getProjectPath: () => projectPath,
    flushReasoning: () => {},
    flushText: () => {},
    clearPendingToolCards: () => {},
    clearInputHistory: () => {},
    getTotalTokensUsed: () => 0,
    setTotalTokensUsed: () => {},
    setLastUsageText: () => {},
    updateFooter: () => {},
  } as unknown as SessionContext;
}

function resetPanel(storeId: string): void {
  agentSessionState.clearPanelState(storeId);
  getChatStore(storeId).sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
}

/** 跑一轮就结束的 provider。 */
function textProvider(text: string): Provider {
  return {
    name: () => 'mock',
    model: () => 'mock',
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        yield { type: ChunkType.Text, text };
        yield { type: ChunkType.Done };
      })(),
  };
}

/** 卡在闸门上的 provider —— 让「唤醒轮次在跑」这段窗口可断言；认 abort（停止钮要掐断它）。 */
function gatedProvider(text: string): { provider: Provider; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: Provider = {
    name: () => 'mock',
    model: () => 'mock',
    stream: (signal: AbortSignal) =>
      (async function* (): AsyncGenerator<Chunk> {
        await Promise.race([
          gate,
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
        if (signal.aborted) throw new Error('aborted');
        yield { type: ChunkType.Text, text };
        yield { type: ChunkType.Done };
      })(),
  };
  return { provider, release };
}

interface Assembly {
  sid: number;
  /** 真 Agent（句柄内部对象）——唤醒路径的被考对象。 */
  agent: Agent;
  bus: MessageBus;
}

/** 工厂替身：镜像 workspace 会话工厂（workspace.ts:903-920）——真 runtime 装配 +
 *  `execState: getSessionExecState(...)` 交接，并把总线接到该 Agent（真机由 runtime
 *  的会话服务物化完成）。返回值就是生产实现（AgentHandleImpl）。 */
function installWorkspaceLikeFactory(storeId: string, provider: Provider): Assembly[] {
  const assemblies: Assembly[] = [];
  setAgentFactory(storeId, async (sessionId: number) => {
    const runtime = new AgentRuntime();
    const handle = await runtime.createAgent({
      agentId: `main-${storeId}-${sessionId}`,
      parentId: null,
      projectPath: 'D:/wsExec',
      provider,
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
      eventSink: () => {},
      contextWindow: 8192,
      execState: getSessionExecState(storeId, sessionId),
    });
    const agent = (handle as unknown as { _getAgent(): Agent })._getAgent();
    const bus = new MessageBus();
    bus.setTopology(new MeshTopology());
    agent.setBus(bus);
    assemblies.push({ sid: sessionId, agent, bus });
    return handle as never;
  });
  return assemblies;
}

/** 投一条 inbox 消息 = 唤醒真入口（异步子 Agent 回件 / 后台任务 bg 同款）。 */
function wake(assembly: Assembly): void {
  assembly.bus.register({ agentId: `ghost-sub-${assembly.sid}`, parentId: null, depth: 0 });
  assembly.bus.send({
    from: `ghost-sub-${assembly.sid}`,
    to: assembly.agent.id,
    type: 'result',
    payload: '子 Agent 回件',
  });
}

/** 轮询到条件成立（条件一旦成立即返回，确定性）。 */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error('until(): 条件未在超时内成立');
}

describe('运行态单一权威源：装配账本 = UI 读到的账本', () => {
  it('① 唤醒轮次（总线回件）：Agent 在跑 ⇒ 注册表实例的运行态/停止句柄必须同真，且订阅面收到通知', async () => {
    const store = 'exec-authority-wake';
    resetPanel(store);
    const gate = gatedProvider('唤醒轮的产出');
    const assemblies = installWorkspaceLikeFactory(store, gate.provider);

    const sid = await createNewSession(makeCtx(store));
    expect(sid).not.toBeNull();
    if (sid === null) return;

    // UI 订阅面（呼吸线 / 书眉「行卷中」/ 停止钮同步刷新所依赖）
    const seenRunning: boolean[] = [];
    const unsubscribe = agentSessionState.subscribeExecAll(store, () => {
      seenRunning.push(agentSessionState.getExec(store, sid)?.isRunning === true);
    });
    const before = seenRunning.length;

    wake(assemblies[0]);
    await until(() => assemblies[0].agent.isRunning);

    // UI 全域同源读法：chat-core._activeExec / useRunningSessions / ComposerDock / TocStrip
    const uiExec = agentSessionState.getExec(store, sid);
    expect(uiExec?.isRunning).toBe(true);
    expect(uiExec?.abortSignal).toBeDefined();
    await until(() => seenRunning.length > before);
    expect(seenRunning.slice(before)).toContain(true);

    gate.release();
    await until(() => !assemblies[0].agent.isRunning);
    unsubscribe();
  });

  it('② 唤醒轮次的停止钮：UI 实例 stop() 必须真掐断这一轮（而非空按）', async () => {
    const store = 'exec-authority-stop';
    resetPanel(store);
    const gate = gatedProvider('不该跑完的产出');
    const assemblies = installWorkspaceLikeFactory(store, gate.provider);

    const sid = await createNewSession(makeCtx(store));
    expect(sid).not.toBeNull();
    if (sid === null) return;

    wake(assemblies[0]);
    await until(() => assemblies[0].agent.isRunning);

    // 用户按下停止钮 = chat-core.abort() → 注册表实例 stop()
    agentSessionState.getExec(store, sid)?.stop();

    await until(() => !assemblies[0].agent.isRunning);
    expect(agentSessionState.getExec(store, sid)?.isRunning).toBe(false);
  });

  it('③ 惰性补建路径（ensureSessionAgent）补建的句柄，其自起轮次同样被 UI 看见', async () => {
    const store = 'exec-authority-hydrate';
    resetPanel(store);
    const gate = gatedProvider('补建卷的产出');
    const assemblies = installWorkspaceLikeFactory(store, gate.provider);

    const sid = await createNewSession(makeCtx(store)); // 卷 1：首次装配
    expect(sid).not.toBeNull();
    if (sid === null) return;

    agentSessionState.removeAgent(store, sid); // 句柄缺席（惰性卷语义）
    await expect(ensureSessionAgent(makeCtx(store))).resolves.toBe(true); // 切到该卷/拟文 → 补建

    expect(assemblies).toHaveLength(2);
    wake(assemblies[1]);
    await until(() => assemblies[1].agent.isRunning);
    expect(agentSessionState.getExec(store, sid)?.isRunning).toBe(true);

    gate.release();
    await until(() => !assemblies[1].agent.isRunning);
  });

  it('④ 句柄转发层必接这一跳：AgentHandle.setExecState 必须到达 Agent（少接 = 静默退回孤儿账本）', async () => {
    const runtime = new AgentRuntime();
    const handle = await runtime.createAgent({
      agentId: 'main-forward',
      parentId: null,
      projectPath: '/fake/project',
      provider: textProvider('ok'),
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
    });
    const fresh = getSessionExecState('exec-authority-forward', 1);

    expect(typeof handle.setExecState).toBe('function');
    handle.setExecState(fresh);

    // 效应面：Agent 此后自起轮次记在 fresh 上（而非构造期那本）
    const agent = (handle as unknown as { _getAgent(): Agent })._getAgent();
    const bus = new MessageBus();
    bus.setTopology(new MeshTopology());
    agent.setBus(bus);
    wake({ sid: 1, agent, bus });
    await until(() => fresh.isRunning);
    expect(agent.isRunning).toBe(true);

    fresh.stop();
    await until(() => !agent.isRunning);
  });

  it('⑤ 账本随句柄：句柄仍在册时停账不得注销账本（注销 = 之后的自起轮次永久不可见）', async () => {
    const store = 'exec-authority-removeexec';
    resetPanel(store);
    const gate = gatedProvider('停账后又被唤醒的产出');
    const assemblies = installWorkspaceLikeFactory(store, gate.provider);

    const sid = await createNewSession(makeCtx(store));
    expect(sid).not.toBeNull();
    if (sid === null) return;

    // 后台卷停止钮曾直呼 removeExec（面板级 API）：句柄仍在册 —— 只该停账
    agentSessionState.removeExec(store, sid);
    const ledger = agentSessionState.getExec(store, sid);
    expect(ledger).not.toBeNull(); // 今日（病灶版）：条目被注销 → null
    expect(ledger?.isRunning).toBe(false); // 停账语义照常：在跑的轮次被停

    // 该卷随后被唤醒（子 Agent 回件 / 后台任务）：仍在册的账本必须看得见这一轮
    wake(assemblies[0]);
    await until(() => assemblies[0].agent.isRunning);
    expect(agentSessionState.getExec(store, sid)?.isRunning).toBe(true);

    gate.release();
    await until(() => !assemblies[0].agent.isRunning);

    // 句柄消亡 = 账本才真正注销（删除/合卷路径的清理由此接管）
    agentSessionState.removeAgent(store, sid);
    expect(agentSessionState.getExec(store, sid)).toBeNull();
  });
});
