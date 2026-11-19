// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纯图/采集在途两族发送面（2026-11-19 用户真机报）：
//
//   ① 「只附上截图、不输入文字」发不出去——拟文是死键、回车零反应。
//      旧判据全链只看 `inputText.trim()`（按钮 / onSend / sendMessage / Agent.run），
//      飞书/微信式「甩一张图就发」在兰台不成立。
//   ② 「粘贴后立刻回车」——采集是 fire-and-forget（`void core.intakeImageFiles`），
//      写盘 + 规整还没落槽，发送面已经读了空快照 ⇒ 这一轮静默丢图，图留在附图道
//      等下一轮（用户读到的是「图没发给模型」）。
//
// 本环穿真实面：ChatCore.sendMessage → 真 Agent.run → 真 streamOnce →
// 假 provider（只负责记录请求）。imageReader 用假闭包（不经盘）。
//
// mock 面沿用 chat-send-liveness.test.ts。

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

/** 采集面替身：本节只考「发送是否等它」，不考规整/落盘（那是 image-intake 自己的测试）。 */
const intakeGate = vi.hoisted(() => ({ open: null as null | (() => void) }));
vi.mock('../src/app/chat/image-intake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/chat/image-intake')>();
  return {
    ...actual,
    admitImageBlob: vi.fn(async (_root: string, _blob: Blob, name?: string) => {
      await new Promise<void>((resolve) => {
        intakeGate.open = resolve;
      });
      return {
        id: 'img-race',
        mediaType: 'image/png' as const,
        bytes: 1024,
        width: 8,
        height: 8,
        ...(name ? { name } : {}),
      };
    }),
  };
});

import './helpers/kernel-registry';
import { installCompactionForTest } from './helpers/compaction-impl';

installCompactionForTest();

import { ToolRegistry } from '../src/agent/tool';
import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import type { ChatImageRef, Chunk, Provider, Request } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { useToastStore } from '../src/state/toast-store';
import { resetSessionListCacheForTests } from '../src/ui/chat-session';
import { getChatStore } from '../src/ui/chat-store';
import { createTestAgent } from './helpers/agent';

const PROJ = 'D:/ws-image-only';

const IMG: ChatImageRef = {
  id: 'img-1',
  mediaType: 'image/png',
  bytes: 2048,
  width: 16,
  height: 16,
  name: 'shot.png',
};

/** 假读取器：不经盘，任何 ref 都有字节（本节考发送面，不考读盘）。 */
const imageReader = async (ref: ChatImageRef) => ({ mediaType: 'image/png' as const, data: `b64-${ref.id}` });

/** 记录请求的 provider（正常应答一轮就结束）。 */
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
        imageReader,
      }) as unknown as never,
  );
  return panel;
}

/** 请求里的最后一条 user 消息（纯图轮 content 可以是空串）。 */
function lastUser(req: Request | undefined) {
  const msgs = req?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return msgs[i];
  }
  return undefined;
}

beforeEach(() => {
  localStorage.clear();
  mockRpc.mockReset();
  mockRpc.mockResolvedValue(null);
  useShellStore.setState({ projectPath: PROJ });
  useToastStore.setState({ toasts: [] });
  useDraftSheetStore.getState().dismissAll();
  intakeGate.open = null;
  resetSessionListCacheForTests();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('纯图发送面（无正文）', () => {
  it('只有附图、正文为空：图仍随本轮上路（content 可空，imageData 必在）', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    await panel.createNewSession();
    panel.renameSession(1, '纯图夹具');
    getChatStore(panel.panelId).input.getState().addAttachedImage(IMG);

    await panel.sendMessage();
    await Promise.resolve(); // 让事件流把请求吐完

    expect(reqs.length, '纯图被判为「无内容」，一个请求都没发出去').toBeGreaterThan(0);
    const user = lastUser(reqs[0]);
    expect(
      user?.images?.map((r) => r.id),
      '附图引用没挂进本轮 user 消息',
    ).toEqual(['img-1']);
    expect(Object.keys(reqs[0].imageData ?? {}), '附图字节没进请求载荷').toEqual(['img-1']);
    // 附图槽发送即消费（与带正文轮一致）——否则下一轮会重复带图
    expect(getChatStore(panel.panelId).input.getState().attachedImages).toEqual([]);
  });

  it('只有路径附件、正文为空：附件前缀照样上路', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    await panel.createNewSession();
    panel.renameSession(1, '附件夹具');
    getChatStore(panel.panelId)
      .input.getState()
      .addAttachedFile({ path: 'D:/ws-image-only/a.txt', name: 'a.txt', size: 0 });

    await panel.sendMessage();
    await Promise.resolve();

    expect(reqs.length, '纯附件被判为「无内容」，一个请求都没发出去').toBeGreaterThan(0);
    expect(lastUser(reqs[0])?.content ?? '', '附件路径没进正文前缀').toContain('a.txt');
  });

  it('守门：真的什么都没有（无正文/无附件/无附图）仍然不发请求', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    await panel.createNewSession();
    await panel.sendMessage();
    expect(reqs).toEqual([]);
  });
});

describe('采集在途（粘贴后立刻回车）', () => {
  it('发送面等采集落槽：这一轮就带上刚贴的图，不留到下一轮', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    await panel.createNewSession();
    panel.renameSession(1, '竞态夹具');

    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    void panel.intakeImageFiles([file]); // 采集在途（写盘/规整还没返回）
    await Promise.resolve();

    const sending = panel.sendMessage();
    // 采集此刻还没完成——旧实现会在这一步就把空快照发出去
    await Promise.resolve();
    intakeGate.open?.();
    await sending;

    expect(reqs.length, '这一轮根本没发出去').toBeGreaterThan(0);
    expect(reqs[0].imageData?.['img-race'], '在途采集的图被漏掉了（发送没等落槽）').toBeDefined();
  });
});

describe('题签（待题纸）纯图', () => {
  it('纸期只附截图就拟文：开卷 + 图随第一句上路（起卷不清桌面上的图）', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    useCoreStore.setState({ core: panel });
    useDraftSheetStore.getState().dismissAll();
    useDraftSheetStore.getState().openSheet(); // 落一张待题纸（焦点在纸上）
    getChatStore(panel.panelId).input.getState().addAttachedImage(IMG);

    await panel.sendMessage();
    await Promise.resolve();

    expect(reqs.length, '纸期纯图没发出去（拟文死键 or 开卷即丢图）').toBeGreaterThan(0);
    const user = lastUser(reqs[0]);
    expect(
      user?.images?.map((r) => r.id),
      '题签上附的图没随开卷那一轮上路',
    ).toEqual(['img-1']);
    expect(getChatStore(panel.panelId).sess.getState().sessions.length, '纸化成卷失败').toBe(1);
  });
});
