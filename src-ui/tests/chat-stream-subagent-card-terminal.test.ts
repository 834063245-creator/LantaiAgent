// @vitest-environment happy-dom

// 子代理组内的工具卡必须随回合收尾一起终结（2026-11-20「工具卡片卡在运行态」批）。
//
// 病灶：`_finaliseStreamingAssistant` 收尾只扫顶层 `parts`，而子 Agent 的工具卡住在
// `SubAgentPart.parts` 里——子 Agent 被停/杀/挂死时它的执行器不会再发 ToolResult，
// 那张卡就永远停在「行 Ns」，父回合早已结束、没有任何人会来收。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '' }));
vi.mock('../src/ui/app-shell', () => ({ shell: { register: vi.fn() } }));
vi.mock('../src/agent/permission', () => ({}));
vi.mock('../src/agent/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  CHAT_MODES: [],
}));
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));
vi.mock('gsap', () => {
  const tween = () => ({ kill: vi.fn(), play: vi.fn(), pause: vi.fn() });
  return {
    default: {
      set: vi.fn(),
      to: vi.fn(tween),
      from: vi.fn(tween),
      fromTo: vi.fn(tween),
      killTweensOf: vi.fn(),
      isTweening: vi.fn(() => false),
      utils: { toArray: vi.fn(() => []) },
    },
    gsap: { set: vi.fn() },
  };
});

import type { AgentEvent } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';
import { getSessionStore } from '../src/state/session-store';
import { msgStoreFor, msgStoreForActive } from '../src/ui/chat-store';
import type { StreamContext } from '../src/ui/chat-stream';
import { finishTurn, renderEvent } from '../src/ui/chat-stream';
import type { AssistantMessage, MessageId, SubAgentPart } from '../src/ui/message-model';

const STORE_ID = 'test-subagent-card';
const SESSION_A = 1;
let _streamingId: MessageId | null = null;

function makeCtx(): StreamContext {
  getSessionStore(STORE_ID).setState({
    sessions: [{ id: SESSION_A, label: 'A' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
    msgIdSeq: 0,
  });
  msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
  return {
    storeId: STORE_ID,
    sessionId: SESSION_A,
    getSessionMessages: (sid) => msgStoreFor(STORE_ID, sid).getState().messages,
    getActiveMessages: () => msgStoreForActive(STORE_ID)?.getState().messages ?? [],
    setSessionMessages: (sid, msgs) => msgStoreFor(STORE_ID, sid).getState().setMessages(msgs),
    bumpSessionMessages: (sid) => msgStoreFor(STORE_ID, sid).getState().bump(),
    getStreamingAssistantId: () => _streamingId,
    setStreamingAssistantId: (id) => {
      _streamingId = id;
    },
    getUserScrolledUp: () => false,
    setUserScrolledUp: vi.fn(),
    getSyncRafId: () => null,
    setSyncRafId: vi.fn(),
    getTurnPairs: () => [],
    getAgent: () => null,
    setLastUsageText: vi.fn(),
    saveActiveSession: vi.fn(async () => {}),
    scheduleAutoSave: vi.fn(),
    bumpPillBadge: vi.fn(),
    animateBubbleIn: vi.fn() as never,
    setRunning: vi.fn(),
    abort: vi.fn(),
    _updateStatusBar: vi.fn(),
    _recordToolUsage: vi.fn(),
    sendMessage: vi.fn(async () => {}),
    _recordTokens: vi.fn(),
    getProjectPath: () => '',
    getRunning: () => false,
    getAbortCtrl: () => null,
    setAbortCtrl: vi.fn(),
    getExpandedReasoning: () => new Set(),
  } as unknown as StreamContext;
}

describe('子代理组内工具卡的终态', () => {
  beforeEach(() => {
    _streamingId = null;
  });

  it('子代理里发出的卡拿不到结果（子 Agent 被杀/挂死）⇒ 回合收尾时必须落终态', () => {
    const ctx = makeCtx();
    renderEvent(ctx, { kind: EventKind.TurnStarted } as AgentEvent);
    renderEvent(ctx, { kind: EventKind.Text, text: '派个子 Agent 看看' } as AgentEvent);

    // 父消息里挂一个子代理组（生产由 runtime-adapter 的 onSubAgentSpawn 挂）
    const sub: SubAgentPart = {
      type: 'subagent',
      agentId: 'sub-1',
      description: '检查依赖',
      status: 'running',
      parts: [],
      version: 0,
    };
    const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
    const assistant = msgs[msgs.length - 1] as AssistantMessage;
    assistant.parts.push(sub);

    // 子 Agent 里发了一次 fs 调用，结果永远没回来（子 Agent 被杀/挂起）
    sub.parts.push({
      type: 'tool',
      toolId: 'fs-sub-1',
      name: 'fs',
      args: '{"action":"read","path":"a.ts"}',
      label: 'fs',
      readOnly: true,
      status: 'running',
      startedAt: Date.now(),
    });

    // 子 Agent 收尾（失败/停止）——runtime-adapter 只改组头状态
    sub.status = 'error';
    finishTurn(ctx);

    const after = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
    const inner = [];
    for (const m of after) {
      if (m.role !== 'assistant') continue;
      for (const p of (m as AssistantMessage).parts) {
        if (p.type === 'subagent')
          for (const ip of p.parts) if (ip.type === 'tool') inner.push({ id: ip.toolId, status: ip.status });
      }
    }
    // 收尾后组内不再有「在跑」的卡（旧实现只扫顶层，这张卡永远不会被收）
    expect(inner.filter((c) => c.status === 'running' || c.status === 'pending')).toHaveLength(0);
  });
});
