// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 远景三档行为考官（P4c，2026-09-06 用户拍板「奔效果最好的方向」）——挂真实
// PaperPanel 穿全层，钉三件事：
//   ① DOM 面：接管阈（0.36）之上流块与卷首头照常渲染，之下双双退场
//      （卷名由 canvas 地志标签接管）；
//   ② 绘制通道：行影档画行影墨条（fillRect），fillText 只剩地志标签；
//   ③ 迟滞带：0.36-0.39 之间往返不闪档（DOM 不抖）。
// 2026-09-20：接管阈自 0.55 下移到行影档边界 0.36（用户拍板）——可读区留给
// DOM，切轨只发生在「本来就读不清」的地方。
// harness 时序纪律同 paper-regionsref-wiring：jsdom clientWidth=0 的 RO
// 直写须覆盖 + 预置 restoreView 掐掉挂载期视角飞行（见该文件注释）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

// jsdom 无 Canvas 2D → 可数假 ctx：fillText = 文字档通道信号，fillRect =
// 行影/剪影档通道信号（折叠桩条与剪影签边都走 fillRect）。
// fillText 的字体签名集用于通道判别：行影档只有地志标签（700 粗宋体栈），
// 文字档混有块文字栈——比计数更精确（标签每帧一次，计数会跨帧累计）。
const inkStats = { fillText: 0, fillRect: 0 };
const inkFonts = new Set<string>();
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
  /** 基线半行距探针（InkLayer halfLeading 用 measureText 读字体正常行高）。 */
  measureText(): { width: number; fontBoundingBoxAscent: number; fontBoundingBoxDescent: number } {
    return { width: 100, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 5 };
  }
  fillRect(): void {
    inkStats.fillRect++;
  }
  fillText(): void {
    inkStats.fillText++;
    inkFonts.add(this.font);
  }
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

// jsdom 无 ResizeObserver（PaperPanel 挂载即炸）——no-op 桩（尺寸由测试直写 store）
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { identityView } from '../src/paper/canvas-math';
import { makeStrip } from '../src/paper/selection';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}
function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}
function volume(sid: number, turns = 2): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = 0; t < turns; t++) {
    out.push(
      userMsg(`u${sid}-${t}`, `第 ${t} 轮提问——量一段足够长的来文文本以贴近真实对话的长度。`),
      asstMsg(`a${sid}-${t}`, [
        { type: 'reasoning', text: `思考第 ${t} 轮：先定位再动手。`, finalised: true },
        { type: 'text', text: `结论第 ${t} 轮：改了三处。`, finalised: true },
        {
          type: 'tool',
          toolId: `t${sid}-${t}`,
          name: 'read_file_content',
          label: '读文件',
          args: '{}',
          readOnly: true,
          status: 'done',
          output: 'abc',
        },
      ]),
    );
  }
  return out;
}

describe('远景三档（P4c）——分档渲染行为考官', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/lod-tier-ws' });
    useDockStore.getState().closePanel('paper');
    /* canvas-view-store 是 app 级单例——跨测试残留会让 restoreView 种子同值
     * 短路（restoredView 不置位 → 挂载期视角飞行没掐掉 → setView 被飞行覆写，
     * 首轮全文件跑实测翻车）。每测前置回初值，杜绝串味。 */
    useCanvasViewStore.setState({
      view: identityView(),
      canvasSize: { w: 800, h: 600 },
      restoredView: null,
      pendingFocusId: null,
    });
    inkStats.fillText = 0;
    inkStats.fillRect = 0;
    inkFonts.clear();
  });

  afterEach(() => {
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
  });

  /** 挂载一卷并缩到目标档（restoreView 预置掐挂载噪声——见文件头注）。 */
  async function mountAtZoom(zoom: number): Promise<void> {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({ sessions: [{ id: 1, label: '卷一' }], activeIdx: 0, nextSessionId: 2 });
    msgStoreFor(panel.panelId, 1).getState().setMessages(volume(1));
    getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: 0, anchorY: 0, width: 720 });

    const view = useCanvasViewStore;
    view.getState().setCanvasSize(1200, 800);
    view.getState().restoreView({ zoom, panX: 600 - 0 * zoom, panY: 400 + 200 * zoom });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
    // RO 0×0 直写覆盖 + 守恒调 pan 后重摆目标视口（尺寸噪声治理同 wiring 测试）
    await act(async () => {
      view.getState().setCanvasSize(1200, 800);
    });
    await act(async () => {
      view.getState().setView((v) => ({ ...v, zoom, panX: 600, panY: 400 + 200 * zoom }));
    });
    // rAF 帧跑起来（~16ms/帧）
    inkStats.fillText = 0;
    inkStats.fillRect = 0;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
  }

  it('文字档（zoom 0.45）：DOM 块在场（接管阈 0.36 之上）+ 卷首头在场', async () => {
    await mountAtZoom(0.45);
    expect(container?.querySelectorAll('.pp-folio-head').length).toBe(1);
    /* 2026-09-20 接管阈下移（0.55 → 0.36）：0.45 在可读区，DOM 照常渲染、
       InkLayer 不在场——切轨只发生在「本来就读不清」的地方。 */
    expect(container?.querySelectorAll('.pp-ink-layer').length).toBe(0);
    expect(container?.querySelectorAll('.pp-block').length).toBeGreaterThan(0);
    expect(inkStats.fillText).toBe(0);
  }, 30_000);

  it('行影档（zoom 0.25）：卷首头退场 + 流块 DOM 退场（墨迹接管）+ fillText 只剩地志标签字体', async () => {
    await mountAtZoom(0.25);
    expect(container?.querySelectorAll('.pp-folio-head').length).toBe(0);
    expect(container?.querySelectorAll('.pp-region-edge').length).toBe(0);
    expect(container?.querySelectorAll('.pp-ink-layer').length).toBe(1);
    expect(container?.querySelectorAll('.pp-block').length).toBe(0); // 流块 DOM 全退
    expect(inkStats.fillRect).toBeGreaterThan(0); // 行影墨条通道在画
    // 真文字通道退役：行影档 fillText 只允许卷名标签（700 粗宋体栈）
    expect([...inkFonts].every((f) => f.startsWith('700'))).toBe(true);
  }, 30_000);

  it('迟滞带：0.25 进档后回到 0.37 不闪档（卷首头仍退场），越过 0.39 才回文字档', async () => {
    await mountAtZoom(0.25);
    const view = useCanvasViewStore;
    await act(async () => {
      view.getState().setView((v) => ({ ...v, zoom: 0.37 }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(container?.querySelectorAll('.pp-folio-head').length).toBe(0); // 迟滞带内保持行影档
    await act(async () => {
      view.getState().setView((v) => ({ ...v, zoom: 0.4 }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(container?.querySelectorAll('.pp-folio-head').length).toBe(1); // 越过退出阈回文字档
    expect(container?.querySelectorAll('.pp-ink-layer').length).toBe(0); // 墨迹层同帧退场（DOM 回场）
  }, 30_000);

  it('剪影档（zoom 0.1）：块级墨影通道在画（fillRect > 0），卷首头仍退场', async () => {
    await mountAtZoom(0.1);
    expect(container?.querySelectorAll('.pp-folio-head').length).toBe(0);
    expect(inkStats.fillRect).toBeGreaterThan(0);
  }, 30_000);
});

describe('LOD 钉住例外（2026-09-07 用户拍板：LOD 不再隐藏钉在画布上的卡片）', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/lod-pin-ws' });
    useDockStore.getState().closePanel('paper');
    useCanvasViewStore.setState({
      view: identityView(),
      canvasSize: { w: 800, h: 600 },
      restoredView: null,
      pendingFocusId: null,
    });
    inkStats.fillText = 0;
    inkStats.fillRect = 0;
    inkFonts.clear();
  });

  afterEach(() => {
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
  });

  /** 挂一卷 + 三件钉在画布上的公共物（流内钉住块 / 孤儿钉 / 纸条）并缩到
   *  目标档——「LOD 不再隐藏钉住的卡片」行为考官的台架。返回 panel（收回
   *  断言要读它的 canvas-store）。 */
  async function mountPinnedAtZoom(zoom: number): Promise<ChatCore> {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({ sessions: [{ id: 1, label: '卷一' }], activeIdx: 0, nextSessionId: 2 });
    msgStoreFor(panel.panelId, 1).getState().setMessages(volume(1));
    const canvas = getCanvasStore(panel.panelId).getState();
    canvas.setRegion('1', { anchorX: 0, anchorY: 0, width: 720 });
    // 流内钉住块（活引用源：块 id = translate 的 `pb:${msgId}`——用户块 1:1）
    canvas.setPin('pb:u1-0', {
      x: 900,
      y: -260,
      w: 720,
      source: { sessionId: 1, blockId: 'pb:u1-0' },
      snapshot: { kind: 'user', text: '第 0 轮提问——量一段足够长的来文文本以贴近真实对话的长度。' },
    });
    // 孤儿钉（无活引用源——源卷未摊开也常驻）
    canvas.setPin('orphan-pin-1', {
      x: 1500,
      y: 300,
      w: 480,
      snapshot: { kind: 'markdown', text: '孤儿钉快照正文' },
    });
    // 纸条（工作区级公共物）
    canvas.addStrip(makeStrip('钉在纸上的纸条', 900, 500, 480));

    const view = useCanvasViewStore;
    view.getState().setCanvasSize(1200, 800);
    view.getState().restoreView({ zoom, panX: 600 - 0 * zoom, panY: 400 + 200 * zoom });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
    await act(async () => {
      view.getState().setCanvasSize(1200, 800);
    });
    await act(async () => {
      view.getState().setView((v) => ({ ...v, zoom, panX: 600, panY: 400 + 200 * zoom }));
    });
    inkStats.fillText = 0;
    inkStats.fillRect = 0;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    return panel;
  }

  it('行影档（zoom 0.25）：流块退场（墨迹接管），钉住块/孤儿钉/纸条 DOM 恒在场', async () => {
    await mountPinnedAtZoom(0.25);
    // LOD 墨迹层在场（流块走 canvas）
    expect(container?.querySelectorAll('.pp-ink-layer').length).toBe(1);
    // 三件公共物 DOM 在场——用户拍板：LOD 不再隐藏钉在画布上的卡片
    expect(container?.querySelectorAll('.pp-block.pp-pinned').length).toBe(2); // 流内钉 + 孤儿钉
    expect(container?.querySelectorAll('.pp-strip').length).toBe(1);
    // 钉住块各带收回钮——是可交互真卡不是残影
    expect(container?.querySelectorAll('.pp-unpin').length).toBe(2);
    // 流内 ghost 占位钮（「已移出」）随流块退场——远缩不点它
    expect(container?.querySelectorAll('.pp-ghost').length).toBe(0);
  }, 30_000);

  it('剪影档（zoom 0.1）：公共物 DOM 仍在场（三档全线不退）', async () => {
    await mountPinnedAtZoom(0.1);
    expect(container?.querySelectorAll('.pp-ink-layer').length).toBe(1);
    expect(container?.querySelectorAll('.pp-block.pp-pinned').length).toBe(2);
    expect(container?.querySelectorAll('.pp-strip').length).toBe(1);
  }, 30_000);

  it('行影档钉住块可交互：收回钮真实拔钉（远缩下公共物是可取用的真卡）', async () => {
    const panel = await mountPinnedAtZoom(0.25);
    const btn = container?.querySelector('[data-block-id="orphan-pin-1"] .pp-unpin') ?? null;
    expect(btn).not.toBeNull();
    await act(async () => {
      (btn as HTMLButtonElement).click();
    });
    expect(getCanvasStore(panel.panelId).getState().pins['orphan-pin-1']).toBeUndefined();
  }, 30_000);
});
