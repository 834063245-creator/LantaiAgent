// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 夹签的**发送链**（docs/plans/card-quote-plan.md §5/§8/§9.2）：
//   · 发送前先把快照写到 {ws}/.lantai/refs/<refId>.json，摘要里给的是绝对路径；
//   · 正文在前、分隔行居中、引卡块在后（§5.1）；
//   · 写盘失败 ⇒ **不发送**、槽保留、toast 说清错误（§5.2/§8）；
//   · 发送成功 ⇒ 槽清空（§2.6）。
// 本环穿真实面：ChatCore.sendMessage → 真 Agent.run → 假 provider（只记录请求）。

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockRpc('rpc', ...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/app-shell', () => ({
  shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() },
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'test', apiKey: 'k', baseUrl: '', model: 'm', kind: 'openai' })),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => {
  const noop = () => ({ kill: vi.fn(), play: vi.fn(), pause: vi.fn() });
  return { default: { set: vi.fn(), to: vi.fn(noop), from: vi.fn(noop), fromTo: vi.fn(noop), killTweensOf: vi.fn() } };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import './helpers/kernel-registry';
import { installCompactionForTest } from './helpers/compaction-impl';

installCompactionForTest();

import { ToolRegistry } from '../src/agent/tool';
import { ChatCore } from '../src/app/chat/chat-core';
import { useShellStore } from '../src/app/shell-store';
import type { Chunk, Provider, Request } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { getAssetTableStore } from '../src/state/asset-store';
import { QUOTE_SECTION_SEPARATOR, type QuoteCard } from '../src/state/card-quote';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { useToastStore } from '../src/state/toast-store';
import { resetSessionListCacheForTests } from '../src/ui/chat-session';
import { getChatStore } from '../src/ui/chat-store';
import { createTestAgent } from './helpers/agent';

const PROJ = 'D:/ws-quote';

const CARD: QuoteCard = {
  refId: 'q-20261119-1052-a1b2',
  origin: 'session',
  assetId: 'as_abc',
  sourceSessionId: '1',
  kind: 'html',
  title: '示例标题',
  bytes: 32,
  at: '2026-11-19T02:52:13.000Z',
};

function recordingProvider(sink: Request[]): Provider {
  return {
    name: () => 'mock',
    model: () => 'mock',
    stream: (_signal: AbortSignal, req: Request) =>
      (async function* (): AsyncGenerator<Chunk> {
        sink.push(req);
        yield { type: ChunkType.Text, text: '收到。' };
        yield { type: ChunkType.Done } as Chunk;
      })(),
  };
}

function panelWith(prov: Provider): ChatCore {
  const panel = new ChatCore();
  panel.setProjectPath(PROJ);
  panel.setAgentFactory(
    async (sid: number) =>
      createTestAgent(prov, new ToolRegistry(), 'sys', {
        eventSink: panel.eventSinkFor(sid),
        contextWindow: 0,
      }) as unknown as never,
  );
  return panel;
}

/** 让假 provider 的异步流跑完（发送链里有 await 快照落盘，单次 Promise.resolve 不够）。 */
const flush = () => new Promise((r) => setTimeout(r, 50));

/** 本轮实际发给模型的 user 正文。 */
function lastUserText(req: Request | undefined): string {
  const msgs = req?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return msgs[i].content ?? '';
  }
  return '';
}

/** fs_cap write 的调用（RPC 面：mockRpc('fs_cap', {action:'write', file_path, content…})）。 */
function writes(): Array<{ file_path: string; content: string }> {
  return mockRpc.mock.calls
    .filter((c) => c[0] === 'fs_cap' && (c[1] as { action?: string })?.action === 'write')
    .map((c) => c[1] as { file_path: string; content: string });
}

beforeEach(() => {
  localStorage.clear();
  mockRpc.mockReset();
  // fs_cap write 的回执形状是 {path}（缺了会被契约层判成「出口漂移」并抛错）
  mockRpc.mockImplementation((method: string, params?: Record<string, unknown>) =>
    Promise.resolve(method === 'fs_cap' && params?.action === 'write' ? { path: params.file_path } : null),
  );
  useShellStore.setState({ projectPath: PROJ });
  useToastStore.setState({ toasts: [] });
  useDraftSheetStore.getState().dismissAll();
  resetSessionListCacheForTests();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('夹签发送链', () => {
  it('发送前落快照 + 摘要拼在正文之后 + 成功后槽清空', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    await panel.createNewSession();
    panel.renameSession(1, '引用夹具');
    // 资产表里有这张卡 → 快照能真取到 payload（不是降级）
    getAssetTableStore(`${panel.panelId}:1`)
      .getState()
      .upsert({
        assetId: 'as_abc',
        kind: 'html',
        presentation: 'html',
        title: '示例标题',
        payload: { code: '<b>x</b>' },
      } as never);
    getChatStore(panel.panelId).input.getState().setInputText('帮我改这张卡');
    getChatStore(panel.panelId).input.getState().addAttachedCard(CARD);

    await panel.sendMessage();
    await flush();

    // ① 快照落盘（绝对路径 + 内容可解析）
    const w = writes();
    expect(w.length, '引用没落快照').toBe(1);
    expect(w[0].file_path).toBe(`${PROJ}/.lantai/refs/q-20261119-1052-a1b2.json`);
    const snap = JSON.parse(w[0].content);
    expect(snap.origin).toEqual({ kind: 'session', assetId: 'as_abc', cardId: null, sessionId: '1' });
    expect(snap.card.payload).toEqual({ code: '<b>x</b>' });
    expect(snap.state).toBeNull();

    // ② 模型收到的正文 = 正文 → 分隔行 → 引卡块（路径与盘上一致）
    expect(reqs.length).toBeGreaterThan(0);
    const text = lastUserText(reqs[0]);
    expect(text.startsWith('帮我改这张卡')).toBe(true);
    expect(text).toContain(QUOTE_SECTION_SEPARATOR);
    expect(text.indexOf(QUOTE_SECTION_SEPARATOR)).toBeGreaterThan(text.indexOf('帮我改这张卡'));
    expect(text).toContain(`· 原文：${w[0].file_path}（用 fs read 取）`);
    expect(text).toContain('· 改本体：update_asset({"assetId":"as_abc"})');

    // ③ 发送成功 ⇒ 槽清空
    expect(getChatStore(panel.panelId).input.getState().attachedCards).toEqual([]);
  });

  it('只有夹签也能发（正文为空）', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    await panel.createNewSession();
    panel.renameSession(1, '纯引用夹具');
    getAssetTableStore(`${panel.panelId}:1`)
      .getState()
      .upsert({
        assetId: 'as_abc',
        kind: 'html',
        presentation: 'html',
        title: '示例标题',
        payload: { code: 'x' },
      } as never);
    getChatStore(panel.panelId).input.getState().addAttachedCard(CARD);

    await panel.sendMessage();
    await flush();

    expect(reqs.length, '只有夹签被判成「无内容」').toBeGreaterThan(0);
    expect(lastUserText(reqs[0])).toContain('〔引卡〕');
  });

  it('快照写盘失败 ⇒ 不发送、槽保留、错误可见', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    await panel.createNewSession();
    panel.renameSession(1, '写盘失败夹具');
    getAssetTableStore(`${panel.panelId}:1`)
      .getState()
      .upsert({
        assetId: 'as_abc',
        kind: 'html',
        presentation: 'html',
        title: '示例标题',
        payload: { code: 'x' },
      } as never);
    getChatStore(panel.panelId).input.getState().setInputText('帮我改这张卡');
    getChatStore(panel.panelId).input.getState().addAttachedCard(CARD);
    // fs_cap write 抛错（盘满 / 权限）
    mockRpc.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === 'fs_cap' && params?.action === 'write') return Promise.reject(new Error('磁盘已满'));
      return Promise.resolve(null);
    });

    await panel.sendMessage();
    await flush();

    expect(reqs, '快照没落成却把消息发出去了（模型会拿到一个不存在的路径）').toEqual([]);
    expect(getChatStore(panel.panelId).input.getState().attachedCards).toHaveLength(1);
    expect(getChatStore(panel.panelId).input.getState().inputText).toBe('帮我改这张卡');
    expect(
      useToastStore
        .getState()
        .toasts.map((t) => t.text)
        .join('\n'),
    ).toContain('引用快照写入失败');
  });

  it('取不到 payload（跨卷且源卷不在内存）⇒ 如实降级，不写假文件', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    await panel.createNewSession();
    panel.renameSession(1, '降级夹具');
    getChatStore(panel.panelId).input.getState().setInputText('这是什么');
    getChatStore(panel.panelId)
      .input.getState()
      .addAttachedCard({ ...CARD, sourceSessionId: '99', assetId: 'as_missing' });

    await panel.sendMessage();
    await flush();

    expect(writes(), '取不到内容却编了一份快照').toEqual([]);
    expect(reqs.length).toBeGreaterThan(0);
    expect(lastUserText(reqs[0])).toContain('未落快照（跨卷引用且未能取到内容）');
  });
});
