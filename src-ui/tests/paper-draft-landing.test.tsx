// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸 · **落纸即聚焦**（2026-11-16 用户报：点「新建」视角不跟过去）。
//
// 病灶：落点 = **视口中心最近的空位**（draftPlacement），画布上卷一多，最近空位就在
// 视口之外——点「＋」之后纸落在屏外的某个空档，用户只看到画面纹丝不动，还得自己
// 满画布找那张题签。聚焦必须与落位**同拍**：纸一落，镜头就带过去。
//
// 本测三段：
//   ① 单元面（DraftSheet + 槽主人的 glideTo 能力位）：纸落在视口外 ⇒ 镜头被叫到
//      「纸盒竖直中线」那个世界点；**纸本来就整块在屏内 ⇒ 一动不动**（视角是用户的）；
//      再点「＋」= 同一张纸重新定位，几何一字未变也要回镜头；重渲染不重播；
//      能力位缺席 = 不飞但纸照常落位；
//   ② 判据面（volumeInSight）：开卷时「卷在不在眼前」只有一个判据，落位没写 = 不在；
//   ③ 端到端（真 PaperPanel + 真 ChatCore）：卷一多 ⇒ 纸落在屏外 ⇒ 摊开后**这张纸
//      真的落在视口里**；开卷时若纸已在眼前，则只标活跃、不再二次起飞。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const layoutMock = vi.hoisted(() =>
  vi.fn((_p: { _text: string }, _maxWidth: number, lineHeight: number) => ({ lineCount: 1, height: lineHeight })),
);
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text })),
  layout: layoutMock,
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text })),
  walkLineRanges: vi.fn(),
  materializeLineRange: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 1, maxLineWidth: 0 })),
}));

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

// jsdom 无 ResizeObserver / Canvas 2D —— PaperPanel 挂载所需的两个 no-op 桩。
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;
class Fake2dCtx {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textBaseline = '';
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
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => new Fake2dCtx(),
});

// jsdom 的 rAF 时间戳与 performance.now() 不同源（见 tests/paper-new-volume.test.tsx
// 的长注）——换成同源确定性 rAF，否则飞行动画永不完、本测读到假症状。
let rafSeq = 0;
const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = ((cb: (t: number) => void) => {
  const id = ++rafSeq;
  rafTimers.set(
    id,
    setTimeout(() => {
      rafTimers.delete(id);
      cb(performance.now());
    }, 16),
  );
  return id;
}) as unknown as typeof requestAnimationFrame;
(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = ((id: number) => {
  const t = rafTimers.get(id);
  if (t) clearTimeout(t);
  rafTimers.delete(id);
}) as unknown as typeof cancelAnimationFrame;

const { ChatCore } = await import('../src/app/chat/chat-core');
const { useCoreStore } = await import('../src/app/chat/core-instance');
const { useShellStore } = await import('../src/app/shell-store');
const { worldToScreen } = await import('../src/paper/canvas-math');
const { EMPTY_REGION_CONTENT_H, REGION_FOOT_GAP, STREAM_REGION } = await import('../src/paper/space');
const { DraftSheet } = await import('../src/plugins/builtin/paper-shell/DraftSheet');
const { draftBoxInSight, draftFocusPoint, draftPlacement } = await import(
  '../src/plugins/builtin/paper-shell/draft-sheet'
);
const { PaperPanel } = await import('../src/plugins/builtin/paper-shell/PaperPanel');
const { PaperDockContext } = await import('../src/paper/overlay-context');
type PaperDockContextValue = import('../src/paper/overlay-context').PaperDockContextValue;
const { getCanvasStore } = await import('../src/state/canvas-store');
const { useCanvasViewStore } = await import('../src/state/canvas-view-store');
const { useDockStore } = await import('../src/state/dock-store');
const { useDraftSheetStore } = await import('../src/state/draft-sheet-store');
const { usePresetStore } = await import('../src/state/preset-store');
const { getChatStore } = await import('../src/ui/chat-store');
const { volumeInSight } = await import('../src/app/chat/session/draft-opening');

const PANEL = 'draft-landing';
/** 视口比纸宽（纸恒 1440）——本组要断言的是「整张纸都在屏上」，窄视口下纸本就装不下，
 *  那会把「聚焦对不对」和「窗口够不够大」两件事混成一条断言。 */
const W = 1600;
const H = 900;

/** 槽主人那份上下文的最小能力位面（只有 glideTo 与本测有关）。 */
function dockContext(glideTo: (x: number, y: number) => void): PaperDockContextValue {
  return { activeSessionId: null, flyToPoint: vi.fn(), glideTo };
}

describe('待题纸 · 落纸即聚焦（① 纸落在屏外 ⇒ 镜头跟过去）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    useDraftSheetStore.getState().dismissAll();
    usePresetStore.setState({ selected: 'standard', error: null });
    getCanvasStore(PANEL).getState().clearCanvas();
    useCanvasViewStore.setState({ view: { zoom: 1, panX: 0, panY: 0 }, canvasSize: { w: W, h: H } });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useDraftSheetStore.getState().dismissAll();
  });

  /** 把视口中心占满：最近空位必然落在视口之外（就是用户报的那一幕）。 */
  function occupyCenter(): void {
    getCanvasStore(PANEL)
      .getState()
      .setRegion('1', { anchorX: W / 2, anchorY: H / 2, width: STREAM_REGION.width });
  }

  async function mount(glideTo: (x: number, y: number) => void): Promise<HTMLDivElement> {
    const el = document.createElement('div');
    document.body.appendChild(el);
    await act(async () => {
      root = createRoot(el);
      root.render(
        createElement(
          PaperDockContext.Provider,
          { value: dockContext(glideTo) },
          createElement(DraftSheet, { core: { panelId: PANEL } }),
        ),
      );
    });
    return el;
  }

  it('落纸与聚焦同一拍：纸落在屏外 ⇒ glideTo 收到「纸盒竖直中线」', async () => {
    occupyCenter();
    const glideTo = vi.fn();
    container = await mount(glideTo);
    expect(useDraftSheetStore.getState().papers).toHaveLength(0);

    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });

    const spot =
      useDraftSheetStore.getState().papers.find((p) => p.id === useDraftSheetStore.getState().focusedId)?.anchor ??
      null;
    expect(spot).not.toBeNull();
    // 前提：这一次落位真的落在视口之外（否则本测什么也证明不了）
    expect(draftBoxInSight(spot!, useCanvasViewStore.getState().view, { w: W, h: H })).toBe(false);

    expect(glideTo).toHaveBeenCalledTimes(1);
    const focus = draftFocusPoint(spot!);
    expect(glideTo).toHaveBeenLastCalledWith(focus.x, focus.y);
  });

  it('纸本来就整块在视口里 ⇒ 一动不动（视角是用户的，不许被自动动作拉走）', async () => {
    // 空画布：落点 = 视口中心最近空位，纸整块在屏内
    const glideTo = vi.fn();
    container = await mount(glideTo);
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });
    const spot =
      useDraftSheetStore.getState().papers.find((p) => p.id === useDraftSheetStore.getState().focusedId)?.anchor ??
      null;
    expect(spot).not.toBeNull();
    expect(draftBoxInSight(spot!, useCanvasViewStore.getState().view, { w: W, h: H })).toBe(true);
    expect(glideTo).not.toHaveBeenCalled();
  });

  it('再点「＋」= **新摊一张纸**（多纸），旧纸留在画布上；新纸落在眼前 ⇒ 镜头不动', async () => {
    occupyCenter();
    const glideTo = vi.fn();
    container = await mount(glideTo);

    let firstId = '';
    await act(async () => {
      firstId = useDraftSheetStore.getState().openSheet();
    });
    expect(glideTo).toHaveBeenCalledTimes(1);

    // 再点「＋」：多纸改判 —— 第二张是**新的一条记录**，不是把旧纸挪个位置
    let secondId = '';
    await act(async () => {
      secondId = useDraftSheetStore.getState().openSheet();
    });

    const st = useDraftSheetStore.getState();
    expect(st.papers).toHaveLength(2);
    expect(st.papers.map((p) => p.id)).toEqual([firstId, secondId]);
    expect(st.focusedId).toBe(secondId); // 焦点交给新那张
    const second = st.papers.find((p) => p.id === secondId)!;
    expect(second.anchor).not.toBeNull();
    /* 第二张纸的锚点**必然避开第一张**（nearestFreeRegion 的区间语义）：视口中心被
     * 第一张占着 ⇒ 第二张被推到旁边。它可能整块在屏内、也可能一头出屏——两种都合法，
     * 判据只看「镜头有没有去它那儿」：出屏 ⇒ 必须飞；在屏内 ⇒ 一动不动。 */
    const inSight = draftBoxInSight(second.anchor!, useCanvasViewStore.getState().view, { w: W, h: H });
    expect(glideTo).toHaveBeenCalledTimes(inSight ? 1 : 2);
    if (!inSight) {
      const focus = draftFocusPoint(second.anchor!);
      expect(glideTo).toHaveBeenLastCalledWith(focus.x, focus.y);
    }
  });

  it('重渲染不重播：同一张纸落过纸之后，普通的 re-render 不再拉镜头', async () => {
    occupyCenter();
    const glideTo = vi.fn();
    container = await mount(glideTo);
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });
    expect(glideTo).toHaveBeenCalledTimes(1);

    await act(async () => {
      useDraftSheetStore.getState().setNotice(null);
      useDraftSheetStore.getState().setPicks({
        presetId: null,
        providerName: 'p',
        model: 'm',
        thinking: undefined,
      });
    });
    expect(glideTo).toHaveBeenCalledTimes(1);
  });

  it('能力位缺席（单独挂纸，无槽主人）= 不飞，纸照常落位（不炸纸面）', async () => {
    occupyCenter();
    const el = document.createElement('div');
    document.body.appendChild(el);
    await act(async () => {
      root = createRoot(el);
      root.render(createElement(DraftSheet, { core: { panelId: PANEL } }));
    });
    container = el;
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });
    expect(useDraftSheetStore.getState().papers.length).toBeGreaterThan(0);
    expect(useDraftSheetStore.getState().papers[0]?.anchor).not.toBeNull();
    expect(el.querySelector('[data-draft-sheet]')).not.toBeNull();
  });
});

describe('待题纸 · 落纸即聚焦（② 开卷时的可见判据）', () => {
  beforeEach(() => {
    getCanvasStore(PANEL).getState().clearCanvas();
    useCanvasViewStore.setState({ view: { zoom: 1, panX: 0, panY: 0 }, canvasSize: { w: W, h: H } });
  });

  it('落位在视口里 = 在眼前；视口拖走 = 不在；还没落位 = 不在（回落飞行）', () => {
    const canvas = getCanvasStore(PANEL).getState();
    expect(volumeInSight(PANEL, 7)).toBe(false); // 没落位：无从判可见

    canvas.setRegion('7', { anchorX: W / 2, anchorY: H / 2, width: STREAM_REGION.width });
    expect(volumeInSight(PANEL, 7)).toBe(true);

    useCanvasViewStore.getState().setView({ zoom: 1, panX: 5000, panY: 3000 });
    expect(volumeInSight(PANEL, 7)).toBe(false);
  });
});

describe('待题纸 · 落纸即聚焦（③ 端到端：真 PaperPanel + 真 ChatCore）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/draft-landing-ws' });
    useDraftSheetStore.getState().dismissAll();
    useDockStore.getState().closePanel('paper');
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useDraftSheetStore.getState().dismissAll();
  });

  async function mountPanel(): Promise<HTMLDivElement> {
    const el = document.createElement('div');
    document.body.appendChild(el);
    await act(async () => {
      root = createRoot(el);
      root.render(createElement(PaperPanel));
    });
    return el;
  }

  it('卷一多 ⇒ 纸落在屏外 ⇒ 摊开后这张纸**真的落在视口里**（用户不再满画布找题签）', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const canvas = getCanvasStore(panel.panelId);
    // 视口正中那一卷把中心占掉、右侧再放一卷：最近空位被推到视口之外（用户报的那一幕）
    canvas.getState().setRegion('1', { anchorX: W / 2, anchorY: H / 2, width: STREAM_REGION.width });
    canvas.getState().setRegion('2', { anchorX: W / 2 + 2000, anchorY: H / 2, width: STREAM_REGION.width });

    const view = useCanvasViewStore;
    view.getState().setCanvasSize(W, H);
    view.getState().restoreView({ zoom: 1, panX: 0, panY: 0 });

    container = await mountPanel();
    await act(async () => {
      view.getState().setCanvasSize(W, H);
    });
    await act(async () => {
      view.getState().setView({ zoom: 1, panX: 0, panY: 0 });
    });

    // 前提：这一步的落位本来就在屏外（用户报的正是这个）
    const offscreen = draftPlacement({ panelId: panel.panelId });
    const offX = worldToScreen({ zoom: 1, panX: 0, panY: 0 }, offscreen.anchorX, offscreen.anchorY).x;
    expect(offX < 0 || offX > W).toBe(true);

    // 侧栏「＋」/ 空态 CTA / 造模式的**同一个入口**
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500)); // 镜头飞行（--m-sheet 一档）
    });

    const spot =
      useDraftSheetStore.getState().papers.find((p) => p.id === useDraftSheetStore.getState().focusedId)?.anchor ??
      null;
    expect(spot).not.toBeNull();
    const sheet = container.querySelector('[data-draft-sheet]') as HTMLElement | null;
    expect(sheet).not.toBeNull();
    const boxTop = Number.parseFloat(sheet!.style.top);
    const boxH = Number.parseFloat(sheet!.style.height);
    // jsdom 里纸高量不到（offsetHeight 恒 0）⇒ 盒高垫到「零块卷的最小盒高」，即
    // 本测使用的那个盒；高度下限与 draftFocusPoint 内的 boxH 同一把尺子。
    expect(boxH).toBeGreaterThanOrEqual(EMPTY_REGION_CONTENT_H + REGION_FOOT_GAP);
    const v = view.getState().view;
    const topOnScreen = boxTop * v.zoom + v.panY;
    const bottomOnScreen = (boxTop + boxH) * v.zoom + v.panY;
    const leftOnScreen = (spot!.anchorX - spot!.width / 2) * v.zoom + v.panX;
    const rightOnScreen = (spot!.anchorX + spot!.width / 2) * v.zoom + v.panX;
    // 纸盒整块在视口里：纵向两端都看得见、横向两端都看得见
    expect(topOnScreen).toBeGreaterThanOrEqual(0);
    expect(bottomOnScreen).toBeLessThanOrEqual(H);
    expect(leftOnScreen).toBeGreaterThanOrEqual(0);
    expect(rightOnScreen).toBeLessThanOrEqual(W);
  });

  it('纸已经在眼前时开卷 = 只标活跃、不再二次起飞（原位交接，不抖一格）', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const view = useCanvasViewStore;
    view.getState().setCanvasSize(W, H);
    view.getState().setView({ zoom: 1, panX: 0, panY: 0 });
    getCanvasStore(panel.panelId).getState().clearCanvas();

    await act(async () => {
      useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().setAnchor({ anchorX: W / 2, anchorY: H / 2, width: STREAM_REGION.width });
    });
    await act(async () => {
      getChatStore(panel.panelId).input.getState().setInputText('落笔');
      await panel.sendMessage();
      await new Promise((r) => setTimeout(r, 300));
    });

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions).toHaveLength(1);
    const sid = String(st.sessions[0]!.id);
    // 活跃流区照样标上（引线/坞/目次带三处判据）
    expect(getCanvasStore(panel.panelId).getState().activeSessionId).toBe(sid);
    // 但**没有**发定位请求：纸就在眼前，卷与纸同锚点同宽
    expect(view.getState().pendingFocusId).toBeNull();
  });

  it('纸不在眼前（视口被拖走）时开卷：照旧请求定位（出生即展开不许看不见）', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const view = useCanvasViewStore;
    view.getState().setCanvasSize(W, H);
    view.getState().setView({ zoom: 1, panX: 0, panY: 0 });
    getCanvasStore(panel.panelId).getState().clearCanvas();

    await act(async () => {
      useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().setAnchor({ anchorX: W / 2, anchorY: H / 2, width: STREAM_REGION.width });
    });
    // 用户把画面拖走：纸还在世界里原位，但已经出屏
    await act(async () => {
      view.getState().setView({ zoom: 1, panX: -4000, panY: -3000 });
    });
    await act(async () => {
      getChatStore(panel.panelId).input.getState().setInputText('落笔');
      await panel.sendMessage();
      await new Promise((r) => setTimeout(r, 300));
    });

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions).toHaveLength(1);
    const sid = String(st.sessions[0]!.id);
    expect(getCanvasStore(panel.panelId).getState().activeSessionId).toBe(sid);
    expect(view.getState().pendingFocusId).toBe(sid);
  });
});
