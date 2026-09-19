// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 目次带 × 屏顶 几何守护 —— 2026-09-14 用户报「标题栏的操作范围和目次带的
// 鼠标操作范围打架了」（当时修法 = 带体整体下移到书眉下缘）；**2026-09-17
// 标题栏拆除批**：书眉整条退役，那 56px 下移随之取消——带体回到屏顶 top: 0，
// 带体坐标 = 页面坐标。本文件守护的几何不变量（不随书眉在否而变）：
//   ① 映射区顶 = 带体顶 + 刻痕半高（刻痕盒 top = stripY − 4 不越出带体）；
//   ② 带内一切（刻痕盒 / 阶段锚盒 / 滑块 / hover 卡）恒 top ≥ 0；
//   ③ 映射区外（带顶半高留白 / 坞下装饰带）按下不响应。
// 病史（2026-09-14 实机量测）：带体曾是通栏 fixed（top:0/bottom:0），最上一枚
// 刻痕盒那 4px 落在当时的书眉（-webkit-app-region: drag）拖动带里——点刻痕
// 变成拖窗口，视觉上还被书眉压住半截。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import {
  anchorBoxTop,
  cardAnchorFor,
  MARK_HALF,
  STRIP_TOP,
  TOC_CARD_FLIP_Y,
  TOC_COL_W,
  TOC_RUNWAY_W,
  TOC_TOP,
  TOC_W,
  TocStrip,
} from '../src/plugins/builtin/compose-dock/TocStrip';
import { EDGE_SCROLL } from '../src/plugins/builtin/paper-shell/edge-scroll';
import { useCanvasViewStore } from '../src/state/canvas-view-store';

/** 流区夹具：2000 世界高、三枚 user 刻痕——最旧块顶 = regionTop，于是最上
 *  一枚刻痕正好落在映射区顶（「刻痕顶到带体顶」的边界现场）。 */
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
/** 创作坞几何（2026-09-17）：bottom = 坞位（视口底 → 坞下边；默认位 = 出厂抬高 96），
 *  height = 坞实测高。**目次带只读 height**（用户 2026-09-17 裁定：目次带不随坞浮动
 *  让位），故映射区底 = 画布高 − 96 − 坞高——与浮动化前逐字同值。 */
const COMPOSER_DOCK = { bottom: 96, height: 130 };
/** 带体起点（页面坐标）= **屏顶 0**——2026-09-17 标题栏拆除批：书眉退役，
 *  tokens.css 里那条 `--bar-h` 一并删除（本文件按 0 钉死 = 组件 TOC_TOP 的基准）。 */
const TOC_TOP_PX = 0;
/** 顶部浮件带高（= 屏缘 8 + 浮件 40 + 呼吸 8）——CSS 真源在 .pp-chrome，
 *  两处 TS 镜像（COMPOSER_CHROME_H / TOP_CHROME_H）逐字对拍（见下方用例）。 */
const TOP_CHROME_BAND = 56;
/** 映射区底（**带体坐标**）= 画布区高 − 出厂底带（带体已从屏顶起，
 *  故不再 + 带体起点；与组件内同式）。 */
const MAPPED_BOTTOM = CANVAS_SIZE.h - 96 - COMPOSER_DOCK.height;
/** 纸壳样式（.pp-toc 规则所在）：CSS 契约断言用（同 paper-visual-decisions 口径）。 */
const PANEL_CSS = readFileSync(
  join(__dirname, '..', 'src', 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'),
  'utf8',
);
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

function regionContext(dock: { bottom: number; height: number } = COMPOSER_DOCK): PaperRegionContextValue {
  return {
    regions: [fakeRegion()],
    activeSessionId: '1',
    viewRect: VIEW_RECT,
    canvasSize: CANVAS_SIZE,
    composerDock: dock,
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

describe('目次带 × 屏顶（映射区不越界 + 区外不响应）', () => {
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

  async function mount(dock: { bottom: number; height: number } = COMPOSER_DOCK): Promise<void> {
    const ctx = regionContext(dock);
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
   *  fit 态不走 pointer capture，故不需要捕获桩）。clientX 显式给 0 = **内容列内**
   *  （带体左缘即内容列左缘）——缘滚跑道上的按下另有 pointerDownAt。 */
  function pointerDown(el: Element, clientY: number): void {
    pointerDownAt(el, 0, clientY);
  }
  function pointerDownAt(el: Element, clientX: number, clientY: number): void {
    act(() => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX, clientY }));
    });
  }
  function mouseMoveAt(el: Element, clientX: number, clientY: number): void {
    act(() => {
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }));
    });
  }

  it('带体从屏顶起：CSS top: 0 且不再为书眉留位（--bar-h 已随标题栏拆除删除）', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-toc {');
    expect(rule).toContain('top: 0');
    expect(rule).not.toContain('--bar-h');
    expect(rule).toContain(`width: ${TOC_W}px`); // 浮件让位量按此值算（.pp-chrome right）
    // 带体起点三处同源：组件 TOC_TOP = CSS top = 本文件基准（改一处必红）
    expect(TOC_TOP).toBe(TOC_TOP_PX);
    const tokens = readFileSync(join(__dirname, '..', 'src', 'app', 'tokens.css'), 'utf8');
    expect(tokens).not.toContain('--bar-h:'); // 注释里的历史沿革不算声明
  });

  /* **2026-09-19 加宽批**（用户「由于边缘滚动的落地，我需要再次加宽我的目次带，
   *  因为会有误触的问题」）——带体 = 内容列 + 缘滚跑道，两列宽度三处同源
   *  （组件常量 / CSS / 本文件算术）。这里钉的是**加宽的理由本身**：
   *  贴屏最右那条边缘滚动感应带必须整条落在跑道上，带内导航面才谈得上不误触。 */
  it('加宽批：带体 = 内容列 64 + 缘滚跑道 40；跑道 ≥ 缘滚感应带（加宽的理由）', () => {
    expect(TOC_COL_W).toBe(64); // 与旧带体逐字同宽 ⇒ 带内既有几何零漂移
    expect(TOC_RUNWAY_W).toBe(40);
    expect(TOC_W).toBe(TOC_COL_W + TOC_RUNWAY_W);
    expect(ruleBody(PANEL_CSS, '.pp-toc {')).toContain(`width: ${TOC_W}px`);
    expect(ruleBody(PANEL_CSS, '.pp-toc-col {')).toContain(`width: ${TOC_COL_W}px`);
    // ① 基准感应带整条落在跑道上（指针贴屏最右 = 跑道，照旧缘滚）
    expect(EDGE_SCROLL.band).toBeLessThanOrEqual(TOC_RUNWAY_W);
    // ② 灵敏度拉满（sensMax → 带宽 36×√2 ≈ 51）也不碰导航件：锚/刻痕只占左 26px
    const maxBand = Math.round(EDGE_SCROLL.band * Math.sqrt(EDGE_SCROLL.sensMax));
    expect(maxBand).toBeLessThanOrEqual(TOC_RUNWAY_W + (TOC_COL_W - 26));
  });

  /* 顶部浮件几何（2026-09-17 标题栏拆除批）四处同源：CSS 真源（.pp-chrome 的
   * top/height/right）+ 两处 TS 镜像（坞上夹紧 / 小地图默认位）+ 本文件基准。
   * ⚠ 刻意不落 tokens.css（壳域，改它必须重建 exe）——故由本用例代行「改一处必红」。 */
  it('顶部浮件带几何同源：浮件 8+40，让位目次带宽 +16，带高 56 = 两处 TS 镜像', () => {
    const chrome = ruleBody(PANEL_CSS, '.pp-chrome {');
    expect(chrome).toContain('top: 8px');
    expect(chrome).toContain('height: 40px');
    expect(chrome).toContain(`right: ${TOC_W + 16}px`);
    expect(ruleBody(PANEL_CSS, '.pp-toc {')).toContain(`width: ${TOC_W}px`);
    // 算术同源：让位 = 带宽 104 + 16；带高 = 8 + 40 + 8
    expect(TOC_W + 16).toBe(120);
    expect(8 + 40 + 8).toBe(TOP_CHROME_BAND);
    // TS 侧两处镜像（各自产物域，不可 import —— 只能逐字对拍）
    const composerFloat = readFileSync(
      join(__dirname, '..', 'src', 'plugins', 'builtin', 'paper-shell', 'composer-float.ts'),
      'utf8',
    );
    expect(composerFloat).toContain(`COMPOSER_CHROME_H = ${TOP_CHROME_BAND}`);
    const minimap = readFileSync(
      join(__dirname, '..', 'src', 'plugins', 'builtin', 'paper-minimap', 'MinimapView.tsx'),
      'utf8',
    );
    expect(minimap).toContain(`TOP_CHROME_H = ${TOP_CHROME_BAND}`);
  });

  it('刻痕与滑块整枚落在映射区内（top ≥ 0）——最上一枚刻痕不得越出带体顶', async () => {
    await mount();
    const marks = [...container!.querySelectorAll('.pp-toc-mark')] as HTMLElement[];
    expect(marks).toHaveLength(3);
    const tops = marks.map((m) => Number.parseFloat(m.style.top));
    // 带体坐标：带体从屏顶起（两坐标重合），「不越出带体」= 带内一切 top ≥ 0。
    // 最上一枚刻痕盒顶 = STRIP_TOP − MARK_HALF = 0（旧旧实现 = 页面 52 < 56：
    // 那 4px 命中归书眉＝拖窗口，点刻痕点不中）
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(0);
    expect(STRIP_TOP).toBe(MARK_HALF); // 映射区顶 = 刻痕半高（带体坐标）
    expect(STRIP_TOP - MARK_HALF).toBe(0);
    const slider = container!.querySelector('.pp-toc-slider') as HTMLElement;
    expect(Number.parseFloat(slider.style.top)).toBeGreaterThanOrEqual(STRIP_TOP);
  });

  it('带内所有子元素 top ≥ 0（刻痕/锚/滑块一律不越出带体顶）', async () => {
    await mount();
    // 实机验收曾当场量到最上一枚阶段锚盒顶越出（页面 47 < 当时的书眉 56）——本用例把它钉住
    expect(anchorBoxTop(5)).toBe(0); // 贴顶夹紧
    expect(anchorBoxTop(100)).toBe(86); // 常态：盒以刻位为中心
    const kids = [...container!.querySelectorAll('.pp-toc-mark, .pp-toc-anchor, .pp-toc-slider')] as HTMLElement[];
    expect(kids.length).toBeGreaterThan(0);
    const tops = kids.map((k) => Number.parseFloat(k.style.top));
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(0);
  });

  it('hover 卡不越出带体顶：贴顶时翻转到红线下方（卡片不飘到画布上）', () => {
    // 居中态：卡片半高（≤4 行 ≈36px）小于翻转阈 → 上缘恒 ≥ 0
    expect(TOC_CARD_FLIP_Y).toBeGreaterThanOrEqual(36);
    expect(cardAnchorFor(TOC_CARD_FLIP_Y)).toEqual({ top: TOC_CARD_FLIP_Y, transform: 'translateY(-50%)' });
    // 贴顶态：翻到红线下方，卡片不向上溢出
    const top = cardAnchorFor(2);
    expect(top.transform).toBe('none');
    expect(top.top).toBeGreaterThan(2);
    expect(cardAnchorFor(0).top).toBeGreaterThanOrEqual(0);
  });

  it('带内按下 = 跳视口；映射区顶那半高留白与坞下装饰带按下一律不响应', async () => {
    await mount();
    const nav = container!.querySelector('.pp-toc') as HTMLElement;
    const before = useCanvasViewStore.getState().view.panY;

    // 带体顶半高留白（带体坐标 y = 0 < 映射区顶 = 刻痕半高）：无刻位语义，不响应
    pointerDown(nav, 0);
    expect(useCanvasViewStore.getState().view.panY).toBe(before);

    // 坞下装饰带（映射区底之下）：无语义，按下同样不响应
    pointerDown(nav, MAPPED_BOTTOM + 40);
    expect(useCanvasViewStore.getState().view.panY).toBe(before);

    // 带内：点带即跳照旧生效（断言不为空转）
    pointerDown(nav, STRIP_TOP + 300);
    expect(useCanvasViewStore.getState().view.panY).not.toBe(before);
  });

  /* **2026-09-19 加宽批**的行为面：带体右那条**缘滚跑道**惰性——按下不 scrub、
   *  mousemove 不弹卡；同一姿态落在内容列上照旧。跑道正是缘滚感应带所在，带内
   *  交互不认它，两条面才不互相误触（几何不变量见上方「加宽批」用例）。 */
  it('缘滚跑道惰性：带右 40px 按下不 scrub、不弹 hover 卡；内容列上照旧', async () => {
    await mount();
    const nav = container!.querySelector('.pp-toc') as HTMLElement;
    const col = container!.querySelector('.pp-toc-col') as HTMLElement;
    expect(col).not.toBeNull();
    /* 带内件全收在内容列里（结构性零漂移）：墨迹画布是列的子件 ⇒ 它的
     * clientWidth 恒 = TOC_COL_W（识别层缩放比读的就是这个值，宽了剪影就被拉伸）。
     * 真 CSS + 无头 Chrome 探针实测：canvas.clientWidth = 64、滑块 56、锚 26、
     * unread/活线 64——与加宽前逐字同值，整条只左移 40px。
     * （本夹具 units 为空 ⇒ 无阶段锚，锚的 26px 左缘栏由 stage-anchor-layer 件钉。） */
    expect(col.querySelector('.pp-toc-ink')).not.toBeNull();
    expect(col.querySelector('.pp-toc-slider')).not.toBeNull();
    // 真机几何桩：带体右缘贴屏（2560 − 104 = 2456），内容列 = 带体左 64px
    nav.getBoundingClientRect = () =>
      ({
        left: 2456,
        top: 0,
        right: 2560,
        bottom: 1000,
        width: TOC_W,
        height: 1000,
        x: 2456,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const inCol = 2456 + 20; // 内容列内（导航面）
    const inRunway = 2560 - 8; // 贴屏最右（缘滚感应带里）
    const tick = container!.querySelector('.pp-toc-mark.is-user') as HTMLElement;
    const tickY = Number.parseFloat(tick.style.top) + MARK_HALF; // 刻痕所在（hover 有词可读）
    const before = useCanvasViewStore.getState().view.panY;

    pointerDownAt(nav, inRunway, STRIP_TOP + 300);
    expect(useCanvasViewStore.getState().view.panY).toBe(before); // 跑道：点击只被吞掉
    mouseMoveAt(nav, inRunway, tickY);
    expect(container!.querySelector('.pp-toc-card')).toBeNull(); // 跑道：不读带、不留卡

    mouseMoveAt(nav, inCol, tickY);
    expect(container!.querySelector('.pp-toc-card')).not.toBeNull(); // 内容列：照旧指哪读哪
    pointerDownAt(nav, inCol, STRIP_TOP + 300);
    expect(useCanvasViewStore.getState().view.panY).not.toBe(before); // 内容列：点带即跳照旧
  });

  /* 2026-09-17 用户裁定「目次带似乎没必要做让位」——坞被拖到哪都不该压缩导航带，
   * 只有坞**高**变了才动（那才是可见域的诚实变化）。本用例是这条裁定的考官：
   * 同一份流区内容，坞位从出厂位挪到半屏，刻痕/滑块落点必须逐字不变。 */
  it('坞浮起不让位（用户 2026-09-17 裁定）：坞位变了映射区不动，坞高变了才动', async () => {
    const marksAt = (): number[] =>
      ([...container!.querySelectorAll('.pp-toc-mark')] as HTMLElement[]).map((m) => Number.parseFloat(m.style.top));

    await mount({ bottom: 96, height: 130 }); // 出厂位
    const atHome = marksAt();
    const nav = container!.querySelector('.pp-toc') as HTMLElement;
    pointerDown(nav, MAPPED_BOTTOM + 40); // 映射区底之下 = 坞顶线以下（默认位口径）
    const panAfterBelow = useCanvasViewStore.getState().view.panY;

    await mount({ bottom: 400, height: 130 }); // 坞被拖到半屏（坞位变、坞高不变）
    expect(marksAt()).toEqual(atHome); // 映射区逐字不动 ⇒ 目次带没让位
    // 「坞顶线以下不响应」这条判据也随出厂位口径（坞浮起来不改变导航带的可点范围）
    pointerDown(nav, MAPPED_BOTTOM + 40);
    expect(useCanvasViewStore.getState().view.panY).toBe(panAfterBelow);
    pointerDown(nav, STRIP_TOP + 300);
    expect(useCanvasViewStore.getState().view.panY).not.toBe(panAfterBelow);

    // 坞高变了（思考展开/附件）→ 才动：映射区底随坞高下移
    await mount({ bottom: 96, height: 300 });
    expect(marksAt()).not.toEqual(atHome);
  });
});
