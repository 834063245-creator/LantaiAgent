// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 画布视口 UX 批（2026-09-07 用户四项：滚轮平滚 / 拖选自动滚屏 / 流区背景
// 拖拽平移；2026-09-08 缩放舒适度拍板：书眉缩放控件 + 键盘 +/−/0 + 滚轮
// 行为设置切换）行为考官——挂真实 PaperPanel 穿全层，jsdom 原生事件直驱：
//   ① 滚轮语义：plain wheel = 平移（deltaY/deltaX，Shift 兜底换算），Ctrl+wheel
//      = 缩放（锚光标）；pre/.pp-out 输出区原生透传（画布不动）。
//   ② 流区背景（.pp-region 纸面）按下拖动 = 平移画布；块文本按下拖动 ≠ 平移。
//   ③ 拖选自动滚屏：活选区 + 指针贴画布下缘 → panY 持续减小（rAF 循环）+
//      Selection.extend 每帧把焦点追到指针下（caretRangeFromPoint 注入）；
//      松手停滚；选区折叠不滚。
//   ④ 缩放舒适度：书眉 −/+ 阶梯迈步（ZOOM_STEPS）+ 点读数回 100%；键盘
//      +/=/−/0（输入框门控）；设置「滚轮行为=缩放画布」时 plain wheel
//      直接缩放（Miro 派 ↔ Whimsical 派互切）。
//   ⑤ 拖块边缘自动滚屏（2026-09-17 手感批）：指针贴视口四缘 → 视口持续滚屏
//      （指针静止也滚、回带内停摆）+ 块影钉回指针下（松手落点 = 块影所在）——
//      一次手势把块送到任意远处，病灶「拖一下→滚→再拖」。
// harness 时序纪律同 paper-lod-tiers（RO 0×0 直写覆盖 + restoreView 预置掐
// 挂载期视角飞行）。

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

// jsdom 无 Canvas 2D → 假 ctx（InkLayer rAF 循环要跑，不数墨）
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
import { rendererServicePlugin } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { wheelFactor } from '../src/paper/canvas-math';
import { makeStrip } from '../src/paper/selection';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { blockReturnsToFlow } from '../src/plugins/builtin/paper-shell/use-paper-drag';
import { isEditableSurface } from '../src/plugins/builtin/paper-shell/use-paper-strips';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { loadSettings, saveSettings } from '../src/settings';
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
function volume(sid: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = 0; t < 3; t++) {
    out.push(
      userMsg(`u${sid}-${t}`, `第 ${t} 轮提问——量一段足够长的来文文本以贴近真实对话的长度。`),
      asstMsg(`a${sid}-${t}`, [
        { type: 'reasoning', text: `思考第 ${t} 轮。`, finalised: true },
        { type: 'text', text: `结论第 ${t} 轮。`, finalised: true },
        // 程文块（code_execution 工具卡）：error 态默认展开 → .pp-out 输出区
        // 在场（滚轮透传判据的消费面）
        {
          type: 'tool',
          toolId: `cx${sid}-${t}`,
          name: 'code_execution',
          label: '跑程序',
          args: JSON.stringify({ code: 'print(1)', description: '示例程序' }),
          readOnly: true,
          status: 'error',
          output: '堆栈输出文本——程文输出区的可滚内容。',
        },
      ]),
    );
  }
  return out;
}

describe('画布视口 UX（2026-09-07：滚轮平滚 / 流区拖拽 / 拖选自动滚屏）', () => {
  let panel: ChatCore;
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  /** window.getSelection 间谍（installFakeSelection 装、afterEach 卸——模块级
   * vi.mock 工厂不能用 restoreAllMocks（会把 pretext 桩的原实现一并还原掉）。 */
  let selSpy: ReturnType<typeof vi.spyOn> | null = null;
  /** `stubRangeRects` 打在原型上，必须逐例还原（否则后续用例的 cloneRange 也吃假矩形）。 */
  const origRangeRects = Range.prototype.getClientRects;
  const origRangeBounding = Range.prototype.getBoundingClientRect;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/viewport-ux-ws' });
    useDockStore.getState().closePanel('paper');
    useCanvasViewStore.setState({
      view: { panX: 0, panY: 0, zoom: 1 },
      canvasSize: { w: 800, h: 600 },
      restoredView: null,
      pendingFocusId: null,
    });
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
    selSpy?.mockRestore();
    selSpy = null;
    Range.prototype.getClientRects = origRangeRects;
    Range.prototype.getBoundingClientRect = origRangeBounding;
    delete (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
  });

  /** 挂一卷（zoom 1 视口 1200×800，panX 600 / panY 600），返回 canvas 元素。 */
  async function mountCanvas(): Promise<HTMLDivElement> {
    panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({ sessions: [{ id: 1, label: '卷一' }], activeIdx: 0, nextSessionId: 2 });
    msgStoreFor(panel.panelId, 1).getState().setMessages(volume(1));
    getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: 0, anchorY: 0, width: 720 });

    const view = useCanvasViewStore;
    view.getState().setCanvasSize(1200, 800);
    view.getState().restoreView({ zoom: 1, panX: 600, panY: 600 });

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
      view.getState().setView((v) => ({ ...v, zoom: 1, panX: 600, panY: 600 }));
    });
    const canvas = container.querySelector<HTMLDivElement>('.pp-canvas');
    if (!canvas) throw new Error('pp-canvas 未挂载');
    return canvas;
  }

  const fire = (el: Element | Window, type: string, init: MouseEventInit & { button?: number }): MouseEvent => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    (el === window ? window : el).dispatchEvent(ev);
    return ev;
  };

  /* ── ① 滚轮语义 ── */

  it('plain wheel（deltaY 120）：视口向下平滚一档（panY -120），zoom 不动', async () => {
    const canvas = await mountCanvas();
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, clientX: 600, clientY: 400, bubbles: true, cancelable: true }),
    );
    const v = useCanvasViewStore.getState().view;
    expect(v.zoom).toBe(1);
    expect(v.panX).toBe(600);
    expect(v.panY).toBe(600 - 120);
  }, 30_000);

  it('plain wheel 横向（deltaX 40）：panX -40；Shift 兜底（deltaY 无 deltaX）走横向', async () => {
    const canvas = await mountCanvas();
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaX: 40, deltaY: 0, clientX: 600, clientY: 400, cancelable: true, bubbles: true }),
    );
    expect(useCanvasViewStore.getState().view.panX).toBe(600 - 40);
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 60,
        shiftKey: true,
        clientX: 600,
        clientY: 400,
        cancelable: true,
        bubbles: true,
      }),
    );
    const v = useCanvasViewStore.getState().view;
    expect(v.panX).toBe(600 - 40 - 60);
    expect(v.panY).toBe(600); // shift 后纵向归零，不吃 deltaY
  }, 30_000);

  it('ctrl+wheel：仍是以光标为锚的缩放（zoom × wheelFactor）', async () => {
    const canvas = await mountCanvas();
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 120,
        ctrlKey: true,
        clientX: 600,
        clientY: 400,
        cancelable: true,
        bubbles: true,
      }),
    );
    const v = useCanvasViewStore.getState().view;
    expect(v.zoom).toBeCloseTo(wheelFactor(120), 10);
    // 锚点守恒：屏幕 (600,400) 的世界点缩放前后不动
    const wx = (600 - 600) / 1;
    expect(wx * v.zoom + v.panX).toBeCloseTo(600, 6);
  }, 30_000);

  /** 块体渲染器激活壳（asset-media-load 同款）：PaperPanel 的 BlockView 经
   *  resolveRenderer 取渲染器——service 不装配时块体走灰框兜底（无
   *  pre/.pp-out 可考）。程文输出区透传用例需要真渲染器在场。 */
  async function withRenderers(fn: () => Promise<void>): Promise<void> {
    const ctx = new Context();
    const f1 = ctx.plugin(compositionServicesPlugin);
    const f2 = ctx.plugin(rendererServicePlugin);
    const f3 = ctx.plugin(builtinRenderersPlugin);
    await f3;
    await fn();
    await f3.dispose();
    await f2.dispose();
    await f1.dispose();
  }

  it('滚轮在程文输出区（.pp-out）上：原生透传，画布不动', async () => {
    await withRenderers(async () => {
      await mountCanvas();
      const out = container?.querySelector('.pp-out') ?? null;
      expect(out).not.toBeNull();
      out?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 120, clientX: 600, clientY: 300, bubbles: true, cancelable: true }),
      );
      const v = useCanvasViewStore.getState().view;
      expect(v.panY).toBe(600);
      expect(v.zoom).toBe(1);
    });
  }, 30_000);

  /* ── ② 流区背景拖拽平移 ── */

  it('流区纸面（.pp-region）按下拖动 = 平移画布（pp-panning 态 + pan 累积）', async () => {
    await mountCanvas();
    const region = container?.querySelector('.pp-region') ?? null;
    expect(region).not.toBeNull();
    await act(async () => {
      fire(region as Element, 'mousedown', { button: 0, clientX: 400, clientY: 300 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 520, clientY: 380 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    // 手势中：panning 态挂上（grabbing 光标面）
    expect(container?.querySelector('.pp-canvas.pp-panning')).not.toBeNull();
    await act(async () => {
      fire(window, 'mouseup', { clientX: 520, clientY: 380 });
    });
    const v = useCanvasViewStore.getState().view;
    expect(v.panX).toBe(600 + 120);
    expect(v.panY).toBe(600 + 80);
    expect(container?.querySelector('.pp-canvas.pp-panning')).toBeNull();
  }, 30_000);

  it('块文本按下拖动 ≠ 平移（文本区是选择面）', async () => {
    await mountCanvas();
    const block = container?.querySelector('.pp-block') ?? null;
    expect(block).not.toBeNull();
    await act(async () => {
      fire(block as Element, 'mousedown', { button: 0, clientX: 400, clientY: 300 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 520, clientY: 380 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    await act(async () => {
      fire(window, 'mouseup', { clientX: 520, clientY: 380 });
    });
    const v = useCanvasViewStore.getState().view;
    expect(v.panX).toBe(600);
    expect(v.panY).toBe(600);
  }, 30_000);

  /* ── ③ 拖选自动滚屏 ── */

  /** 假选区（jsdom 无原生拖选模拟）：真 Range 锚在块文本 + 可数 extend +
   *  注入 caretRangeFromPoint（Chromium 面——jsdom 缺席，延伸链路要它）。
   *  `rects` 非空时供抽纸条 A 路的落点探针（pointInSelectionRects）用：
   *  传了 = 指针「落在选区内」，可考 lift 手势。
   *  `bounding` 非空时给 Range.getBoundingClientRect 一个真矩形——抽纸条浮钮
   *  按 `rect.width > 0` 定 fabPos，零矩形下浮钮恒不现身（见划词消费面守卫考）。 */
  function installFakeSelection(
    collapsed: boolean,
    rects: Array<{ left: number; top: number; right: number; bottom: number }> = [],
    bounding: { left: number; top: number; right: number; bottom: number } | null = null,
  ): { extend: ReturnType<typeof vi.fn> } {
    const block = container?.querySelector('.pp-block') ?? null;
    if (!block) throw new Error('pp-block 未挂载');
    const textNode = (() => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const n = walker.nextNode();
      if (!n) throw new Error('块内无文本节点');
      return n;
    })();
    const range = document.createRange();
    range.selectNodeContents(textNode);
    // jsdom 的 Range 无 getClientRects（无布局引擎）——抽纸条 A 路的 mousedown
    // 探针（pointInSelectionRects）会炸成未处理错误。默认补空实现：空矩形集 =
    // 指针不在选区内 → A 路短路（不混 lift 手势）；传 rects 则进 A 路。
    (range as Range & { getClientRects?: () => DOMRectList }).getClientRects = () =>
      rects.map(
        (r) =>
          ({
            ...r,
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
            toJSON: () => ({}),
          }) as unknown as DOMRect,
      ) as unknown as DOMRectList;
    (range as Range & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect = () =>
      bounding
        ? ({
            ...bounding,
            x: bounding.left,
            y: bounding.top,
            width: bounding.right - bounding.left,
            height: bounding.bottom - bounding.top,
            toJSON: () => ({}),
          } as DOMRect)
        : ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect);
    const extend = vi.fn();
    const fake = {
      isCollapsed: collapsed,
      rangeCount: collapsed ? 0 : 1,
      anchorNode: textNode,
      anchorOffset: 0,
      getRangeAt: () => range,
      extend,
      // 忠实行为：清空选区后 rangeCount/isCollapsed 必须真的变（真机 lift 揭起即清
      // 选区——拖选自动滚屏据此自动解除武装；空实现会让两条路径同时滚）
      removeAllRanges: () => {
        fake.isCollapsed = true;
        fake.rangeCount = 0;
      },
      toString: () => '选中文字',
    };
    selSpy = vi.spyOn(window, 'getSelection').mockReturnValue(fake as unknown as Selection);
    const docWithCaret = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    docWithCaret.caretRangeFromPoint = () => range;
    return { extend };
  }

  it('活选区 + 指针贴画布下缘：panY 持续减小 + Selection.extend 逐帧追焦点', async () => {
    await mountCanvas();
    const { extend } = installFakeSelection(false);
    const block = container?.querySelector('.pp-block') as HTMLElement;
    await act(async () => {
      fire(block, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 600, clientY: 780 }); // 下缘带内（800-36=764）
    });
    const panY0 = useCanvasViewStore.getState().view.panY;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    const panY1 = useCanvasViewStore.getState().view.panY;
    expect(panY1).toBeLessThan(panY0); // 贴下缘 → 视口向下追内容（panY 减）
    // 每帧把焦点延伸到指针下的插入点（内容平移后浏览器不自行扩选）
    expect(extend.mock.calls.length).toBeGreaterThan(0);
    // 松手停滚
    await act(async () => {
      fire(window, 'mouseup', { clientX: 600, clientY: 780 });
    });
    const panY2 = useCanvasViewStore.getState().view.panY;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(panY2);
  }, 30_000);

  it('选区折叠（按下未拖开）贴边缘：不滚（防误触发）', async () => {
    await mountCanvas();
    installFakeSelection(true);
    const block = container?.querySelector('.pp-block') as HTMLElement;
    await act(async () => {
      fire(block, 'mousedown', { button: 0, clientX: 600, clientY: 780 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 600, clientY: 780 });
    });
    const panY0 = useCanvasViewStore.getState().view.panY;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(panY0);
    await act(async () => {
      fire(window, 'mouseup', { clientX: 600, clientY: 780 });
    });
  }, 30_000);

  /* ── ③b 划词消费面守卫（2026-09-17 选区政策批）──
   * 用户操作序列：家具（浮件/目次带/坞/侧栏）上按下 → 一路拖过纸面 → 松手。
   * user-select:none 只挡「从家具起选」，浏览器会把选区锚点夹进块内文字 ⇒ 锚点
   * 与真划词无法区分。故按下那一刻的起手面才是判据（纸壳 capture 面登记）。 */

  /** 消费面矩形桩（**必须打在原型上**）：`selInk` / `selAnchor` 存的是
   *  `range.cloneRange()`——clone 不继承实例级补丁（installFakeSelection 的
   *  实例桩只管得住 A 路落点探针），jsdom 原型的 getClientRects 恒空 ⇒ 朱线
   *  与浮钮在 jsdom 里永远产不出可断言物。 */
  function stubRangeRects(rect: { left: number; top: number; right: number; bottom: number }): void {
    const domRect = {
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => ({}),
    } as DOMRect;
    Range.prototype.getClientRects = () => [domRect] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => domRect;
  }

  /** 假选区锚在块内**首个**文本节点上——块首常是 JSX 留下的空白文本节点，而
   *  空节点 `selectNodeContents` 得的 Range 是**折叠**的（划词消费面据此判空，
   *  真机块首是正文不是空白）。故先塞一个有内容的文本节点占位。 */
  function seedBlockText(): void {
    const block = container?.querySelector('.pp-block') as HTMLElement;
    block.insertBefore(document.createTextNode('选中文字'), block.firstChild);
  }

  it('起手在家具上（扫进纸面）：划词朱线不落、抽纸条浮钮不弹', async () => {
    await mountCanvas();
    seedBlockText();
    const rect = { left: 600, top: 300, right: 700, bottom: 320 };
    stubRangeRects(rect);
    // rects 不传：指针不算「落在选区内」，A 路 lift（按住已有选区拖出）不参与本考
    installFakeSelection(false, [], rect);
    const chrome = container?.querySelector('.pp-chrome') as HTMLElement;
    expect(chrome).not.toBeNull();
    await act(async () => {
      fire(chrome, 'mousedown', { button: 0, clientX: 900, clientY: 40 });
    });
    // 浏览器把锚点夹进块内（假选区本就锚在块文本）——判据只剩起手面
    const block = container?.querySelector('.pp-block') as HTMLElement;
    expect(block.contains(document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode())).toBe(true);
    await act(async () => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(container?.querySelector('.pp-sel-ink')).toBeNull();
    expect(container?.querySelector('.pp-strip-fab')).toBeNull();
  }, 30_000);

  it('起手在纸面正文（块内按下）：同一选区照常落朱线 + 弹浮钮', async () => {
    await mountCanvas();
    seedBlockText();
    const rect = { left: 600, top: 300, right: 700, bottom: 320 };
    stubRangeRects(rect);
    installFakeSelection(false, [], rect);
    const block = container?.querySelector('.pp-block') as HTMLElement;
    await act(async () => {
      fire(block, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
    });
    await act(async () => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(container?.querySelector('.pp-sel-ink')).not.toBeNull();
    expect(container?.querySelector('.pp-strip-fab')).not.toBeNull();
  }, 30_000);

  it('输入面判据：可编辑控件内（含块内输入件）不算划纸，正文/按钮不算', () => {
    const ta = document.createElement('textarea');
    const inner = document.createElement('span');
    ta.appendChild(inner);
    document.body.appendChild(ta);
    expect(isEditableSurface(ta)).toBe(true);
    expect(isEditableSurface(inner)).toBe(true); // 祖先链上找得到输入件
    expect(isEditableSurface(container ?? document.body)).toBe(false);
    expect(isEditableSurface(document.createElement('button'))).toBe(false);
    expect(isEditableSurface(null)).toBe(false);
    ta.remove();
  });

  /* ── ④ 缩放舒适度（2026-09-08 拍板：书眉缩放控件 + 键盘 +/−/0 + 滚轮行为设置）── */

  it('书眉缩放控件：＋/− 阶梯迈步（锚视口中心）、点读数回 100%', async () => {
    await mountCanvas(); // 出发视口：zoom 1 / pan (600, 600)
    const btns = container?.querySelectorAll<HTMLButtonElement>('.pp-zoom-ctl button');
    expect(btns?.length).toBe(3);
    // ＋：1 → 1.5，中心锚守恒（世界点 0,-200 不动 → pan (600, 700)）
    await act(async () => {
      btns?.[2].click();
    });
    expect(useCanvasViewStore.getState().view.zoom).toBe(1.5);
    expect(useCanvasViewStore.getState().view.panX).toBe(600);
    expect(useCanvasViewStore.getState().view.panY).toBe(700);
    // −：1.5 → 回 1（原位复位）
    await act(async () => {
      btns?.[0].click();
    });
    const v = useCanvasViewStore.getState().view;
    expect(v.zoom).toBe(1);
    expect(v.panX).toBe(600);
    expect(v.panY).toBe(600);
    // 自由缩放到档间值（0.6）后 ＋：取该方向下一档 0.75
    await act(async () => {
      useCanvasViewStore.getState().setView((cur) => ({ ...cur, zoom: 0.6 }));
    });
    await act(async () => {
      btns?.[2].click();
    });
    expect(useCanvasViewStore.getState().view.zoom).toBe(0.75);
    // 点读数：回 100%（中心锚守恒）
    await act(async () => {
      btns?.[1].click();
    });
    const v2 = useCanvasViewStore.getState().view;
    expect(v2.zoom).toBe(1);
    expect(v2.panX).toBe(600);
  }, 30_000);

  it('键盘缩放快捷键：+/=/−/0（Ctrl+= 别名同收），输入框内不触发', async () => {
    await mountCanvas();
    const key = (k: string, init: KeyboardEventInit = {}): void => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init }));
    };
    await act(async () => {
      key('+');
    });
    expect(useCanvasViewStore.getState().view.zoom).toBe(1.5);
    await act(async () => {
      key('-');
    });
    expect(useCanvasViewStore.getState().view.zoom).toBe(1);
    await act(async () => {
      key('=', { ctrlKey: true }); // Ctrl+= 浏览器习惯别名
    });
    expect(useCanvasViewStore.getState().view.zoom).toBe(1.5);
    await act(async () => {
      key('0');
    });
    expect(useCanvasViewStore.getState().view.zoom).toBe(1);
    // 输入框内打字不触发（composer/设置输入框同门控）
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: '+', cancelable: true, bubbles: true }));
    });
    expect(useCanvasViewStore.getState().view.zoom).toBe(1);
    ta.remove();
  }, 30_000);

  /* ── ⑦ 边缘滚动 = 原生功能（2026-09-17 立）：设置开关 + 灵敏度 + 三族手势 ──
   * 帧循环与策略单点在 paper-shell/edge-scroll.ts；本段考行为面：
   * 开关即时生效（保存广播）、灵敏度改感应带宽、纸条与抽纸条两族手势也接同一套。 */

  /** 把边缘滚动设置写进盘面并广播（= 设置面板保存的效果；面板写面另有考官）。 */
  const saveEdgeScroll = async (enabled: boolean, sensitivity = 1, hover = false): Promise<void> => {
    const cur = loadSettings();
    saveSettings({
      ...cur,
      canvas: {
        ...cur.canvas,
        wheelMode: cur.canvas?.wheelMode ?? 'pan',
        edgeScroll: { enabled, sensitivity, hover },
      },
    });
    await act(async () => {});
  };

  /* 悬停即滚（RTS 相机形态，缺省关）：指针停在画布边缘就滚，不必按住任何东西。
   * 与拖拽族三处刻意差异（画布外不滚 / 按键让位 / 交互面豁免）都有考官。 */

  it('悬停即滚：开机后指针停在画布下缘（无按键）→ 视口自己滚；离开边缘即停', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    await saveEdgeScroll(true, 1, true);
    // 无任何 mousedown：只在画布上停一下指针
    await act(async () => {
      fire(canvas, 'mousemove', { clientX: 600, clientY: 780 });
    });
    const [, panY1] = await scrollUntil(40);
    expect(600 - panY1).toBeGreaterThan(40); // 视口自己滚（相机自主）
    // 指针回到画布中部 → 停摆（且不再爬行）
    await act(async () => {
      fire(canvas, 'mousemove', { clientX: 600, clientY: 400 });
    });
    const settled = useCanvasViewStore.getState().view.panY;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(settled);
  }, 30_000);

  it('悬停即滚：缺省即生效（不需要任何设置——2026-09-17 翻案：首版缺省关，实测发现不了功能）', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    // 不写任何设置：缺省口径 = 总开关开 + 悬停开 + 基准灵敏度
    await act(async () => {
      fire(canvas, 'mousemove', { clientX: 600, clientY: 780 });
    });
    const [, panY1] = await scrollUntil(40);
    expect(600 - panY1).toBeGreaterThan(40);
  }, 30_000);

  it('悬停即滚：交互面（纸条）之上不滚，空白/纸面上滚（同一姿态 A/B）', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    await saveEdgeScroll(true, 1, true);
    // 纸条放在下缘带内（世界 y=180 → 屏幕 780），指针停它身上 = 想操作纸条，不该滚
    getCanvasStore(panel.panelId)
      .getState()
      .addStrip(makeStrip('纸条', 100, 180, 480));
    await act(async () => {});
    const stripEl = container?.querySelector<HTMLElement>('.pp-strip') ?? null;
    expect(stripEl).not.toBeNull();
    await act(async () => {
      fire(stripEl as Element, 'mousemove', { clientX: 700, clientY: 780, bubbles: true });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(600); // 交互面豁免
    // 同一姿态改落在画布本身（纸面/桌面）→ 滚
    await act(async () => {
      fire(canvas, 'mousemove', { clientX: 600, clientY: 780 });
    });
    const [, panY1] = await scrollUntil(30);
    expect(600 - panY1).toBeGreaterThan(30);
  }, 30_000);

  it('悬停即滚：按住鼠标键时让位（不接管，避免与拖拽循环双倍滚）', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    await saveEdgeScroll(true, 1, true);
    // buttons=1 的 mousemove（真机按住键时的形态）：悬停档必须先让位
    await act(async () => {
      fire(canvas, 'mousemove', { clientX: 600, clientY: 780, buttons: 1 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(600);
  }, 30_000);

  it('拖拽中直接用滚轮滚视口：能滚，且块影不脱手（松手落点 = 块影处）', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    const block = container?.querySelector<HTMLElement>('.pp-block') ?? null;
    const blockId = block?.getAttribute('data-block-id') ?? '';
    await act(async () => {
      fire(block?.querySelector('.pp-kind') as Element, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 1100, clientY: 400 }); // 带外：本身不滚
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(600);
    // 拖拽途中滚轮平滚（真机常态：一只手拖、一只手腕滚）
    await act(async () => {
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 240, clientX: 1100, clientY: 400, bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60)); // 让帧循环把块影复位
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(360); // 滚轮直接滚了视口
    const p = previewXY();
    await act(async () => {
      fire(window, 'mouseup', { clientX: 1100, clientY: 400 });
    });
    const pin = getCanvasStore(panel.panelId).getState().pins[blockId];
    expect(pin).toBeTruthy();
    expect(Math.abs(pin.y - p.y)).toBeLessThan(30); // 块影跟手（滚轮滚过也不脱手）
  }, 30_000);

  it('开关关掉（挂载后保存）：拖块贴缘不滚，松手仍按判据落钉', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    await saveEdgeScroll(false);
    const block = container?.querySelector<HTMLElement>('.pp-block') ?? null;
    const blockId = block?.getAttribute('data-block-id') ?? '';
    await act(async () => {
      fire(block?.querySelector('.pp-kind') as Element, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 1100, clientY: 780 }); // 下缘带内 + 横向出原位
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200)); // 开着的实现此间会滚几十像素
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(600); // 关了 = 视口不动
    const p = previewXY();
    await act(async () => {
      fire(window, 'mouseup', { clientX: 1100, clientY: 780 });
    });
    const pin = getCanvasStore(panel.panelId).getState().pins[blockId];
    expect(pin).toBeTruthy(); // 落钉判据不受开关影响（只是不滚）
    expect(Math.abs(pin.x - p.x)).toBeLessThan(30);
    expect(Math.abs(pin.y - p.y)).toBeLessThan(30);
  }, 30_000);

  it('灵敏度改感应带宽（行为面）：同一入带深度，0.5x 不起滚、2.0x 起滚', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas); // 1200×800 ⇒ 下缘带 = 800−band 起
    const edgeY = 770; // 距下缘 30px：基准带 36 刚进带；0.5x 带宽 ≈25 进不去；2.0x ≈51 进得去
    const drag = async (): Promise<void> => {
      // 现取块（上一相落钉后 React 重建节点，旧引用派发不进 React 根）
      const el = container?.querySelector<HTMLElement>('.pp-block') ?? null;
      await act(async () => {
        fire(el?.querySelector('.pp-kind') as Element, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
      });
      await act(async () => {
        fire(window, 'mousemove', { clientX: 600, clientY: edgeY });
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 150));
      });
    };
    const release = async (): Promise<void> => {
      await act(async () => {
        fire(window, 'mouseup', { clientX: 600, clientY: edgeY });
      });
    };

    await saveEdgeScroll(true, 0.5);
    await drag();
    expect(useCanvasViewStore.getState().view.panY).toBe(600); // 弱档：带收窄 → 此深度不起滚
    await release();

    await saveEdgeScroll(true, 2);
    await drag();
    expect(useCanvasViewStore.getState().view.panY).toBeLessThan(600); // 强档：带放大 → 同深度起滚
    await release();
  }, 30_000);

  it('拖纸条：贴缘滚屏 + 纸条影跟手，松手写回滚动后的世界位', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    const strip = makeStrip('纸条正文——拖到画布很远处', 200, 200, 480);
    getCanvasStore(panel.panelId).getState().addStrip(strip);
    await act(async () => {});
    const el = () => container?.querySelector<HTMLElement>('.pp-strip') ?? null;
    expect(el()).not.toBeNull();
    await act(async () => {
      fire(el() as Element, 'mousedown', { button: 0, clientX: 300, clientY: 300 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 1100, clientY: 780 }); // 上缘横向 + 下缘入带
    });
    const [, panY1] = await scrollUntil(60);
    expect(600 - panY1).toBeGreaterThan(60); // 滚了
    const dragged = () => container?.querySelector<HTMLElement>('.pp-strip.pp-dragging') ?? el();
    const preview = {
      x: Number.parseFloat(dragged()?.style.left ?? ''),
      y: Number.parseFloat(dragged()?.style.top ?? ''),
    };
    await act(async () => {
      fire(window, 'mouseup', { clientX: 1100, clientY: 780 });
    });
    const after = getCanvasStore(panel.panelId)
      .getState()
      .strips.find((s) => s.id === strip.id)!;
    expect(Math.abs(after.x - preview.x)).toBeLessThan(30); // 落点 = 纸条影所在（滚屏后不跳位）
    expect(Math.abs(after.y - preview.y)).toBeLessThan(30);
  }, 30_000);

  it('抽纸条（lift）拖出：贴缘滚屏 + ghost 跟手，松手在滚动后的世界位成条', async () => {
    await mountCanvas();
    const canvas = container?.querySelector<HTMLDivElement>('.pp-canvas');
    if (!canvas) throw new Error('pp-canvas 未挂载');
    stubCanvasRect(canvas);
    const block = container?.querySelector<HTMLElement>('.pp-block') as HTMLElement;
    // 假选区落在指针下（A 路 mousedown 探针要求指针在选区内）——原地即揭起
    installFakeSelection(false, [{ left: 860, top: 280, right: 940, bottom: 320 }]);
    await act(async () => {
      fire(block, 'mousedown', { button: 0, clientX: 900, clientY: 300 });
    });
    // 揭起手势立即在途：指针移到下缘带内 + 横向出带（成条区）→ 视口自动滚屏
    await act(async () => {
      fire(window, 'mousemove', { clientX: 1100, clientY: 780 });
    });
    const [, panY1] = await scrollUntil(60);
    expect(600 - panY1).toBeGreaterThan(60);
    const ghostOf = (): { x: number; y: number } | null => {
      const g = container?.querySelector<HTMLElement>('.pp-strip-ghost') ?? null;
      if (!g) return null;
      return { x: Number.parseFloat(g.style.left) - 12, y: Number.parseFloat(g.style.top) - 12 };
    };
    const g = ghostOf();
    expect(g).not.toBeNull(); // ghost 随滚滚出的位置复位（不脱手）
    await act(async () => {
      fire(window, 'mouseup', { clientX: 1100, clientY: 780 });
    });
    const strips = getCanvasStore(panel.panelId).getState().strips;
    expect(strips.length).toBe(1); // 成条（zone = strip：横向出带）
    expect(Math.abs(strips[0].x - (g as { x: number }).x)).toBeLessThan(30);
  }, 30_000);

  it('滚轮行为=缩放画布（设置切换）：plain wheel 直接缩放、不再平移', async () => {
    // 预置设置：滚轮行为 = 缩放画布（whimsical 派），再挂载（mount 期同步读设置）
    const s = loadSettings();
    s.canvas = { wheelMode: 'zoom' };
    saveSettings(s);
    await mountCanvas();
    container
      ?.querySelector('.pp-canvas')
      ?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 120, clientX: 600, clientY: 400, bubbles: true, cancelable: true }),
      );
    const v = useCanvasViewStore.getState().view;
    expect(v.zoom).toBeCloseTo(wheelFactor(120), 10); // 缩放路径（平移路径 zoom 不动）
    // 锚光标守恒：屏幕 (600,400) 下的世界点缩放前后不动（zoom 路径特征）
    expect((400 - v.panY) / v.zoom).toBeCloseTo(-200, 6);
  }, 30_000);

  /* ── ⑤ 拖块边缘自动滚屏（2026-09-17 手感批，用户「拖一下→滚→再拖」病灶）──
   * 指针贴视口四缘即持续自动滚屏（RTS 缘滚同族，曲线 = autoPanVector 单一
   * 真源），块影每帧钉回指针下——一次手势可把块送到画布任意远处。 */

  /** jsdom 无布局引擎（rect 恒 0×0 → 边缘带判定失义）：画布 rect 按挂载口径
   *  直写（1200×800 原点左上，与 store 的屏幕坐标同一参照系）。 */
  function stubCanvasRect(el: HTMLElement): void {
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
  }

  /** 拖拽块影世界位（渲染面 transform 解析——「块影跟手」的观测口）。 */
  function previewXY(): { x: number; y: number } {
    const el = container?.querySelector<HTMLElement>('.pp-block.pp-dragging') ?? null;
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el?.style.transform ?? '');
    if (!m) throw new Error(`拖拽块影缺席或 transform 不识别：${el?.style.transform}`);
    return { x: Number(m[1]), y: Number(m[2]) };
  }

  /** 等滚屏攒够位移（rAF 帧数随机器负载浮动——用**等待**代替对速率的断言），
   *  返回 [起值, 现值]。永不达标（没滚）也返回：由调用方的断言判死。 */
  async function scrollUntil(minDelta: number): Promise<[number, number]> {
    const start = useCanvasViewStore.getState().view.panY;
    for (let i = 0; i < 60; i++) {
      if (Math.abs(useCanvasViewStore.getState().view.panY - start) >= minDelta) break;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });
    }
    return [start, useCanvasViewStore.getState().view.panY];
  }

  it('拖块贴画布下缘：视口持续自动滚屏（指针静止也滚 / 横轴未入带不动），松手钉落在块影处', async () => {
    const canvas = await mountCanvas(); // 出发视口 pan(600,600) / zoom 1
    stubCanvasRect(canvas);
    const block = container?.querySelector<HTMLElement>('.pp-block') ?? null;
    const handle = block?.querySelector('.pp-kind') ?? null;
    const blockId = block?.getAttribute('data-block-id') ?? '';
    expect(handle).not.toBeNull();

    await act(async () => {
      fire(handle as Element, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
    });
    // 指针移到下缘带内 + 横向拖出流带（x = 1100：块中心跑到中轴 +500 ⇒ 带外落钉，
    // 见 ⑥ 判据；右缘带自 1164 起，故横轴不入带、不滚），此后**不再移动指针**
    await act(async () => {
      fire(window, 'mousemove', { clientX: 1100, clientY: 780 });
    });
    const [panY0, panY1] = await scrollUntil(60);
    expect(panY0 - panY1).toBeGreaterThan(60); // 贴下缘 → 视口向下追内容（持续滚，非一次性）
    expect(useCanvasViewStore.getState().view.panX).toBe(600); // 横轴未入带：不动

    // 松手仍在带内（指针全程未再移动）：落点与块影同一把尺子 → 钉落在块影处。
    // 容差 30 = 至多两帧滚屏量（滚动中块影 DOM 提交滞后 rAF 帧一帧 ≈11.5px）；
    // 判别力由上一步保证：本轮滚屏 > 60，「块影脱手」病灶的偏差 ≥ 这个量。
    const p = previewXY();
    await act(async () => {
      fire(window, 'mouseup', { clientX: 1100, clientY: 780 });
    });
    const pin = getCanvasStore(panel.panelId).getState().pins[blockId];
    expect(pin).toBeTruthy();
    expect(Math.abs(pin.x - p.x)).toBeLessThan(30);
    expect(Math.abs(pin.y - p.y)).toBeLessThan(30);
    // 钉在画布上：钉块本体在场 + 流内留「已移出」占位
    expect(container?.querySelector('.pp-block.pp-pinned')).not.toBeNull();
    expect(container?.querySelector('.pp-ghost')).not.toBeNull();
  }, 30_000);

  it('已钉块拖到画布上缘：视口向上滚屏，一次手势把钉挪到很上方（落点 = 块影）', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    const flowBlock = container?.querySelector<HTMLElement>('.pp-block') ?? null;
    const blockId = flowBlock?.getAttribute('data-block-id') ?? '';
    // ① 先把块拖出钉住（横向出带 + 指针不在边缘带内 = 不滚；块中心 +500 ⇒ 落钉）
    await act(async () => {
      fire(flowBlock?.querySelector('.pp-kind') as Element, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 1100, clientY: 700 });
    });
    await act(async () => {
      fire(window, 'mouseup', { clientX: 1100, clientY: 700 });
    });
    const pinnedEl = container?.querySelector<HTMLElement>('.pp-block.pp-pinned') ?? null;
    expect(pinnedEl).not.toBeNull();
    const pinY0 = getCanvasStore(panel.panelId).getState().pins[blockId]?.y ?? 0;

    // ② 拖已钉块贴上缘带内：视口向上追内容（panY 增）+ 块影世界 y 一路减小
    await act(async () => {
      fire(pinnedEl?.querySelector('.pp-kind') as Element, 'mousedown', { button: 0, clientX: 300, clientY: 560 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 700, clientY: 20 }); // 上缘带内（20 < 36）
    });
    const [panY0, panY1] = await scrollUntil(150);
    expect(panY1 - panY0).toBeGreaterThan(150);
    const p = previewXY();
    await act(async () => {
      fire(window, 'mouseup', { clientX: 700, clientY: 20 });
    });
    const pin = getCanvasStore(panel.panelId).getState().pins[blockId];
    expect(pin).toBeTruthy();
    expect(Math.abs(pin.x - p.x)).toBeLessThan(30);
    expect(Math.abs(pin.y - p.y)).toBeLessThan(30);
    expect(pin.y).toBeLessThan(pinY0 - 100); // 挪到「很上方」（世界 y 明显更小）
  }, 30_000);

  /* ── ⑥ 松手定夺·判据重写（2026-09-17 用户报「拖出来→挪视口→松手，块没钉上」）──
   * 回槽的语义是「**放回原来那一格**」，旧判据却拿「带」量（`|落点左缘 − 流区中轴|
   * ≤ 400`，纵向无界）——两处病灶都被边缘自动滚屏放大成必现：
   *   ① 横向不对称：720 宽的块，左缘要在中轴 ±400 内 ⇒ 块中心向右得跑 760px 才算
   *      带外（向左只需 40px）——往右拖到桌面上松手仍判「回槽」，静默取消；
   *   ② 纵向无界：横向在带内时纵向往哪拖都算回槽，沿同列滚到纸外松手也被取消。
   * 现判据（`blockReturnsToFlow`）= 横向偏移 ≤ 自身半宽 且 纵向偏移 ≤ 2 块距档，
   * 与渲染面回槽预览态（pp-drag-returning）共用同一函数。 */

  it('回槽判据纯函数（据来源原位量）：小幅回放 = 回槽；搬出半宽/两格之外 = 落钉', () => {
    const flow = { x: -360, y: -600, w: 720 };
    expect(blockReturnsToFlow({ x: -360 + 100, y: -600 + 40, w: 720 }, flow)).toBe(true);
    // 旧判据在此判回槽（块左缘 +140 仍在中轴 ±400 内）——用户病灶
    expect(blockReturnsToFlow({ x: -360 + 500, y: -600, w: 720 }, flow)).toBe(false);
    expect(blockReturnsToFlow({ x: -360, y: -600 + 200, w: 720 }, flow)).toBe(false);
    // 眉批撕出族原位在正文右缘外的眉批栏（世界 x≈384）——据「带」判会误判，据原位判正确
    const sidecar = { x: 384, y: -600, w: 320 };
    expect(blockReturnsToFlow({ x: 384, y: -600, w: 320 }, sidecar)).toBe(true);
    expect(blockReturnsToFlow({ x: 384, y: 100, w: 320 }, sidecar)).toBe(false);
  });

  it('拖块向右出纸（同一列滚屏）+ 松手：落钉在块影处（不再被误判回槽静默取消）', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    const block = container?.querySelector<HTMLElement>('.pp-block') ?? null;
    const blockId = block?.getAttribute('data-block-id') ?? '';
    await act(async () => {
      fire(block?.querySelector('.pp-kind') as Element, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
    });
    // 向右搬出半宽以外（偏 +500）→ 顺手下缘入带滚屏
    await act(async () => {
      fire(window, 'mousemove', { clientX: 1100, clientY: 780 });
    });
    const [, panY1] = await scrollUntil(60);
    const p = previewXY();
    // 预览态不得谎报「回槽」（与松手判据同一函数）
    expect(container?.querySelector('.pp-dragging.pp-drag-returning')).toBeNull();
    await act(async () => {
      fire(window, 'mouseup', { clientX: 1100, clientY: 780 });
    });
    const pin = getCanvasStore(panel.panelId).getState().pins[blockId];
    expect(pin).toBeTruthy(); // 旧判据：块左缘 +140 仍在中轴 ±400 内 → 静默取消，此断言红
    expect(Math.abs(pin.x - p.x)).toBeLessThan(30);
    expect(Math.abs(pin.y - p.y)).toBeLessThan(30);
    expect(pin.y + 0).toBeLessThan(600 - 60); // 钉在滚屏后的世界位（并非回到原槽）
    expect(panY1).toBeLessThan(600);
    expect(container?.querySelector('.pp-block.pp-pinned')).not.toBeNull();
  }, 30_000);

  it('拖块沿同列纵向搬离原位 + 滚屏 + 松手：落钉（旧判据纵向无界 → 误判回槽）', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    // 取最新块（贴近纸下缘，滚一段即离原位）
    const blocks = container?.querySelectorAll<HTMLElement>('.pp-block') ?? [];
    const last = blocks[blocks.length - 1] ?? null;
    const blockId = last?.getAttribute('data-block-id') ?? '';
    await act(async () => {
      fire(last?.querySelector('.pp-kind') as Element, 'mousedown', { button: 0, clientX: 600, clientY: 560 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 600, clientY: 780 }); // 同列向下 + 下缘入带
    });
    const [, panY1] = await scrollUntil(200);
    const p = previewXY();
    await act(async () => {
      fire(window, 'mouseup', { clientX: 600, clientY: 780 });
    });
    const pin = getCanvasStore(panel.panelId).getState().pins[blockId];
    expect(pin).toBeTruthy();
    expect(Math.abs(pin.x - p.x)).toBeLessThan(30);
    expect(Math.abs(pin.y - p.y)).toBeLessThan(30);
    expect(panY1).toBeLessThan(600 - 200);
  }, 30_000);

  it('眉批撕出（原位在正文右缘外的眉批栏）：拖回原位 = 取消拔钉；搬远 = 落钉', async () => {
    await withRenderers(async () => {
      const canvas = await mountCanvas();
      stubCanvasRect(canvas);
      /** 眉批手柄（每段现取：手势后重渲染会换节点，旧引用派发不进 React 根）。 */
      const handle = (): HTMLElement | null => container?.querySelector<HTMLElement>('.pp-marginalia-pin') ?? null;
      const hostBlock = handle()?.closest<HTMLElement>('.pp-block') ?? null;
      const scKey = `${hostBlock?.getAttribute('data-block-id') ?? ''}:sc`;
      const pinsOf = (): Record<string, unknown> => getCanvasStore(panel.panelId).getState().pins;
      expect(handle()).not.toBeNull();
      // ① 拖出一点点就松手（仍在原位上下的容差内）→ 取消：首动建的 `:sc` 快照钉被拔掉
      await act(async () => {
        fire(handle() as Element, 'mousedown', { button: 0, clientX: 900, clientY: 300 });
      });
      await act(async () => {
        fire(window, 'mousemove', { clientX: 940, clientY: 320 });
      });
      expect(pinsOf()[scKey]).toBeTruthy(); // instant 族：首动即建钉（跟手预览就是它）
      await act(async () => {
        fire(window, 'mouseup', { clientX: 940, clientY: 320 });
      });
      expect(pinsOf()[scKey]).toBeUndefined(); // 回到原位 = 拔钉还原（旧判据以「带」量时此处误判）
      expect(container?.querySelector('.pp-marginalia-out')).toBeNull();
      // ② 搬远（纵向 300px > 2 块距档）→ 落钉：快照钉留在画布上
      expect(handle()).not.toBeNull();
      await act(async () => {
        fire(handle() as Element, 'mousedown', { button: 0, clientX: 900, clientY: 300 });
      });
      await act(async () => {
        fire(window, 'mousemove', { clientX: 900, clientY: 600 });
      });
      await act(async () => {
        fire(window, 'mouseup', { clientX: 900, clientY: 600 });
      });
      expect(pinsOf()[scKey]).toBeTruthy();
    });
  }, 30_000);

  it('拖块回纸内松手：回槽取消（判据修正不得把「放回原处」一起拆掉）', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    const block = container?.querySelector<HTMLElement>('.pp-block') ?? null;
    const blockId = block?.getAttribute('data-block-id') ?? '';
    await act(async () => {
      fire(block?.querySelector('.pp-kind') as Element, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
    });
    // 先拖出纸外（不回槽态），再拖回纸内（回槽态亮起）
    await act(async () => {
      fire(window, 'mousemove', { clientX: 1100, clientY: 300 });
    });
    expect(container?.querySelector('.pp-dragging.pp-drag-returning')).toBeNull();
    await act(async () => {
      fire(window, 'mousemove', { clientX: 600, clientY: 300 });
    });
    expect(container?.querySelector('.pp-dragging.pp-drag-returning')).not.toBeNull();
    await act(async () => {
      fire(window, 'mouseup', { clientX: 600, clientY: 300 });
    });
    // 回槽：无钉、无 ghost、块仍在流里
    expect(getCanvasStore(panel.panelId).getState().pins[blockId]).toBeUndefined();
    expect(container?.querySelector('.pp-ghost')).toBeNull();
    expect(container?.querySelector('.pp-block.pp-pinned')).toBeNull();
    expect(container?.querySelector('.pp-block.pp-dragging')).toBeNull();
  }, 30_000);

  /* ── ⑧ 顶部浮件（2026-09-17 标题栏拆除批）──
   * 病灶：旧书眉 `.pp-topbar` 是 **56px 布局行**，把画布顶缘从窗口顶推开 ⇒
   * 边缘滚动最自然的动作（指针甩到屏顶）永远落在书眉上，悬停判据（须落在画布内）
   * 直接否掉——上缘在用户视角里等于没有边缘滚动。修法：书眉整条退役，控制件落成
   * 右上**一枚覆盖件浮件**（`.pp-canvas` 的兄弟、不进布局流），画布铺满整窗。
   * 本段考三件：① 结构（浮件在画布之外、书眉不存）；② 行为（屏顶那 36px 落在
   * 画布上 = 滚；浮件之上 = 不滚）；③ 控制件没丢（缩放/设置/回首页/窗口钮全在
   * 浮件里，且浮件的非交互件仍是窗口拖动热区）。 */

  it('结构：书眉布局行退役，画布铺满整窗，浮件是画布的兄弟（覆盖件）', async () => {
    const canvas = await mountCanvas();
    expect(container?.querySelector('.pp-topbar')).toBeNull();
    const chrome = container?.querySelector<HTMLElement>('.pp-chrome') ?? null;
    expect(chrome).not.toBeNull();
    // ⚠ 悬停判据据「画布本体」量（canvas.contains(target)）：浮件必须不在画布 DOM 内
    expect(canvas.contains(chrome)).toBe(false);
    // 控制件一件不少（书眉退役 = 搬家，不是删除）
    expect(chrome?.querySelector('.pp-zoom-ctl')).not.toBeNull();
    expect(chrome?.querySelector('.pp-settings')).not.toBeNull();
    expect(chrome?.querySelector('.pp-close')).not.toBeNull();
    expect(chrome?.querySelector('.wc-btns')).not.toBeNull();
    expect(chrome?.textContent).toContain('回首页');
  }, 30_000);

  it('上缘：指针甩到屏顶（画布顶缘 = 屏缘）→ 视口自己滚；同一姿态落在浮件上不滚', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas); // rect top 0 = 画布铺满整窗（本批口径）
    await saveEdgeScroll(true, 1, true);
    const chrome = container?.querySelector<HTMLElement>('.pp-chrome') ?? null;
    // ① 浮件之上（右上那枚覆盖件）：不滚——它是「别的面」，不是画布本体
    await act(async () => {
      fire(chrome as Element, 'mousemove', { clientX: 900, clientY: 20, bubbles: true });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250)); // 驻留期满仍不该起滚
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(600);
    // ② 同一 Y 落在画布上（屏顶带内）：起滚（旧书眉时这一点在书眉 DOM 里，永不生效）
    await act(async () => {
      fire(canvas, 'mousemove', { clientX: 600, clientY: 20 });
    });
    const [start, panY1] = await scrollUntil(30);
    expect(panY1 - start).toBeGreaterThan(30); // 上缘滚 = 内容向下让出（panY 增）
  }, 30_000);

  it('浮件的非交互件（`画布` 二字）是窗口拖动热区；交互件（按钮）不吃拖窗口', async () => {
    await mountCanvas();
    const invoke = vi.fn(async () => null);
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      invoke,
    };
    try {
      const title = container?.querySelector('.pp-chrome .pp-title') ?? null;
      const settings = container?.querySelector('.pp-chrome .pp-settings') ?? null;
      expect(title).not.toBeNull();
      await act(async () => {
        fire(title as Element, 'pointerdown', { bubbles: true, button: 0 });
      });
      expect(invoke).toHaveBeenCalledWith('plugin:window|start_dragging', { label: 'main' });
      invoke.mockClear();
      await act(async () => {
        fire(settings as Element, 'pointerdown', { bubbles: true, button: 0 });
      });
      expect(invoke).not.toHaveBeenCalled(); // 交互件自己接手势（窗口拖拽热区豁免）
      // 双击抓手 = 最大化/还原
      await act(async () => {
        fire(title as Element, 'dblclick', { bubbles: true });
      });
      expect(invoke).toHaveBeenCalledWith('plugin:window|toggle_maximize', { label: 'main' });
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  }, 30_000);

  /* ── ⑨ 回锚认卷（2026-09-17 用户报「点开工作区/按回锚就空白，啥也不渲染」）──
   * 病灶：`viewForAnchor(w,h)` 把**世界原点 (0,0)** 对到屏幕锚位；而卷锚
   * （= 该卷最新块底边，流向上长）会随内容向上漂——用户三卷的锚点实测都在
   * -28,700 上下 ⇒ 按原点落锚 = 视口落在卷外 28,700px 的空白桌面
   * （CDP 实测：Home 之后视口世界区间 [-2045, 151]，卷内容在 ≤ -28,630）。
   * 本段考：落位/回锚必须认**活跃卷**，而卷远在原点之外时仍看得见卷。 */

  /** 键（Home 等）——与 ④ 段同款：window 级 keydown，cancelable 让处理器能 preventDefault。 */
  const keyOf = (k: string, init: KeyboardEventInit = {}): void => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init }));
  };
  /** 视口世界区间 + 视口内可见块数（用户的症状判据：卷在不在眼前）。 */
  function viewportWorldAndVisibleBlocks(): { y0: number; y1: number; visible: number } {
    const v = useCanvasViewStore.getState().view;
    const y0 = (0 - v.panY) / v.zoom;
    const y1 = (800 - v.panY) / v.zoom; // stubCanvasRect 的 800 高
    const visible = [...(container?.querySelectorAll('.pp-block') ?? [])].filter((e) => {
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec((e as HTMLElement).style.transform || '');
      if (!m) return false;
      const y = Number(m[2]);
      return y > y0 && y < y1;
    }).length;
    return { y0, y1, visible };
  }

  it('回锚：卷锚远离原点时（记 -28700），Home 之后仍必须看得见活跃卷', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    // 复现用户现场：活跃卷的锚点在离原点 28,700 的世界坐标（内容向上长）
    await act(async () => {
      getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: 0, anchorY: -28700, width: 720 });
    });
    await act(async () => {
      keyOf('Home');
    });
    const { y0, y1, visible } = viewportWorldAndVisibleBlocks();
    expect(
      visible,
      `回锚后视口世界区间 [${Math.round(y0)}, ${Math.round(y1)}] 内一块都没有 = 用户看到的空白`,
    ).toBeGreaterThan(0);
    // 卷锚（最新块底边）应落在视口内：D-R1-3「最新块贴视口下缘」
    expect(-28700).toBeGreaterThanOrEqual(y0);
    expect(-28700).toBeLessThanOrEqual(y1);
  }, 30_000);

  it('回锚：卷锚就在原点时，落位与旧口径一致（世界原点对到屏幕锚位）', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    await act(async () => {
      getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: 0, anchorY: 0, width: 720 });
    });
    await act(async () => {
      keyOf('Home');
    });
    const v = useCanvasViewStore.getState().view;
    expect(v.panX).toBe(600); // 视口宽 1200 / 2
    expect(v.panY).toBe(800 - 96); // 视口高 − 锚点 margin（ANCHOR.screenBottomMargin）
  }, 30_000);

  /* ── ⑩ 失控滚屏的兜底（2026-09-17 与回锚同批查出的第二条病灶）──
   * 四个手势族（拖块 / 拖纸条 / 抽纸条 / 拖选）的帧循环**只认 mouseup**：窗口失焦、
   * 在窗外松手、切走应用都会让 mouseup 永远不来 ⇒ 循环带着最后一个指针位置无限滚
   * （CDP 实测：悬停档 1,444 px/s 线性无衰减，拖拽族同理）。悬停档早已在
   * blur / mouseleave 收手，拖拽族没有——本用例钉住「失焦即收」。 */
  it('拖块手势在窗口失焦（mouseup 丢失）后必须停滚，不得自己一直滚', async () => {
    const canvas = await mountCanvas();
    stubCanvasRect(canvas);
    await saveEdgeScroll(true, 1);
    const block = container?.querySelector<HTMLElement>('.pp-block') ?? null;
    const handle = block?.querySelector('.pp-kind') ?? null;
    expect(handle).not.toBeNull();
    await act(async () => {
      fire(handle as Element, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
    });
    // 指针推进下缘带 → 起滚（此后不再移动指针，也不会有 mouseup）
    await act(async () => {
      fire(window, 'mousemove', { clientX: 600, clientY: 780 });
    });
    const [, panMoving] = await scrollUntil(40);
    expect(600 - panMoving).toBeGreaterThan(40); // 确实在滚（断言不为空转）
    // 窗口失焦 = mouseup 永远不来的那条路
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    const settled = useCanvasViewStore.getState().view.panY;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(settled); // 停了
  }, 30_000);
});
