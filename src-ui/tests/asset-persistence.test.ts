// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-persistence — Agent 资产块 WO-7 判据：
//   会话重建时保留 BlockPart（资产块）；资产表从 UI 消息重建后可继续广播更新。
// 协议：docs/archive/agent-asset-blocks.md §2.5/§3（WO-7）。

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

import type { Message } from '../src/provider/types';
import { getAssetTableStore, resetAssetTablesForTests } from '../src/state/asset-store';
import { getSessionStore } from '../src/state/session-store';
import { rebuildMessagesFromMessages } from '../src/ui/chat-session';
import { msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, BlockPart, ChatMessage } from '../src/ui/message-model';

const STORE_ID = 'asset-persistence-test';
const SESSION_A = 1;

function blockPart(): BlockPart {
  return {
    type: 'block',
    assetId: 'as_restored',
    kind: 'chart',
    presentation: 'chart',
    title: 'q4',
    payload: { v: 1 },
    finalised: true,
  };
}

function providerAssistant(content: string): Message {
  return { role: 'assistant', content } as Message;
}

beforeEach(() => {
  getSessionStore(STORE_ID).setState({
    sessions: [{ id: SESSION_A, label: '会话 A' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
    msgIdSeq: 0,
  });
  msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
  resetAssetTablesForTests();
});

describe('WO-7 — 会话重建保留资产块', () => {
  it('rebuildMessagesFromMessages 从 UI 消息副本保留 BlockPart，并重建资产表', () => {
    const uiMessage: AssistantMessage = {
      role: 'assistant',
      _id: 'm_preserved',
      parts: [blockPart()],
      status: 'done',
      respondingTo: 'u1',
    };
    msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([uiMessage]);

    rebuildMessagesFromMessages([providerAssistant('普通正文')], STORE_ID, SESSION_A);

    const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages as ChatMessage[];
    const assistant = msgs.find((m): m is AssistantMessage => m.role === 'assistant');
    expect(assistant).toBeDefined();
    const parts = assistant?.parts ?? [];
    expect(parts.some((p) => p.type === 'text' && p.text === '普通正文')).toBe(true);
    const restored = parts.find((p): p is BlockPart => p.type === 'block' && p.assetId === 'as_restored');
    expect(restored).toBeDefined();
    expect(restored?.kind).toBe('chart');
    expect(restored?.payload).toEqual({ v: 1 });

    const table = getAssetTableStore(`${STORE_ID}:${SESSION_A}`).getState();
    expect(table.get('as_restored')?.kind).toBe('chart');
    expect(table.get('as_restored')?.payload).toEqual({ v: 1 });
  });

  it('无 UI 消息副本（旧存档）时退化为纯 provider 重建，不炸', () => {
    rebuildMessagesFromMessages([providerAssistant('旧存档')], STORE_ID, SESSION_A);
    const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages as ChatMessage[];
    const assistant = msgs.find((m): m is AssistantMessage => m.role === 'assistant');
    expect(assistant?.parts.some((p) => p.type === 'text' && p.text === '旧存档')).toBe(true);
    expect(assistant?.parts.some((p) => p.type === 'block')).toBe(false);
  });
});
