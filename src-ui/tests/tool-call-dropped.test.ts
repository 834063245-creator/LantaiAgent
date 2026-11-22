// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 作废尝试的半成卡在**展示面**必须消失（2026-11-22 卷 165「code_execution 无由来的重复调用」）。
//
// 三张空 code_execution 卡不是「失败的调用」——参数一个字节都没到，它们从未成为一次真调用。
// 展示面的正确终态是**删掉**，不是标 error；标 error 会随卷落盘，重载后还在（165 卷实测）。
// 本文件钉 part-mutator 的删卡语义 + chat-stream 的路由（事件真的接进了 UI 管道）。

// @vitest-environment happy-dom

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
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
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
import { renderEvent } from '../src/ui/chat-stream';
import type { AssistantMessage, AssistantPart, ChatMessage, MessageId } from '../src/ui/message-model';
import { applyEventToParts } from '../src/ui/part-mutator';

const STORE_ID = 'test-tool-call-dropped';
const SESSION_A = 1;

let _streamingId: MessageId | null = null;
let _streamingTargetSid: number | null = null;

function makeCtx(): StreamContext {
  getSessionStore(STORE_ID).setState({
    sessions: [{ id: SESSION_A, label: '卷 A' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
    msgIdSeq: 0,
  });
  msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
  return {
    storeId: STORE_ID,
    getSessionMessages: (sid: number) => msgStoreFor(STORE_ID, sid).getState().messages,
    getActiveMessages: () => msgStoreForActive(STORE_ID)?.getState().messages ?? [],
    setSessionMessages: (sid: number, msgs: ChatMessage[]) => {
      msgStoreFor(STORE_ID, sid).getState().setMessages(msgs);
    },
    bumpSessionMessages: (sid: number) => {
      msgStoreFor(STORE_ID, sid).getState().bump();
    },
    getStreamingAssistantId: (() => _streamingId) as () => MessageId | null,
    setStreamingAssistantId: ((id: MessageId | null) => {
      _streamingId = id;
    }) as (id: MessageId | null) => void,
    getStreamingTargetSid: () => _streamingTargetSid,
    setStreamingTargetSid: (sid: number | null) => {
      _streamingTargetSid = sid;
    },
    getUserScrolledUp: () => false,
    setUserScrolledUp: vi.fn(),
    getSyncRafId: () => null,
    setSyncRafId: vi.fn(),
    getTurnPairs: () => [],
    getAgent: () => null,
    getStarGraph: () => null,
    updateFooter: vi.fn(),
    setLastUsageText: vi.fn(),
    addNotice: vi.fn(),
    saveActiveSession: vi.fn(),
    scheduleAutoSave: vi.fn(),
    bumpPillBadge: vi.fn(),
    animateBubbleIn: vi.fn(),
    setRunning: vi.fn(),
    abort: vi.fn(),
    _updateStatusBar: vi.fn(),
    _recordToolUsage: vi.fn(),
    sendMessage: vi.fn(),
    _updateTokens: vi.fn(),
    getProjectPath: () => '',
    getRunning: () => false,
    getAbortCtrl: () => null,
    setAbortCtrl: vi.fn(),
    getExpandedReasoning: () => new Set(),
  };
}

function assistantMsg(): AssistantMessage {
  const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
  return msgs[msgs.length - 1] as AssistantMessage;
}

function dispatchEvent(id: string, partial: boolean): AgentEvent {
  return {
    kind: EventKind.ToolDispatch,
    tool: { id, name: 'code_execution', args: partial ? '' : '{"code":"x"}', read_only: false, partial },
  } as AgentEvent;
}

function droppedEvent(id: string): AgentEvent {
  return {
    kind: EventKind.ToolCallDropped,
    tool: { id, name: 'code_execution', read_only: false },
  } as AgentEvent;
}

describe('part-mutator — ToolCallDropped 删卡', () => {
  it('删掉指定 toolId 的卡，其它卡原样保留', () => {
    const parts: AssistantPart[] = [];
    applyEventToParts(parts, dispatchEvent('ghost', true));
    applyEventToParts(parts, dispatchEvent('real', false));
    expect(parts.filter((p) => p.type === 'tool')).toHaveLength(2);

    expect(applyEventToParts(parts, droppedEvent('ghost'))).toBe(true);
    expect(parts.filter((p) => p.type === 'tool').map((p) => (p.type === 'tool' ? p.toolId : null))).toEqual(['real']);
  });

  it('幂等：重复撤同一张（或撤不存在的）不影响任何卡', () => {
    const parts: AssistantPart[] = [];
    applyEventToParts(parts, dispatchEvent('real', false));
    expect(applyEventToParts(parts, droppedEvent('ghost'))).toBe(false);
    expect(applyEventToParts(parts, droppedEvent('real'))).toBe(true);
    expect(applyEventToParts(parts, droppedEvent('real'))).toBe(false);
    expect(parts).toHaveLength(0);
  });
});

describe('chat-stream — 作废尝试的半成卡从消息里消失（卷 165 复盘）', () => {
  beforeEach(() => {
    _streamingId = null;
    _streamingTargetSid = null;
  });

  it('ToolCallStart 建的 pending 卡收到 ToolCallDropped 后消失，后续真卡不受影响', () => {
    const ctx = makeCtx();
    _streamingTargetSid = SESSION_A;

    // 断流尝试 1：只到 ToolCallStart（参数空）→ 一张 pending 卡
    renderEvent(ctx, dispatchEvent('ghost-1', true));
    expect(assistantMsg().parts.filter((p) => p.type === 'tool')).toHaveLength(1);

    // 重试同样断流：第二张 pending 卡
    renderEvent(ctx, dispatchEvent('ghost-2', true));
    expect(assistantMsg().parts.filter((p) => p.type === 'tool')).toHaveLength(2);

    // 两次作废 → 两张都消失（旧行为：留到回合收尾标 error 并随卷落盘）
    renderEvent(ctx, droppedEvent('ghost-1'));
    renderEvent(ctx, droppedEvent('ghost-2'));
    expect(assistantMsg().parts.filter((p) => p.type === 'tool')).toHaveLength(0);

    // 真实调用照旧落卡、照旧跑完
    renderEvent(ctx, dispatchEvent('call-real', false));
    renderEvent(ctx, {
      kind: EventKind.ToolResult,
      tool: { id: 'call-real', name: 'code_execution', output: 'ok', read_only: false },
    } as AgentEvent);
    const tools = assistantMsg().parts.filter((p) => p.type === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolId: 'call-real', status: 'done' });
  });
});
