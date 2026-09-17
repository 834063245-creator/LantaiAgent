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
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
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
   *  注入 caretRangeFromPoint（Chromium 面——jsdom 缺席，延伸链路要它）。 */
  function installFakeSelection(collapsed: boolean): { extend: ReturnType<typeof vi.fn> } {
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
    // 探针（pointInSelectionRects）会炸成未处理错误。补空实现：空矩形集 =
    // 指针不在选区内 → A 路短路（本测试只考自动滚屏，不混 lift 手势）。
    (range as Range & { getClientRects?: () => DOMRectList }).getClientRects = () => [] as unknown as DOMRectList;
    (range as Range & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
    const extend = vi.fn();
    const fake = {
      isCollapsed: collapsed,
      rangeCount: collapsed ? 0 : 1,
      anchorNode: textNode,
      anchorOffset: 0,
      getRangeAt: () => range,
      extend,
      removeAllRanges: () => {},
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
    // 指针移到下缘带内（x = 250 不入左右带），此后**不再移动指针**——滚动
    // 全靠 rAF 循环（「指针静止在带内也滚」= 本用例的考点）
    await act(async () => {
      fire(window, 'mousemove', { clientX: 250, clientY: 780 });
    });
    const [panY0, panY1] = await scrollUntil(60);
    expect(panY0 - panY1).toBeGreaterThan(60); // 贴下缘 → 视口向下追内容（持续滚，非一次性）
    expect(useCanvasViewStore.getState().view.panX).toBe(600); // 横轴未入带：不动

    // 松手仍在带内（指针全程未再移动）：落点与块影同一把尺子 → 钉落在块影处。
    // 容差 30 = 至多两帧滚屏量（滚动中块影 DOM 提交滞后 rAF 帧一帧 ≈11.5px）；
    // 判别力由上一步保证：本轮滚屏 > 60，「块影脱手」病灶的偏差 ≥ 这个量。
    const p = previewXY();
    await act(async () => {
      fire(window, 'mouseup', { clientX: 250, clientY: 780 });
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
    // ① 先把块拖出钉住（横向出带 → 落钉；指针不在带内 = 不滚）
    await act(async () => {
      fire(flowBlock?.querySelector('.pp-kind') as Element, 'mousedown', { button: 0, clientX: 600, clientY: 300 });
    });
    await act(async () => {
      fire(window, 'mousemove', { clientX: 250, clientY: 700 });
    });
    await act(async () => {
      fire(window, 'mouseup', { clientX: 250, clientY: 700 });
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
});
