// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 匣脚引线（2026-09-22）行为考官：挂**真实 PaperPanel** 穿全层（同 session-tree-canvas
// 与 paper-composer-float 两个 harness 的合体——真卷真盘 + 真坞槽实测）。
//
// 考的是那条线在用户操作序列下的行为，不是几何常量（常量在 paper-provenance /
// composer-float 两处纯函数考官里）：
//   ① 两端真的扎在实体上：起笔 = 坞顶左端那枚**版口钮**（槽实测几何算得），
//      收笔 = 活卷的**纸脚**（版心左缘 × 卷底边，世界坐标投到屏上）；卷端落点必须在
//      卷首底线**之下**（2026-09-22 二版：用户判一版接在天头钮上「挂在第一条用户输入
//      那不是乱了套了」——天头那枚是活跃标记，不是位置标记）；
//   ② 切卷 ⇒ 线改指（种子随卷换，笔道整条重画）；
//   ③ 坞被拖走 ⇒ 线随坞（锚点是槽主人的几何，不是写死的坞位）；
//   ④ 无活卷 / 案头态 ⇒ **不画线**；活卷在屏外 ⇒ 线照样出屏（方向即来路）；
//   ⑤ **纯指示·不可点**（2026-09-24 归因更正）：层内没有任何可命中/可聚焦的子件——
//      线不吃指针、不进 Tab 序、整层 aria-hidden（线只指示「这一匣对着这一卷」，不是控件）。
//      退役留痕：本文件原有第 7 例「点线 = 溯源（飞到活卷纸脚）」随受墨带**同批删除**
//      ——行为退役 ⇒ 测试同批删除，不改造后放回原位。归因与答复见
//      `docs/plans/paper-shell/taste-ledger.md` 2026-09-24 条（用户：「我从来也没有拍板过
//      引线本体要做成按钮」）。
//
// 注：「活卷在场上但流区缺席」在本架构里只存在于**落位 effect 之前那一帧**（会话集 =
// 摊开会话集，落位 effect 幂等补齐），故它不做行为用例——那是 memo 里的防御分支。

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

/** jsdom 无 ResizeObserver：记录实例 + 只对**创作坞槽**按需 flush（量坞实测宽高）。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  private cb: () => void;
  private el: Element | null = null;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.el = el;
  }
  unobserve(): void {}
  disconnect(): void {}
  static flushComposerSlot(): void {
    for (const i of FakeResizeObserver.instances) {
      if (i.el?.classList.contains('pp-composer-slot')) i.cb();
    }
  }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { worldToScreen } from '../src/paper/canvas-math';
import { COMPOSER_POS_KEY } from '../src/plugins/builtin/paper-shell/composer-float';
import { folioHeadWidthFor, measureFolioHeadHeight } from '../src/plugins/builtin/paper-shell/measure';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { volumeDisplayName } from '../src/state/volume-name';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}
function asstMsg(id: string, text: string, respondingTo: string): AssistantMessage {
  return {
    role: 'assistant',
    _id: id,
    parts: [{ type: 'text', text, finalised: true }],
    status: 'done',
    respondingTo,
  };
}
/** 一卷两轮的最小对话（块进流 ⇒ 流区有几何）。 */
function volume(tag: string): ChatMessage[] {
  return [
    userMsg(`u-${tag}-0`, `${tag} 轮来文——足够长的一段，贴真实对话长度。`),
    asstMsg(`a-${tag}-0`, `${tag} 轮回复正文。`, `u-${tag}-0`),
    userMsg(`u-${tag}-1`, `第二轮来文。`),
    asstMsg(`a-${tag}-1`, `第二轮回复。`, `u-${tag}-1`),
  ];
}

describe('匣脚引线（坞的版口钮 → 活卷的纸脚）', () => {
  let panel: ChatCore;
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  /* jsdom 视口 = 坞位/锚点的坐标基准（组件读的就是 window.innerWidth/Height）。 */
  const VW = window.innerWidth;
  const VH = window.innerHeight;
  const DOCK_W = 880;
  const DOCK_H = 110;
  /** 坞顶左端版口钮：悬在坞顶线上 3px、高 3px（字面量镜像见 composer-float.test）。 */
  const TICK_TOP = -3;
  const TICK_H = 3;
  /* 两卷都在场（卷 1 在 x=0、卷 2 在 x=900——视口 1024 宽@zoom1 下双双可见，
   * 故两卷的渲染面几何都读得回），活跃卷 = 卷 2。 */
  const REGION_X = [0, 900];
  const VIEW = { zoom: 1, panX: -260, panY: 600 };

  beforeEach(() => {
    localStorage.clear();
    FakeResizeObserver.instances = [];
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/dock-tether-ws' });
    useDockStore.getState().closePanel('paper');
    useCanvasViewStore.setState({
      view: VIEW,
      canvasSize: { w: VW, h: VH },
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
  });

  /** 挂纸壳：两卷（默认都在场），活跃卷按参；`dockPos` 非空 = 坞被拖到该位
   *  （写 localStorage，挂载即读回）。返回坞槽元素（锚点几何由它的实测矩形算）。 */
  async function mount(opts: {
    sessions?: Array<{ id: number; label: string }>;
    activeIdx?: number;
    dockPos?: { left: number; bottom: number };
  }): Promise<HTMLDivElement> {
    const sessions = opts.sessions ?? [
      { id: 1, label: '卷一' },
      { id: 2, label: '卷二' },
    ];
    if (opts.dockPos) localStorage.setItem(COMPOSER_POS_KEY, JSON.stringify(opts.dockPos));
    panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    getChatStore(panel.panelId).sess.setState({
      sessions,
      activeIdx: opts.activeIdx ?? 1,
      nextSessionId: 3,
    });
    for (const s of sessions)
      msgStoreFor(panel.panelId, s.id)
        .getState()
        .setMessages(volume(`v${s.id}`));
    const canvas = getCanvasStore(panel.panelId).getState();
    for (const s of sessions) {
      canvas.setRegion(String(s.id), { anchorX: REGION_X[s.id - 1] ?? 0, anchorY: 0, width: 720 });
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
    await act(async () => {
      useCanvasViewStore.getState().setCanvasSize(VW, VH);
    });
    await act(async () => {
      useCanvasViewStore.getState().setView((v) => ({ ...v, ...VIEW }));
    });
    const slot = container.querySelector('.pp-composer-slot') as HTMLDivElement;
    expect(slot).not.toBeNull();
    // 坞槽实测矩形（jsdom 无布局：RO 桩 + 实例方法覆盖）——默认位或用户摆过的位
    const left = opts.dockPos?.left ?? (VW - DOCK_W) / 2;
    const bottom = opts.dockPos?.bottom ?? 96;
    slot.getBoundingClientRect = () =>
      ({
        left,
        top: VH - bottom - DOCK_H,
        right: left + DOCK_W,
        bottom: VH - bottom,
        width: DOCK_W,
        height: DOCK_H,
        x: left,
        y: VH - bottom - DOCK_H,
        toJSON: () => ({}),
      }) as DOMRect;
    await act(async () => {
      FakeResizeObserver.flushComposerSlot();
    });
    return slot;
  }

  /** 坞侧锚点（屏幕坐标）= 坞顶左端版口钮的起端中点。 */
  function dockAnchor(slot: HTMLDivElement): { x: number; y: number } {
    const r = slot.getBoundingClientRect();
    return { x: r.left, y: r.top + TICK_TOP + TICK_H / 2 };
  }

  /** 某卷的**卷侧锚点**（世界坐标）= 卷的**纸脚**（版心左缘 × 卷底边）。
   *  几何从渲染面读回：流区盒 `left/width` + `top/height`（盒高 = 卷首高 + 流区高
   *  ⇒ `top + height` 即纸的材料底缘，不必另量卷首高）；版心宽走 `measure`
   *  （与组件同一把尺子）。 */
  function regionFoot(sid: number): { x: number; y: number } {
    const el = container?.querySelector<HTMLElement>(`.pp-region[data-session-id="${sid}"]`);
    if (!el) throw new Error(`卷 ${sid} 的流区不在渲染面`);
    const width = Number.parseFloat(el.style.width);
    const left = Number.parseFloat(el.style.left);
    const footY = Number.parseFloat(el.style.top) + Number.parseFloat(el.style.height);
    return { x: left + (width - folioHeadWidthFor(width)) / 2, y: footY };
  }

  /** 某卷的**卷首底线**（世界 y）= 流区盒顶 + 卷首高（measure 同一把尺子）——
   *  用来钉「卷端落点在天头之下」，即线不经过卷首与第一条来文那一带。 */
  function regionTopOf(sid: number): number {
    const el = container?.querySelector<HTMLElement>(`.pp-region[data-session-id="${sid}"]`);
    if (!el) throw new Error(`卷 ${sid} 的流区不在渲染面`);
    const width = Number.parseFloat(el.style.width);
    const label =
      getChatStore(panel.panelId)
        .sess.getState()
        .sessions.find((s) => s.id === sid)?.label ?? '';
    return Number.parseFloat(el.style.top) + measureFolioHeadHeight(volumeDisplayName(label, sid), width);
  }

  function layer(): Element | null {
    return container?.querySelector('.pp-dock-layer') ?? null;
  }

  it('两端扎在实体上：起笔 = 坞顶左端版口钮，收笔 = 活卷纸脚（版心左缘 × 卷底边）', async () => {
    const slot = await mount({});
    const v = useCanvasViewStore.getState().view;
    const foot = regionFoot(2);
    const dock = dockAnchor(slot);

    const bead = layer()?.querySelector('.pp-tether-bead');
    const origin = layer()?.querySelector('.pp-tether-origin');
    expect(bead).not.toBeNull();
    expect(origin).not.toBeNull();
    // 收笔 = 活卷纸脚（世界坐标投到屏上落墨）——**不落在任何一块字上**
    expect(Number(bead?.getAttribute('cx'))).toBeCloseTo(worldToScreen(v, foot.x, foot.y).x, 6);
    expect(Number(bead?.getAttribute('cy'))).toBeCloseTo(worldToScreen(v, foot.x, foot.y).y, 6);
    // 起笔 = 坞的版口钮（坞位 + 坞实测尺寸算得）——**不留白**：笔道首点就是锚点
    expect(Number(origin?.getAttribute('cx'))).toBeCloseTo(dock.x, 6);
    expect(Number(origin?.getAttribute('cy'))).toBeCloseTo(dock.y, 6);
    const m = /^M (-?[\d.]+) (-?[\d.]+)/.exec(layer()?.querySelector('.pp-tether')?.getAttribute('d') ?? '');
    expect(Number(m?.[1])).toBeCloseTo(dock.x, 6);
    expect(Number(m?.[2])).toBeCloseTo(dock.y, 6);
    // 卷端落点在天头**之下**：整条线在纸脚那一层以下，不经过卷首/第一条来文那一带
    // （2026-09-22 二版：用户判一版「挂在第一条用户输入」乱了套）
    const folioBottom = worldToScreen(v, foot.x, regionTopOf(2)).y;
    expect(Number(bead?.getAttribute('cy'))).toBeGreaterThan(folioBottom);
    // 纯指示（2026-09-24 归因更正）：层内没有可命中/可聚焦的子件（受墨带已摘除），
    // 整层不进无障碍树——线只是把「这一匣对着这一卷」画出来
    expect(layer()?.querySelector('[role="button"], [tabindex]')).toBeNull();
    expect(layer()?.getAttribute('aria-hidden')).toBe('true');
  }, 30_000);

  it('切卷 ⇒ 线改指（同一支笔重画；种子随卷换 = 同卷恒同线、异卷异线）', async () => {
    await mount({});
    const v = useCanvasViewStore.getState().view;
    const before = layer()?.querySelector('.pp-tether')?.getAttribute('d') ?? '';
    const beadBefore = layer()?.querySelector('.pp-tether-bead')?.getAttribute('cx');
    await act(async () => {
      getChatStore(panel.panelId).sess.setState({ activeIdx: 0 }); // 活跃换到卷 1
    });
    const after = layer()?.querySelector('.pp-tether')?.getAttribute('d') ?? '';
    const beadAfter = layer()?.querySelector('.pp-tether-bead')?.getAttribute('cx');
    expect(beadAfter).not.toBe(beadBefore);
    expect(after).not.toBe(before);
    // 改指后收笔落在**卷 1** 的纸脚上
    const foot1 = regionFoot(1);
    expect(Number(beadAfter)).toBeCloseTo(worldToScreen(v, foot1.x, foot1.y).x, 6);
  }, 30_000);

  it('坞被拖走 ⇒ 线随坞（锚点是槽主人的几何，不是写死的坞位）', async () => {
    const pos = { left: 40, bottom: 300 };
    const slot = await mount({ dockPos: pos });
    const origin = layer()?.querySelector('.pp-tether-origin');
    const dock = dockAnchor(slot);
    expect(dock.x).toBe(40);
    expect(Number(origin?.getAttribute('cx'))).toBeCloseTo(dock.x, 6);
    expect(Number(origin?.getAttribute('cy'))).toBeCloseTo(VH - pos.bottom - DOCK_H + TICK_TOP + TICK_H / 2, 6);
  }, 30_000);

  it('无活卷（activeIdx = −1）⇒ 不画线（宁可没有线，也不指错）', async () => {
    await mount({ activeIdx: -1 });
    expect(layer()).toBeNull();
  }, 30_000);

  it('案头态（零摊开卷）⇒ 不画线（匣退、版口钮本就不画）', async () => {
    await mount({ sessions: [] });
    expect(layer()).toBeNull();
    expect(container?.querySelector('.pp-composer-slot')?.className).toContain('pp-at-desk');
  }, 30_000);

  it('活卷在屏外 ⇒ 线照样出屏（方向即来路，与枝边/出处引导同款判据）', async () => {
    await mount({});
    const v = useCanvasViewStore.getState().view;
    const foot = regionFoot(2);
    expect(worldToScreen(v, foot.x, foot.y).x).toBeGreaterThan(0); // 视口内
    // 视口挪走（卷 2 整卷出屏）：几何仍在场（卸载余量内）⇒ 线仍在，朱点出屏
    await act(async () => {
      useCanvasViewStore.getState().setView((cur) => ({ ...cur, panX: 600, panY: 600 }));
    });
    const bead = layer()?.querySelector('.pp-tether-bead');
    expect(bead).not.toBeNull();
    // 朱点落在视口右缘之外（世界 ~556 × pan 600）——线仍在，只是出了屏
    expect(Number(bead?.getAttribute('cx'))).toBeGreaterThan(VW);
  }, 30_000);
});
