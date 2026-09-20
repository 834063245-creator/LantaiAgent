// 并发会话（多卷同跑）专项回归 — docs/plans/concurrent-sessions-plan.md
// 覆盖面：
//   1. 闸门拆除：hasRunningBackgroundSession 退役（模块导出面不再存在）
//   2. agentId → 卷归属注册表（权限卡/ask 路由依据）
//   3. ask-store 每会话队列（两卷同时提问互不覆盖）
//   4. turnPairs 按卷键控（两卷并发推对互不串）
//   5. autoTitleSessionIfDefault(sid) 后台卷跑完只命名自己

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '' }));
vi.mock('../src/ui/app-shell', () => ({ shell: { register: vi.fn() } }));
vi.mock('../src/agent/permission', () => ({}));
vi.mock('../src/agent/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  CHAT_MODES: [{ id: 'general', label: '閫氱敤', description: '', temperature: 0.7, maxSteps: 50 }],
}));
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { agentSessionState } from '../src/agent/agent-session-state';
import { createExecState } from '../src/agent/execution-state';
import { askSessionOf, pushAsk, useAskStore } from '../src/state/ask-store';
import { getSessionStore } from '../src/state/session-store';
import { autoTitleSessionIfDefault, getTurnPairs } from '../src/ui/chat-session';
import { msgStoreFor } from '../src/ui/chat-store';

const STORE_ID = 'conc-test';
const SESSION_A = 1;
const SESSION_B = 2;

function fakeHandle(id: string): { id: string; dispose: () => void } {
  return { id, dispose: () => {} };
}

describe('concurrent sessions — gate removal', () => {
  it('hasRunningBackgroundSession is retired from chat-session public surface', async () => {
    const mod = await import('../src/ui/chat-session');
    expect((mod as Record<string, unknown>).hasRunningBackgroundSession).toBeUndefined();
  });
});

describe('concurrent sessions — agentId → session registry', () => {
  beforeEach(() => {
    // clearPanelState 清光后在册条目
    agentSessionState.clearPanelState(STORE_ID);
  });

  it('setAgent registers agentId → (storeId, sessionId); removeAgent unregisters', () => {
    const h = fakeHandle('main-111-aaaa');
    agentSessionState.setAgent(STORE_ID, SESSION_A, h as never);
    expect(agentSessionState.sessionOfAgent('main-111-aaaa')).toEqual({
      storeId: STORE_ID,
      sessionId: SESSION_A,
    });

    agentSessionState.removeAgent(STORE_ID, SESSION_A);
    expect(agentSessionState.sessionOfAgent('main-111-aaaa')).toBeNull();
  });

  it('clearPanelState unregisters all agentIds of the panel', () => {
    const h1 = fakeHandle('main-1-a');
    const h2 = fakeHandle('main-2-b');
    agentSessionState.setAgent(STORE_ID, SESSION_A, h1 as never);
    agentSessionState.setAgent(STORE_ID, SESSION_B, h2 as never);
    agentSessionState.clearPanelState(STORE_ID);
    expect(agentSessionState.sessionOfAgent('main-1-a')).toBeNull();
    expect(agentSessionState.sessionOfAgent('main-2-b')).toBeNull();
  });
});

describe('concurrent sessions — per-session ask queue', () => {
  beforeEach(() => {
    useAskStore.setState({ pendingBySession: new Map(), seq: 0 });
    agentSessionState.clearPanelState(STORE_ID);
  });

  it('two sessions asking concurrently do not overwrite each other', () => {
    const hA = fakeHandle('main-1-a');
    const hB = fakeHandle('main-2-b');
    agentSessionState.setAgent(STORE_ID, SESSION_A, hA as never);
    agentSessionState.setAgent(STORE_ID, SESSION_B, hB as never);

    const cbA = vi.fn();
    const cbB = vi.fn();
    pushAsk({ id: 'ask-a', agentId: 'main-1-a', question: 'A?', callback: cbA });
    pushAsk({ id: 'ask-b', agentId: 'main-2-b', question: 'B?', callback: cbB });

    // 旧单坑：后者覆盖前者 → cbA 永挂。现在两坑并存。
    const a = useAskStore.getState().consumeAsk(SESSION_A);
    const b = useAskStore.getState().consumeAsk(SESSION_B);
    expect(a?.question).toBe('A?');
    expect(b?.question).toBe('B?');
    expect(cbA).not.toHaveBeenCalled();
    expect(cbB).not.toHaveBeenCalled();
  });

  it('consumeAnyAsk drains oldest-first across queues', () => {
    const hA = fakeHandle('main-1-a');
    const hB = fakeHandle('main-2-b');
    agentSessionState.setAgent(STORE_ID, SESSION_A, hA as never);
    agentSessionState.setAgent(STORE_ID, SESSION_B, hB as never);

    pushAsk({ id: 'ask-1', agentId: 'main-1-a', question: 'first', callback: () => {} });
    pushAsk({ id: 'ask-2', agentId: 'main-2-b', question: 'second', callback: () => {} });

    const first = useAskStore.getState().consumeAnyAsk();
    const second = useAskStore.getState().consumeAnyAsk();
    const none = useAskStore.getState().consumeAnyAsk();
    expect(first?.question).toBe('first');
    expect(second?.question).toBe('second');
    expect(none).toBeNull();
  });

  it('askSessionOf resolves via registry; unknown agentId → null', () => {
    const h = fakeHandle('main-9-z');
    agentSessionState.setAgent(STORE_ID, SESSION_B, h as never);
    expect(askSessionOf({ id: 'x', agentId: 'main-9-z', callback: () => {} })).toBe(SESSION_B);
    expect(askSessionOf({ id: 'x', agentId: 'sub-unknown', callback: () => {} })).toBeNull();
    expect(askSessionOf({ id: 'x', callback: () => {} })).toBeNull();
  });
});

describe('concurrent sessions — per-session turnPairs', () => {
  beforeEach(() => {
    agentSessionState.clearPanelState(STORE_ID);
    getSessionStore(STORE_ID).setState({
      sessions: [
        { id: SESSION_A, label: '案卷 1' },
        { id: SESSION_B, label: '案卷 2' },
      ],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 3,
      msgIdSeq: 0,
    });
  });

  it('two sessions pushing turn pairs stay isolated', () => {
    const tpA = getTurnPairs(STORE_ID, SESSION_A);
    const tpB = getTurnPairs(STORE_ID, SESSION_B);
    tpA.push({ userText: 'from A', uiMsgId: 'mA', userBubble: null, assistantBubble: null });
    tpB.push({ userText: 'from B', uiMsgId: 'mB', userBubble: null, assistantBubble: null });
    expect(tpA).toHaveLength(1);
    expect(tpB).toHaveLength(1);
    expect(tpA[0].userText).toBe('from A');
    expect(tpB[0].userText).toBe('from B');
    expect(getTurnPairs(STORE_ID, SESSION_A)).not.toBe(getTurnPairs(STORE_ID, SESSION_B));
  });

  it('default (no sid) resolves to active session pairs', () => {
    const tpActive = getTurnPairs(STORE_ID);
    tpActive.push({ userText: 'active', uiMsgId: 'm0', userBubble: null, assistantBubble: null });
    expect(getTurnPairs(STORE_ID, SESSION_A)).toHaveLength(1);
    expect(getTurnPairs(STORE_ID, SESSION_B)).toHaveLength(0);
  });
});

describe('concurrent sessions — autoTitle targets owning session', () => {
  beforeEach(() => {
    agentSessionState.clearPanelState(STORE_ID);
    getSessionStore(STORE_ID).setState({
      sessions: [
        { id: SESSION_A, label: '案卷 1' },
        { id: SESSION_B, label: '案卷 2' },
      ],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 3,
      msgIdSeq: 0,
    });
    msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
    msgStoreFor(STORE_ID, SESSION_B).getState().setMessages([]);
  });

  it('background session finishing renames itself, not the active session', () => {
    // B 卷（后台）有 Agent + 首条用户消息；A 卷（活跃）保持默认标签
    const hB = fakeHandle('main-2-b');
    agentSessionState.setAgent(STORE_ID, SESSION_B, {
      ...hB,
      getSession: () => [{ role: 'user', content: '后台卷的第一条消息标题' }],
    } as never);

    autoTitleSessionIfDefault(STORE_ID, SESSION_B);

    const st = getSessionStore(STORE_ID).getState();
    const labelA = st.sessions.find((s) => s.id === SESSION_A)?.label;
    const labelB = st.sessions.find((s) => s.id === SESSION_B)?.label;
    expect(labelA).toBe('案卷 1'); // 活跃卷未被误改
    expect(labelB).toBe('后台卷的第一条消息标题'); // 后台卷命名自己
  });
});

describe('concurrent sessions — permission card exec isolation', () => {
  it('stopping session A exec does not cancel cards enqueued on session B exec', async () => {
    const execA = createExecState();
    const execB = createExecState();

    let resolveB: (r: { allow: boolean; remember: boolean }) => void = () => {};
    const cardB = execB.enqueuePerm(
      () =>
        new Promise<{ allow: boolean; remember: boolean }>((resolve) => {
          resolveB = resolve;
        }),
    );

    // 停 A 卷（A 的权限卡应被否决；B 的卡不受影响）
    execA.stopAll();

    const settled = await Promise.race([
      cardB.then((r) => ({ state: 'resolved', r })),
      new Promise<{ state: 'pending' }>((resolve) => setTimeout(() => resolve({ state: 'pending' }), 50)),
    ]);
    expect(settled.state).toBe('pending'); // B 的卡仍挂着——未被 A 的停止错杀

    resolveB({ allow: true, remember: false });
    await expect(cardB).resolves.toEqual({ allow: true, remember: false });
  });
});
