// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 目次带 × 书眉（＝窗口标题栏）几何守护 —— 2026-09-14 用户报「标题栏的操作
// 范围和目次带的鼠标操作范围打架了」。
//
// 现场（实机量测）：书眉 .pp-topbar 占 y ∈ [0, 56) 且 -webkit-app-region:
// drag（整条是窗口拖动带，命中一律归它）；目次带 .pp-toc 是通栏 fixed
// （top:0/bottom:0），映射区顶原为书眉下缘 56——而刻痕盒 top = stripY − 4
// （盒高 8、刻位居中），于是最上一枚刻痕有 4px 越过书眉下缘：那 4px 点下去
// 不是跳刻痕而是拖窗口，视觉上还被书眉压住半截。
// 修法（单一几何真源）：映射区顶 = 书眉下缘 + 刻痕半高；带内一切（墨迹
// canvas / 刻痕 / 滑块 / 未读区 / hover 索引）共用它——无一元素越界。
// 另：带外按下不再响应（此前坞下装饰带一点就把视口拽走）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pretext 全 mock（jsdom 无 Canvas 2D——同 paper-ink.test.ts 口径）：目次带
// canvas 指纹与 hover 索引都要走 inkForBlock，真实 measure 在 jsdom 里必炸。
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _segs: true })),
  walkLineRanges: vi.fn(
    (_prepared: unknown, _width: number, onLine: (line: { width: number; start: unknown; end: unknown }) => void) => {
      onLine({ width: 100, start: null, end: null });
      return 1;
    },
  ),
  materializeLineRange: vi.fn(() => ({ text: '测试行', width: 100, start: null, end: null })),
  measureNaturalWidth: vi.fn(() => 200),
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 1, maxLineWidth: 100 })),
}));

import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { createInkCache } from '../src/paper/ink';
import {
  PaperDockContext,
  type PaperDockContextValue,
  PaperRegionContext,
  type PaperRegionContextValue,
} from '../src/paper/overlay-context';
import type { RegionView } from '../src/paper/region-view';
import { MARK_HALF, STRIP_TOP, TOC_TOP, TocStrip } from '../src/plugins/builtin/compose-dock/TocStrip';
import { useCanvasViewStore } from '../src/state/canvas-view-store';

/** 流区夹具：2000 世界高、三枚 user 刻痕——最旧块顶 = regionTop，于是最上
 *  一枚刻痕正好落在映射区顶（「刻痕顶到书眉」的边界现场）。 */
function fakeRegion(): RegionView {
  const blocks: SourcedBlock[] = [];
  const flowGeom: RegionView['flowGeom'] = [];
  const layout = new Map<string, { x: number; y: number }>();
  for (const [i, y] of [-2000, -1000, -100].entries()) {
    const b = createBlock('user', { text: `第 ${i + 1} 轮来文` }, { messageId: 'm', part: null });
    blocks.push(b);
    flowGeom.push({ id: b.id, y, h: 100, x: -720, w: 1440 });
    layout.set(b.id, { x: -720, y });
  }
  return {
    sessionId: '1',
    sessionNum: 1,
    label: '案卷一',
    anchor: { anchorX: 0, anchorY: 0, width: 1440 },
    blocks,
    layout,
    flowGeom,
    pinnedGeom: [],
    flowWindow: { first: 0, lastExcl: blocks.length },
    visibleIds: new Set(blocks.map((b) => b.id)),
    seq: new Map(),
    regionTop: -2000,
    regionBottom: 0,
    regionHeight: 2400,
    folioH: 120,
    units: [],
    stageLeadIds: new Set(),
    unitLeadIds: new Set(),
    verifyDoneIds: new Set(),
    writingBlockId: null,
  };
}

/** 视口覆盖全内容 → 滑块 fit 态（不可拖）——本文件只测带外/带内的按下判据，
 *  不借拖拽路径（点带即跳已由 stage4-toc 纯几何覆盖）。 */
const VIEW_RECT = { x0: -4000, y0: -4000, x1: 4000, y1: 0 };
const CANVAS_SIZE = { w: 1200, h: 1000 };
const COMPOSER_HEIGHT = 130;
/** 书眉下缘（页面坐标）= tokens.css --bar-h 字面量镜像——jsdom 不加载 tokens.css，
 *  测试侧按字面钉死（越界判据的基准，不许跟着实现漂）。 */
const BAR_H = 56;
/** 映射区底 = 书眉下缘 + 画布区高 − 坞抬高 − 坞高（与组件内同式）。 */
const MAPPED_BOTTOM = BAR_H + CANVAS_SIZE.h - 96 - COMPOSER_HEIGHT;

function regionContext(): PaperRegionContextValue {
  return {
    regions: [fakeRegion()],
    activeSessionId: '1',
    viewRect: VIEW_RECT,
    canvasSize: CANVAS_SIZE,
    composerHeight: COMPOSER_HEIGHT,
    foldedOf: () => false,
    minimap: { content: { x0: -720, y0: -2000, x1: 720, y1: 0 }, geo: [] },
    inkCache: createInkCache(),
  };
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  flyToPoint: vi.fn(),
  glideTo: vi.fn(),
};

describe('目次带 × 标题栏（映射区不越界 + 带外不响应）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useCanvasViewStore.getState().setView({ panX: 0, panY: 0, zoom: 1 });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function mount(): Promise<void> {
    const ctx = regionContext();
    await act(async () => {
      root?.render(
        createElement(
          PaperDockContext.Provider,
          { value: DOCK_CONTEXT },
          createElement(PaperRegionContext.Provider, { value: ctx }, createElement(TocStrip)),
        ),
      );
    });
  }

  /** 按下（jsdom 无 PointerEvent 构造器：MouseEvent 同型即触发 React onPointerDown；
   *  fit 态不走 pointer capture，故不需要捕获桩）。 */
  function pointerDown(el: Element, clientY: number): void {
    act(() => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientY }));
    });
  }

  it('刻痕与滑块整枚落在书眉下缘之下（y ≥ --bar-h）——最上一枚刻痕不得越界', async () => {
    await mount();
    const marks = [...container!.querySelectorAll('.pp-toc-mark')] as HTMLElement[];
    expect(marks).toHaveLength(3);
    const tops = marks.map((m) => Number.parseFloat(m.style.top));
    // 最上一枚刻痕盒顶 = STRIP_TOP − MARK_HALF ≥ 书眉下缘（旧实现 = 下缘 − 4：
    // 那 4px 命中归书眉＝拖窗口，点刻痕点不中，视觉还被书眉压掉半截）
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(BAR_H);
    // 映射区顶就是「书眉下缘 + 刻痕半高」（带内一切共用此真源，非巧合值）
    expect(STRIP_TOP).toBe(TOC_TOP + MARK_HALF);
    expect(STRIP_TOP - MARK_HALF).toBeGreaterThanOrEqual(BAR_H);
    const slider = container!.querySelector('.pp-toc-slider') as HTMLElement;
    expect(Number.parseFloat(slider.style.top)).toBeGreaterThanOrEqual(STRIP_TOP);
  });

  it('带内按下 = 跳视口；书眉带（y < 下缘）与坞下装饰带按下一律不响应', async () => {
    await mount();
    const nav = container!.querySelector('.pp-toc') as HTMLElement;
    const before = useCanvasViewStore.getState().view.panY;

    // 书眉带（y = 50 < 56）：命中本属标题栏拖动带，目次带不得顺手拽走视口
    pointerDown(nav, BAR_H - 6);
    expect(useCanvasViewStore.getState().view.panY).toBe(before);

    // 坞下装饰带（映射区底之下）：无语义，按下同样不响应
    pointerDown(nav, MAPPED_BOTTOM + 40);
    expect(useCanvasViewStore.getState().view.panY).toBe(before);

    // 带内：点带即跳照旧生效（断言不为空转）
    pointerDown(nav, BAR_H + 300);
    expect(useCanvasViewStore.getState().view.panY).not.toBe(before);
  });
});
