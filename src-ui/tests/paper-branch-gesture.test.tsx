// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话树「枝」的**空间手势立枝**守护（P4-①，2026-09-19）——立项件
// `docs/plans/session-tree-plan.md` §5 / §12.8。用户操作序列驱动，挂**真 PaperPanel**
// 穿全层（harness 同 paper-viewport-ux / session-tree-canvas），立枝走**真盘**：
//   ① 按住块上的「枝」握把拖动 ⇒ 纸上出现一丝引线预览（朱点 = 指针 = 落点）；
//   ② 松手落在纸上 ⇒ 真枝卷落盘（头行血缘）+ **在该落点落位** + 视角飞过去；
//   ③ 拖动中 Esc / 松手落回原块 / 松手落在纸外 ⇒ 取消（不立卷、不留定位请求）。
// 入口是**加法**：动作行里的「立枝」照旧（守护 = tests/paper-block-branch-op.test.tsx）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logText } from './helpers/session-files';

const { layoutMock, richStatsMock } = vi.hoisted(() => ({
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
  richStatsMock: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _mock: true })),
  walkLineRanges: vi.fn((_prepared: unknown, _width: number, cb: (l: unknown) => void) => {
    cb({ start: 0, end: 1, width: 100 });
  }),
  materializeLineRange: vi.fn(() => ({ width: 100, text: '行文缩微' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: richStatsMock,
}));

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/bridge', () => ({
  invoke: vi.fn(async () => null),
  rpc: vi.fn(async () => '{}'),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/settings')>();
  return {
    ...actual,
    loadSettings: () => ({ display: { language: 'zh', fontScale: 1 }, agent: {}, providers: [] }),
    getActiveProvider: () => ({ name: 'none', kind: 'openai', apiKey: '' }),
    modelContextWindow: () => 8192,
    providerId: (name: string) => name,
    saveSettings: vi.fn(),
    restoreSecrets: (s: unknown) => s,
    persistSecrets: vi.fn(),
  };
});
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/app-shell', () => ({
  shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() },
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));

// jsdom 无 Canvas 2D（InkLayer rAF 循环要跑）——假 ctx（同 session-tree-canvas）
class Fake2dCtx {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textBaseline = '';
  textAlign = '';
  globalAlpha = 1;
  setTransform(): void {}
  clearRect(): void {}
  fillRect(): void {}
  fillText(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
  strokeRect(): void {}
  closePath(): void {}
}
HTMLCanvasElement.prototype.getContext = function fakeGetContext() {
  return new Fake2dCtx();
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

import { agentSessionState } from '../src/agent/agent-session-state';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import { ToolRegistry } from '../src/agent/tool';
import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { flushSessionLog } from '../src/app/chat/session-log-store';
import { useShellStore } from '../src/app/shell-store';
import { SessionPersistenceService } from '../src/composition/session-persistence-service';
import { SpaceService } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { worldToScreen } from '../src/paper/canvas-math';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { builtinSessionsPlugin } from '../src/plugins/builtin/sessions-builtin';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { getCanvasStore, resetCanvasStoresForTests } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import * as Session from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

{
  // seam 装配：builtin provider 在册（卷写面经 sessionExecute 单点——与生产同链）
  const root = new Context();
  new SessionPersistenceService(root);
  await root.plugin(builtinSessionsPlugin);
}

// 触发 rpc-contract 的 vi.mock 工厂求值（同 session-branch.test.ts 注）
import { kernelReadFileRaw } from '../src/rpc-contract';

void kernelReadFileRaw;

const WS = 'D:/wsBranchGesture';
const SESSIONS = `${WS}/.lantai/sessions`;
const sys = { role: 'system', content: 'sys' };
const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });

/** 落点（画布内屏幕坐标）：纸面右侧空地——与卷 1（中轴 0、宽 720）不重叠，
 *  故按 `pickDropAnchor` 语义「落哪算哪」。 */
const DROP = { x: 1060, y: 300 };
/** 假块高（pretext 桩给 36）：只用于把块矩形换算成屏幕矩形（回槽取消判据的参照）。 */
const BLOCK_H = 36;

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

describe('会话树「枝」——空间手势立枝（P4-①：拖出引线、松手落在纸上就地立枝）', () => {
  let panel: ChatCore;
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    const fs = H.kernelFs?.fs;
    if (fs) {
      fs.files.clear();
      fs.dirs.clear();
      fs.writes.length = 0;
      fs.fail = {};
    }
    Session.resetSessionListCacheForTests();
    resetCanvasStoresForTests();
    useCanvasViewStore.getState().requestFocus(null);
    useDockStore.getState().closePanel('paper');
    useCanvasViewStore.setState({
      view: { panX: 0, panY: 0, zoom: 1 },
      canvasSize: { w: 800, h: 600 },
      restoredView: null,
      pendingFocusId: null,
    });
  });

  afterEach(async () => {
    // 写后队列排空（200ms 窗口）：不排空的话在途 adopt 会漏进下一个用例的盘面
    // （mock fs 每文件共用一份实例——本文件 beforeEach 清盘）
    const store = panel?.panelId;
    if (store) {
      for (const s of getChatStore(store).sess.getState().sessions) {
        try {
          await flushSessionLog(agentSessionState.getAgent(store, s.id)?.sessionLog ?? null);
        } catch {
          /* 排空失败不影响断言面（本用例已断完） */
        }
      }
    }
    if (root) {
      void act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.restoreAllMocks();
  });

  function volumeText(sid: number): string | undefined {
    return H.kernelFs?.fs.files.get(`${SESSIONS}/${sid}.ndjson`);
  }

  /** 挂真 PaperPanel：真卷（卷 1 在盘上）+ 真句柄 + 空间服务在册（生产装配面）。 */
  async function mount(): Promise<HTMLDivElement> {
    new SpaceService(new Context());
    panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const store = panel.panelId;
    Session.setAgentFactory(store, async (sessionId: number) => {
      const runtime = new AgentRuntime();
      return (await runtime.createAgent({
        agentId: `main-${store}-${sessionId}`,
        parentId: null,
        projectPath: WS,
        provider: textProvider('枝上的第一句'),
        tools: new ToolRegistry(),
        systemPrompt: 'sys',
        eventSink: () => {},
        contextWindow: 8192,
        execState: Session.getSessionExecState(store, sessionId),
      })) as never;
    });
    useShellStore.setState({ projectPath: WS });
    H.kernelFs?.fs.setFile(`${SESSIONS}/1.ndjson`, logText(1, [sys, user('一'), assistant('二')]));
    expect(await panel.loadSessionFromDisk(WS, 1)).toBe(true);

    // 视口：卷 1 在左（世界中轴 0），纸面右侧留出空地给落点；zoom .6 仍在文字档（>LOD_ENTER）
    const canvasStore = getCanvasStore(store).getState();
    canvasStore.setRegion('1', { anchorX: 0, anchorY: 0, width: 720 });
    const view = useCanvasViewStore.getState();
    view.setCanvasSize(1200, 800);
    view.restoreView({ zoom: 0.6, panX: 100, panY: 500 });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
    await act(async () => {
      view.setCanvasSize(1200, 800);
    });
    await act(async () => {
      view.setView((v) => ({ ...v, zoom: 0.6, panX: 100, panY: 500 }));
    });
    const el = container.querySelector<HTMLDivElement>('.pp-canvas');
    if (!el) throw new Error('pp-canvas 未挂载');
    el.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 1200,
        bottom: 800,
        width: 1200,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    return el;
  }

  /** 某消息的流块（世界矩形读自渲染面：transform + 宽度）。 */
  function flowBlock(messageId: string): { el: HTMLElement; x: number; y: number; w: number } {
    const el = container?.querySelector<HTMLElement>(`.pp-block[data-message-id="${messageId}"]`);
    if (!el) throw new Error(`块不在渲染面：${messageId}`);
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform);
    if (!m) throw new Error('块位读不出来');
    return { el, x: Number(m[1]), y: Number(m[2]), w: Number.parseFloat(el.style.width) };
  }

  /** 把块矩形的**屏幕**矩形桩上（jsdom 无布局）：回槽取消判据的参照 + 握把坐标换算。 */
  function stubBlockRect(messageId: string): { left: number; top: number; right: number; bottom: number } {
    const b = flowBlock(messageId);
    const v = useCanvasViewStore.getState().view;
    const at = worldToScreen(v, b.x, b.y);
    const rect = {
      left: at.x,
      top: at.y,
      right: at.x + b.w * v.zoom,
      bottom: at.y + BLOCK_H * v.zoom,
    };
    b.el.getBoundingClientRect = () =>
      ({
        ...rect,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      }) as DOMRect;
    return rect;
  }

  function gripEl(messageId: string): HTMLElement {
    const el = container?.querySelector<HTMLElement>(`.pp-block[data-message-id="${messageId}"] .pp-branch-grip`);
    if (!el) throw new Error(`握把不在渲染面：${messageId}`);
    return el;
  }

  const fire = (el: Element | Window, type: string, init: MouseEventInit & { button?: number }): void => {
    (el === window ? window : el).dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  };

  /** 按下握把 + 拖到落点（手势两步，各自包 act——React 事件外的状态更新会告警）。 */
  async function dragGrip(messageId: string, to: { x: number; y: number }): Promise<void> {
    const rect = stubBlockRect(messageId);
    const grip = gripEl(messageId);
    await act(async () => {
      fire(grip, 'mousedown', { button: 0, clientX: rect.right - 20, clientY: rect.bottom + 8 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: to.x, clientY: to.y });
    });
  }

  /** 松手（落在 target 上）+ 让异步立枝跑完。 */
  async function releaseOn(target: Element, at: { x: number; y: number }): Promise<void> {
    await act(async () => {
      fire(target, 'mouseup', { clientX: at.x, clientY: at.y });
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it('按住握把拖动 ⇒ 引线预览（朱点在指针上）；松手落在纸上 ⇒ 枝卷落盘、在该落点落位、视角飞过去', async () => {
    const canvas = await mount();
    const store = panel.panelId;
    const ui = msgStoreFor(store, 1).getState().messages;
    const uiUser = ui.find((m) => m.role === 'user');
    expect(uiUser).toBeDefined();
    if (!uiUser) return;
    // 基线在**父卷写后队列排空之后**取（开卷自带的 adopt 是开卷的账，不是立枝的）
    await flushSessionLog(agentSessionState.getAgent(store, 1)?.sessionLog ?? null);
    const parentBefore = volumeText(1);

    // 握把在**动作行行内**（2026-09-20 造型批）：旧形态是块右端一枚独立「枝」方框
    // ——一个动作两个词、两处落位；并进行盒后只剩六点握把（`::before` 画的点，无字），
    // 语义落在 title 上，键盘路径照旧是行内那颗「立枝」按钮。
    const grip = gripEl(uiUser._id);
    expect(grip.parentElement?.className).toBe('pp-msg-ops');
    expect(grip.textContent).toBe('');
    expect(grip.title).toContain('立枝');

    // ① 按下 → 拖动（过阈值）⇒ 纸上出现引线预览，朱点落在**指针**上（落点即所见）
    await dragGrip(uiUser._id, DROP);
    const preview = container?.querySelector('.pp-branch-drag-layer');
    expect(preview).not.toBeNull();
    const bead = preview?.querySelector('.pp-tether-bead');
    expect(Number(bead?.getAttribute('cx'))).toBeCloseTo(DROP.x, 6);
    expect(Number(bead?.getAttribute('cy'))).toBeCloseTo(DROP.y, 6);

    // ② 松手落在纸上 ⇒ 立枝（走真盘：头行血缘 + 摊开 + 落位 + 定位）
    await releaseOn(canvas, DROP);
    // 预览随手势收场（不留在纸上）
    expect(container?.querySelector('.pp-branch-drag-layer')).toBeNull();

    const lines = (volumeText(2) ?? '').split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    expect((JSON.parse(lines[0] ?? '{}') as { parent?: unknown }).parent).toEqual({ id: 1, atSeq: 2 });
    expect(
      getChatStore(store)
        .sess.getState()
        .sessions.map((s) => s.id),
    ).toContain(2);
    expect(volumeText(1)).toBe(parentBefore); // 父卷一个字节未动

    // ③ **在该落点落位**：世界坐标 = 屏幕落点换算（zoom .6 / pan 100,500）——
    //    与卷 1 不重叠 ⇒ 落哪算哪（1440 宽的新流区中轴 = 落点世界 x）
    const region = getCanvasStore(store).getState().spread['2'];
    expect(region?.anchorX).toBeCloseTo(1600, 6);
    expect(region?.anchorY).toBeCloseTo(-1000 / 3, 6);

    // ④ 视角飞过去（expand 是「摊开 + 定位」单一权威入口）：飞行落定后视口中心 = 新卷中轴
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    const after = useCanvasViewStore.getState().view;
    expect(after.panX).toBeCloseTo(600 - 1600 * 0.6, 3);
    expect(after.panY).toBeCloseTo(400 - (-1000 / 3) * 0.6, 3);
  }, 30_000);

  it('拖动中 Esc ⇒ 取消（预览收场、不立卷、不留定位请求）', async () => {
    await mount();
    const store = panel.panelId;
    const ui = msgStoreFor(store, 1).getState().messages;
    const uiUser = ui.find((m) => m.role === 'user');
    if (!uiUser) return;

    await dragGrip(uiUser._id, DROP);
    expect(container?.querySelector('.pp-branch-drag-layer')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container?.querySelector('.pp-branch-drag-layer')).toBeNull();
    // 手势已收：此后的 mouseup 不再立枝
    await releaseOn(document.body, DROP);
    expect(volumeText(2)).toBeUndefined();
    expect(useCanvasViewStore.getState().pendingFocusId).toBeNull();
  }, 30_000);

  it('松手落回原块 ⇒ 取消（不立卷）', async () => {
    await mount();
    const store = panel.panelId;
    const ui = msgStoreFor(store, 1).getState().messages;
    const uiUser = ui.find((m) => m.role === 'user');
    if (!uiUser) return;
    const canvas = container?.querySelector('.pp-canvas') as Element;

    await dragGrip(uiUser._id, DROP); // 先拖出去（过阈值）
    const rect = stubBlockRect(uiUser._id); // 再拖回来：落点 = 原块矩形内
    await releaseOn(canvas, { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 });
    expect(volumeText(2)).toBeUndefined();
    expect(useCanvasViewStore.getState().pendingFocusId).toBeNull();
  }, 30_000);

  it('松手落在纸外（坞/侧栏一侧）⇒ 取消（不立卷）', async () => {
    await mount();
    const store = panel.panelId;
    const ui = msgStoreFor(store, 1).getState().messages;
    const uiUser = ui.find((m) => m.role === 'user');
    if (!uiUser) return;

    await dragGrip(uiUser._id, DROP);
    // 纸外元素（不在 .pp-canvas 子树里）——与书脊拖行「松手落回本栏 = 中止」同族
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    await releaseOn(outside, DROP);
    outside.remove();
    expect(volumeText(2)).toBeUndefined();
    expect(useCanvasViewStore.getState().pendingFocusId).toBeNull();
  }, 30_000);
});
