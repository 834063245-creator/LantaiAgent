// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-broadcast — Agent 资产块 WO-5 判据：
//   applyAssetUpdateToExistingParts 原位替换（含 subagent）、PinSnapshot 保留资产元数据、
//   refreshPinnedAssetSnapshots 孤儿钉同刷、会话资产表可从消息重建、
//   renderEvent Asset 广播更新流内块 + 资产表 + pinned 孤儿。
// 协议：docs/plans/agent-asset-blocks.md §2.5/A7/§3（WO-5）。

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

import { type AgentEvent, EventKind } from '../src/agent/agent-types';
import { createBlock } from '../src/paper/block-model';
import { getAssetTableStore, rebuildAssetTableFromMessages, resetAssetTablesForTests } from '../src/state/asset-store';
import {
  blockFromSnapshot,
  getCanvasStore,
  refreshPinnedAssetSnapshots,
  resetCanvasStoresForTests,
  snapshotFromBlock,
} from '../src/state/canvas-store';
import { getSessionStore } from '../src/state/session-store';
import { msgStoreFor, msgStoreForActive } from '../src/ui/chat-store';
import type { StreamContext } from '../src/ui/chat-stream';
import { renderEvent } from '../src/ui/chat-stream';
import type { AssistantMessage, BlockPart, ChatMessage, MessageId, SubAgentPart } from '../src/ui/message-model';
import { applyAssetUpdateToExistingParts } from '../src/ui/part-mutator';

const STORE_ID = 'asset-broadcast-test';
const SESSION_A = 1;

let _streamingId: MessageId | null = null;
const _streamingIdBySession = new Map<number, MessageId | null>();

function blockPart(overrides: Partial<BlockPart> = {}): BlockPart {
  return {
    type: 'block',
    assetId: 'as_old',
    kind: 'chart',
    presentation: 'chart',
    title: 'q4',
    payload: { v: 1 },
    finalised: true,
    ...overrides,
  };
}

function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}

function makeCtx(sessionId: number | null = SESSION_A): StreamContext {
  getSessionStore(STORE_ID).setState({
    sessions: [{ id: SESSION_A, label: '会话 A' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
    msgIdSeq: 0,
  });
  msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
  return {
    storeId: STORE_ID,
    sessionId,
    getSessionMessages: (sid: number) => msgStoreFor(STORE_ID, sid).getState().messages,
    getActiveMessages: () => msgStoreForActive(STORE_ID)?.getState().messages ?? [],
    setSessionMessages: (sid: number, msgs: ChatMessage[]) => {
      msgStoreFor(STORE_ID, sid).getState().setMessages(msgs);
    },
    bumpSessionMessages: (sid: number) => {
      msgStoreFor(STORE_ID, sid).getState().bump();
    },
    getStreamingAssistantId: (() =>
      sessionId != null ? (_streamingIdBySession.get(sessionId) ?? null) : _streamingId) as () => MessageId | null,
    setStreamingAssistantId: ((id: MessageId | null) => {
      if (sessionId != null) _streamingIdBySession.set(sessionId, id);
      else _streamingId = id;
    }) as (id: MessageId | null) => void,
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
    _retractUserMessage: vi.fn(),
    retractTurn: () => null,
    sendMessage: vi.fn(),
    _updateTokens: vi.fn(),
    getProjectPath: () => '',
    getRunning: () => false,
    getAbortCtrl: () => null,
    setAbortCtrl: vi.fn(),
    getExpandedReasoning: () => new Set(),
  };
}

beforeEach(() => {
  _streamingId = null;
  _streamingIdBySession.clear();
  resetAssetTablesForTests();
  resetCanvasStoresForTests();
});

describe('part-mutator — applyAssetUpdateToExistingParts（WO-5）', () => {
  it('原位替换已存在 BlockPart：不 push、位置不变、kind 不变', () => {
    const parts: AssistantMessage['parts'] = [blockPart(), blockPart({ assetId: 'as_other', kind: 'metric' })];
    const changed = applyAssetUpdateToExistingParts(parts, {
      assetId: 'as_old',
      kind: 'chart',
      presentation: 'line',
      title: 'new title',
      payload: { v: 2 },
    });
    expect(changed).toBe(true);
    expect(parts).toHaveLength(2);
    const first = parts[0];
    expect(first.type).toBe('block');
    if (first.type === 'block') {
      expect(first.kind).toBe('chart');
      expect(first.presentation).toBe('line');
      expect(first.title).toBe('new title');
      expect(first.payload).toEqual({ v: 2 });
    }
    expect(parts[1]).toMatchObject({ type: 'block', assetId: 'as_other' });
  });

  it('递归更新 subagent 内嵌 BlockPart，且不新增父级块', () => {
    const nested = blockPart();
    const sub: SubAgentPart = {
      type: 'subagent',
      agentId: 'sub-1',
      description: '子代理',
      status: 'done',
      parts: [nested],
      version: 1,
    };
    const changed = applyAssetUpdateToExistingParts([sub], {
      assetId: 'as_old',
      kind: 'chart',
      presentation: 'line',
      payload: { v: 9 },
    });
    expect(changed).toBe(true);
    expect(sub.parts).toHaveLength(1);
    expect(sub.parts[0].type).toBe('block');
    if (sub.parts[0].type === 'block') expect(sub.parts[0].payload).toEqual({ v: 9 });
  });

  it('未知 assetId 返回 false，数组不变', () => {
    const parts: AssistantMessage['parts'] = [blockPart()];
    const changed = applyAssetUpdateToExistingParts(parts, {
      assetId: 'nope',
      kind: 'chart',
      payload: {},
    });
    expect(changed).toBe(false);
    expect(parts[0]).toMatchObject({ assetId: 'as_old' });
  });
});

describe('canvas-store — 资产 PinSnapshot 与孤儿钉刷新（WO-5）', () => {
  it('snapshotFromBlock / blockFromSnapshot 保留资产元数据与 payload', () => {
    const block = {
      ...createBlock('chart', { data: [1] }, { messageId: 'm1', part: null }),
      id: 'pb:m1:0',
      asset: { assetId: 'as_1', presentation: 'chart', title: 't', finalised: true },
    };
    const snap = snapshotFromBlock(block);
    expect(snap.kind).toBe('chart');
    expect(snap.asset?.assetId).toBe('as_1');
    expect(snap.asset?.payload).toEqual({ data: [1] });

    const rebuilt = blockFromSnapshot('pb:m1:0', {
      x: 10,
      y: 20,
      w: 720,
      source: { sessionId: 1, blockId: 'pb:m1:0' },
      snapshot: snap,
    });
    expect(rebuilt.kind).toBe('chart');
    expect(rebuilt.payload).toEqual({ data: [1] });
    expect(rebuilt.asset?.presentation).toBe('chart');
    expect(rebuilt.asset?.finalised).toBe(true);
  });

  it('refreshPinnedAssetSnapshots 刷新快照但坐标/钉住/source/kind 不动', () => {
    const st = getCanvasStore(STORE_ID).getState();
    st.setPin('pin1', {
      x: 100,
      y: -200,
      w: 720,
      source: { sessionId: 1, blockId: 'pb:m1:0' },
      snapshot: {
        kind: 'chart',
        asset: { assetId: 'as_old', presentation: 'chart', title: 'old', finalised: true, payload: { v: 1 } },
      },
    });
    refreshPinnedAssetSnapshots(STORE_ID, {
      assetId: 'as_old',
      presentation: 'line',
      title: 'new',
      payload: { v: 2 },
    });
    const pin = getCanvasStore(STORE_ID).getState().pins.pin1;
    expect(pin.x).toBe(100);
    expect(pin.y).toBe(-200);
    expect(pin.w).toBe(720);
    expect(pin.source).toEqual({ sessionId: 1, blockId: 'pb:m1:0' });
    expect(pin.snapshot.kind).toBe('chart');
    expect(pin.snapshot.asset?.presentation).toBe('line');
    expect(pin.snapshot.asset?.title).toBe('new');
    expect(pin.snapshot.asset?.payload).toEqual({ v: 2 });
  });

  it('refreshPinnedAssetSnapshots 刷新多个匹配钉且不碰无关钉', () => {
    const st = getCanvasStore(STORE_ID).getState();
    st.setPin('pin-a', {
      x: 1,
      y: 2,
      w: 720,
      snapshot: {
        kind: 'chart',
        asset: { assetId: 'as_old', presentation: 'chart', finalised: true, payload: { v: 1 } },
      },
    });
    st.setPin('pin-b', {
      x: 3,
      y: 4,
      w: 720,
      snapshot: {
        kind: 'chart',
        asset: { assetId: 'as_old', presentation: 'chart', finalised: true, payload: { v: 1 } },
      },
    });
    st.setPin('pin-other', {
      x: 5,
      y: 6,
      w: 720,
      snapshot: {
        kind: 'markdown',
        text: 'keep',
      },
    });
    refreshPinnedAssetSnapshots(STORE_ID, { assetId: 'as_old', presentation: 'line', payload: { v: 2 } });
    const pins = getCanvasStore(STORE_ID).getState().pins;
    expect(pins['pin-a'].snapshot.asset?.presentation).toBe('line');
    expect(pins['pin-a'].snapshot.asset?.payload).toEqual({ v: 2 });
    expect(pins['pin-b'].snapshot.asset?.presentation).toBe('line');
    expect(pins['pin-other'].snapshot).toEqual({ kind: 'markdown', text: 'keep' });
  });

  it('资产 payload 为字符串时快照/重建保真（append 型 table 流式占位）', () => {
    const block = {
      ...createBlock('table', 'partial', { messageId: 'm1', part: null }),
      id: 'pb:m1:0',
      asset: { assetId: 'as_t', presentation: 'grid', finalised: false },
    };
    const snap = snapshotFromBlock(block);
    expect(snap.asset?.payload).toBe('partial');
    const rebuilt = blockFromSnapshot('pb:m1:0', {
      x: 0,
      y: 0,
      w: 720,
      source: { sessionId: 1, blockId: 'pb:m1:0' },
      snapshot: snap,
    });
    expect(rebuilt.payload).toBe('partial');
    expect(rebuilt.asset?.finalised).toBe(false);
  });
});

describe('state/asset-store — 资产表重建与登记（WO-5）', () => {
  it('rebuildFromMessages 从顶层与 subagent 内 BlockPart 重建索引', () => {
    const messages: ChatMessage[] = [
      asstMsg('m1', [blockPart({ assetId: 'as_top', kind: 'chart', payload: { a: 1 } })]),
      asstMsg('m2', [
        {
          type: 'subagent',
          agentId: 'sub-1',
          description: 'd',
          status: 'done',
          parts: [blockPart({ assetId: 'as_sub', kind: 'metric', payload: { b: 2 } })],
          version: 1,
        },
      ]),
    ];
    rebuildAssetTableFromMessages(STORE_ID, SESSION_A, messages);
    const table = getAssetTableStore(`${STORE_ID}:${SESSION_A}`).getState();
    expect(table.get('as_top')?.payload).toEqual({ a: 1 });
    expect(table.get('as_sub')?.kind).toBe('metric');
    expect(table.get('as_sub')?.payload).toEqual({ b: 2 });
    expect(table.list()).toHaveLength(2);
  });

  it('upsert 覆盖旧记录（update 广播入口）', () => {
    const table = getAssetTableStore(`${STORE_ID}:${SESSION_A}`).getState();
    table.upsert({ assetId: 'as_1', kind: 'chart', presentation: 'chart', payload: { v: 1 } });
    table.upsert({ assetId: 'as_1', kind: 'chart', presentation: 'line', title: 'new', payload: { v: 2 } });
    const rec = table.get('as_1');
    expect(rec?.presentation).toBe('line');
    expect(rec?.payload).toEqual({ v: 2 });
    expect(rec?.title).toBe('new');
  });
});

describe('chat-stream — Asset 广播更新流内块 + 资产表 + pinned 孤儿（WO-5）', () => {
  it('update_asset 事件原位更新旧消息块、资产表、孤儿钉快照', () => {
    const ctx = makeCtx(SESSION_A);
    const msg = asstMsg('m1', [blockPart()]);
    msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([msg]);
    // 先有资产表记录（模拟该资产已存在）
    getAssetTableStore(`${STORE_ID}:${SESSION_A}`)
      .getState()
      .upsert({
        assetId: 'as_old',
        kind: 'chart',
        presentation: 'chart',
        payload: { v: 1 },
      });
    // 有一个孤儿钉引用该资产
    const st = getCanvasStore(STORE_ID).getState();
    st.setPin('pin-as', {
      x: 5,
      y: 6,
      w: 720,
      source: { sessionId: 1, blockId: 'pb:m1:0' },
      snapshot: {
        kind: 'chart',
        asset: { assetId: 'as_old', presentation: 'chart', title: 'old', finalised: true, payload: { v: 1 } },
      },
    });

    renderEvent(ctx, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_old', kind: 'chart', presentation: 'line', title: 'new', payload: { v: 2 } },
    } as AgentEvent);

    const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
    const bp = (msgs[0] as AssistantMessage).parts[0] as BlockPart;
    expect(bp.presentation).toBe('line');
    expect(bp.title).toBe('new');
    expect(bp.payload).toEqual({ v: 2 });
    // 只更新旧消息，不新增 part
    expect((msgs[0] as AssistantMessage).parts).toHaveLength(1);
    expect(msgs).toHaveLength(1);

    const rec = getAssetTableStore(`${STORE_ID}:${SESSION_A}`).getState().get('as_old');
    expect(rec?.presentation).toBe('line');
    expect(rec?.payload).toEqual({ v: 2 });

    const pin = getCanvasStore(STORE_ID).getState().pins['pin-as'];
    expect(pin.snapshot.asset?.presentation).toBe('line');
    expect(pin.snapshot.asset?.title).toBe('new');
    expect(pin.snapshot.asset?.payload).toEqual({ v: 2 });
    expect(pin.x).toBe(5);
    expect(pin.y).toBe(6);
  });

  it('orphan-only update：资产表有记录但消息无引用 → 不新增块、只刷孤儿钉', () => {
    const ctx = makeCtx(SESSION_A);
    msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
    getAssetTableStore(`${STORE_ID}:${SESSION_A}`)
      .getState()
      .upsert({ assetId: 'as_orphan', kind: 'chart', presentation: 'chart', payload: { v: 1 } });
    const st = getCanvasStore(STORE_ID).getState();
    st.setPin('pin-orphan', {
      x: 10,
      y: 20,
      w: 720,
      source: { sessionId: 1, blockId: 'pb:m1:0' },
      snapshot: {
        kind: 'chart',
        asset: { assetId: 'as_orphan', presentation: 'chart', title: 'old', finalised: true, payload: { v: 1 } },
      },
    });

    renderEvent(ctx, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_orphan', kind: 'chart', presentation: 'line', title: 'new', payload: { v: 2 } },
    } as AgentEvent);

    expect(msgStoreFor(STORE_ID, SESSION_A).getState().messages).toHaveLength(0);
    const pin = getCanvasStore(STORE_ID).getState().pins['pin-orphan'];
    expect(pin.snapshot.asset?.presentation).toBe('line');
    expect(pin.snapshot.asset?.payload).toEqual({ v: 2 });
  });

  it('update 递归刷新 subagent 内 BlockPart', () => {
    const ctx = makeCtx(SESSION_A);
    const nested = blockPart();
    const sub: SubAgentPart = {
      type: 'subagent',
      agentId: 'sub-1',
      description: '子代理',
      status: 'done',
      parts: [nested],
      version: 1,
    };
    const msg = asstMsg('m1', [sub]);
    msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([msg]);
    getAssetTableStore(`${STORE_ID}:${SESSION_A}`)
      .getState()
      .upsert({ assetId: 'as_old', kind: 'chart', presentation: 'chart', payload: { v: 1 } });

    renderEvent(ctx, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_old', kind: 'chart', presentation: 'line', payload: { v: 2 } },
    } as AgentEvent);

    const parts = (msgStoreFor(STORE_ID, SESSION_A).getState().messages[0] as AssistantMessage).parts;
    const bp = (parts[0] as SubAgentPart).parts[0] as BlockPart;
    expect(bp.presentation).toBe('line');
    expect(bp.payload).toEqual({ v: 2 });
  });

  it('全新 show_asset：无既有引用时仍 append 到流式助手', () => {
    const ctx = makeCtx(SESSION_A);
    msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
    renderEvent(ctx, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_new', kind: 'chart', presentation: 'chart', payload: { v: 1 } },
    } as AgentEvent);
    const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
    const assistant = msgs[0] as AssistantMessage;
    expect(assistant.parts).toHaveLength(1);
    expect(assistant.parts[0]).toMatchObject({ type: 'block', assetId: 'as_new' });
  });
});
