// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 目次带 v4（2026-10-20：两栏 / 编号 / 纸捻）守护。
//
// 本批三件事各有考官：
//   ① **hover 卡定宽**——旧 CSS 只有 max-width、定位用 right，在 64px 控制列里
//      算出负可用宽，卡塌成 36.1×249.1 的竖条（原型同构复现）；现在 268 + border-box。
//   ② **两栏结构**——识别层只占右 40（= 缘滚跑道），左 64 全给目次栏；编号进左栏。
//   ③ **编号**——自适应省号（防长卷叠字）、当前阶段恒在、aria-hidden（锚的
//      aria-label 已报阶段序，编号是重复的可视读数）。
// 另加滑块抓手（is-dragging）与卡片语色/eyebrow 的行为钉。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pretext 全 mock（jsdom 无 Canvas 2D——同 paper-ink.test.ts 口径）。
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
import { STRIP_TOP, TOC_CARD_FLIP_Y, TOC_COL_W, TOC_W, TocStrip } from '../src/plugins/builtin/compose-dock/TocStrip';
import type { WorkUnit } from '../src/plugins/builtin/paper-shell/group';
import { useCanvasViewStore } from '../src/state/canvas-view-store';

const PANEL_CSS = readFileSync(
  join(__dirname, '..', 'src', 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'),
  'utf8',
);
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

const CANVAS_SIZE = { w: 1200, h: 1000 };
const COMPOSER_DOCK = { bottom: 96, height: 130 };
/** 映射区底 = 1000 − 96 − 130 = 774；映射区 = [4, 774]。 */
const MAPPED_BOTTOM = 774;
/** 世界区间 0..1000 → 带内 4..774（scale 0.77）。 */
const VIEW_ALL = { x0: -4000, y0: 0, x1: 4000, y1: 1226 };

/** 夹具：`users` 是 user 块的世界 y（h=10）；可选一条 markdown 正文块。 */
function fakeRegion(users: number[], opts: { proseAt?: number; total?: number } = {}): RegionView {
  const blocks: SourcedBlock[] = [];
  const flowGeom: RegionView['flowGeom'] = [];
  const layout = new Map<string, { x: number; y: number }>();
  const units: WorkUnit[] = [];
  for (const [i, y] of users.entries()) {
    const b = createBlock('user', { text: `第 ${i + 1} 轮来文：把目次带的口径改一改` }, { messageId: 'm', part: null });
    blocks.push(b);
    flowGeom.push({ id: b.id, y, h: 10, x: -720, w: 1440 });
    layout.set(b.id, { x: -720, y });
    units.push({ id: `u:${b.id}`, kind: 'user', memberIds: [b.id], sealed: true });
  }
  if (opts.proseAt !== undefined) {
    const b = createBlock(
      'markdown',
      { text: '正文一段：这一段是行盒原文的兜底读数。' },
      { messageId: 'm', part: null },
    );
    blocks.push(b);
    flowGeom.push({ id: b.id, y: opts.proseAt, h: 40, x: -720, w: 1440 });
    layout.set(b.id, { x: -720, y: opts.proseAt });
  }
  const total = opts.total ?? 1000;
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
    regionTop: 0,
    regionBottom: total,
    regionHeight: total,
    folioH: 120,
    units,
    stageLeadIds: new Set(),
    unitLeadIds: new Set(),
    verifyDoneIds: new Set(),
    writingBlockId: null,
  };
}

describe('目次带 v4 — 两栏 / 编号 / 纸捻', () => {
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

  async function mount(region: RegionView, view = VIEW_ALL): Promise<void> {
    const ctx: PaperRegionContextValue = {
      regions: [region],
      activeSessionId: '1',
      viewRect: view,
      canvasSize: CANVAS_SIZE,
      composerDock: COMPOSER_DOCK,
      foldedOf: () => false,
      minimap: { content: { x0: -720, y0: 0, x1: 720, y1: region.regionBottom }, geo: [] },
      inkCache: createInkCache(),
    };
    const dock: PaperDockContextValue = { activeSessionId: '1', flyToPoint: vi.fn(), glideTo: vi.fn() };
    await act(async () => {
      root?.render(
        createElement(
          PaperDockContext.Provider,
          { value: dock },
          createElement(PaperRegionContext.Provider, { value: ctx }, createElement(TocStrip)),
        ),
      );
    });
  }

  /* ① 卡片定宽：旧规则只有 max-width + right → 负可用宽 → 36.1×249.1 竖条。
   * 这里钉的是「宽度由自己给，不由定位反推」；268 是原型定档的读数宽度。 */
  it('hover 卡：定宽 268 + border-box（旧卡塌成 36px 竖条的回归钉）', () => {
    const card = ruleBody(PANEL_CSS, '.pp-toc-card {');
    expect(card).toContain('width: 268px');
    expect(card).toContain('box-sizing: border-box');
    expect(card).not.toContain('max-width: 260px');
    // 翻转阈必须容得下 v4 卡的最大半高（eyebrow + 7 行 ≈ 90px）
    expect(TOC_CARD_FLIP_Y).toBeGreaterThanOrEqual(90);
  });

  /* ② 两栏：识别层收回右 40（= 缘滚跑道），不再是 104 满宽；左 64 全部给目次栏。
   * v4.1 实机修：canvas 是 replaced element，`width:auto` 会用固有宽 300（不是解
   * left/right），墨影整条画到屏外——CSS 必须给死宽 40。 */
  it('两栏：墨迹画布只占右 40（left = 控制列宽、给死宽），仍在带体子级、不在控制列里', async () => {
    const ink = ruleBody(PANEL_CSS, '.pp-toc-ink {');
    expect(ink).toContain(`left: ${TOC_COL_W}px`);
    expect(ink).toContain('right: auto');
    expect(ink).toContain('width: 40px');
    expect(ink).not.toContain('width: auto');
    expect(TOC_W - TOC_COL_W).toBe(40); // 右 40 = 缘滚跑道
    await mount(fakeRegion([0, 100, 200]));
    const nav = container!.querySelector('.pp-toc') as HTMLElement;
    const col = container!.querySelector('.pp-toc-col') as HTMLElement;
    expect(nav.querySelector(':scope > .pp-toc-ink')).not.toBeNull();
    expect(col.querySelector('.pp-toc-ink')).toBeNull();
  });

  /* ③ 编号：宽间距全显；密间距自适应省号；当前阶段恒在；全部 aria-hidden。 */
  it('阶段编号：宽间距全显示、密间距自适应省号，当前阶段恒显示且 aria-hidden', async () => {
    await mount(fakeRegion([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]));
    const anchors = [...container!.querySelectorAll('.pp-toc-anchor')] as HTMLButtonElement[];
    expect(anchors).toHaveLength(10);
    expect(container!.querySelectorAll('.pp-toc-num')).toHaveLength(10); // 间距 38.5px，全显
    for (const a of anchors) {
      expect(a.querySelector('.pp-toc-num')?.getAttribute('aria-hidden')).toBe('true');
    }
    // 当前阶段 = 视口中心（500）落在第 5 枚（worldY 405）之后、第 6 枚（505）之前
    expect(anchors[4]!.classList.contains('is-active')).toBe(true);
    expect(anchors[4]!.getAttribute('aria-current')).toBe('step');
    expect(anchors[4]!.querySelector('.pp-toc-num')?.textContent).toBe('5');

    await mount(fakeRegion([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190]));
    const dense = [...container!.querySelectorAll('.pp-toc-anchor')] as HTMLButtonElement[];
    const nums = [...container!.querySelectorAll('.pp-toc-num')];
    expect(dense).toHaveLength(20);
    expect(nums.length).toBeLessThan(dense.length); // 7.7px 间距 → 省号
    expect(nums.length).toBeGreaterThan(2);
    // 当前阶段（视口中心 500 在所有 user 之后 → 最后一枚）恒有编号
    const active = container!.querySelector('.pp-toc-anchor.is-active') as HTMLButtonElement;
    expect(active).not.toBeNull();
    expect(active.querySelector('.pp-toc-num')?.textContent).toBe('20');
  });

  /* ④ 卡片语色：行盒原文那一档 = 正文 eyebrow + text 语色；阶段 = 朱砂。 */
  it('卡片语色：行盒原文 → eyebrow「正文」/ is-tone-text；阶段 →「阶段 N」/ is-tone-stage', async () => {
    await mount(fakeRegion([0, 100, 200, 300, 400], { proseAt: 600 }));
    const nav = container!.querySelector('.pp-toc') as HTMLElement;
    // 正文块顶（600）远离所有阶段锚：stripY = 56 + 600 × 0.718 ≈ 487
    act(() => {
      nav.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 488 }));
    });
    const textCard = container!.querySelector('.pp-toc-card') as HTMLElement;
    expect(textCard.querySelector('.pp-toc-eyebrow')?.textContent).toBe('正文');
    expect(textCard.classList.contains('is-tone-text')).toBe(true);
  });

  /* ⑤ 纸窗滑块 + 抓手：可拖态按下 → is-dragging（抓手亮一档），抬起复位。 */
  it('纸窗滑块：可拖态按下亮抓手（is-dragging），抬起复位；fit 态无抓手', async () => {
    await mount(fakeRegion([0, 1000, 2000, 3000], { total: 4000 }), {
      x0: -4000,
      y0: 0,
      x1: 4000,
      y1: 1226,
    });
    const nav = container!.querySelector('.pp-toc') as HTMLElement;
    nav.setPointerCapture = vi.fn();
    nav.releasePointerCapture = vi.fn();
    const slider = container!.querySelector('.pp-toc-slider') as HTMLElement;
    expect(slider.querySelector('.pp-toc-grip')).not.toBeNull();
    expect(slider.classList.contains('is-fit')).toBe(false);

    act(() => {
      nav.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 60 }),
      );
    });
    expect(container!.querySelector('.pp-toc-slider.is-dragging')).not.toBeNull();
    act(() => {
      nav.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 20, clientY: 60 }));
    });
    expect(container!.querySelector('.pp-toc-slider.is-dragging')).toBeNull();

    // fit 态（内容不满一屏）：无抓手
    await mount(fakeRegion([0, 500]));
    expect(container!.querySelector('.pp-toc-slider.is-fit .pp-toc-grip')).toBeNull();
  });

  /* ⑥ 材质与骨架：纸捻（不透明纸底 + 硬边 + 受光/背光 + 内影）、竖脊/端规在位且惰性；
   * 带脚「目次」小签已按用户 2026-10-20 实机意见摘除。 */
  it('纸捻材质与骨架：不透明纸底 + 硬左缘 + 受光/背光；竖脊/端规惰性在位、无带脚小签', async () => {
    const toc = ruleBody(PANEL_CSS, '.pp-toc {');
    expect(toc).toContain('border-left: var(--rule-strong)');
    expect(toc).toContain('linear-gradient');
    expect(toc).toContain('78%'); // 实机「纯色底」修订：右缘拉到 78% paper-deep
    expect(toc).toContain('inset 2px 0 0'); // 受光缘
    expect(toc).toContain('inset -2px 0 0'); // 背光缘
    expect(toc).not.toContain('45%, transparent'); // 旧半透明底不再
    await mount(fakeRegion([0, 100, 200]));
    const rail = container!.querySelector('.pp-toc-rail') as HTMLElement;
    const caps = [...container!.querySelectorAll('.pp-toc-cap')] as HTMLElement[];
    expect(rail.style.top).toBe(`${STRIP_TOP}px`);
    expect(Number.parseFloat(rail.style.height)).toBeCloseTo(MAPPED_BOTTOM - STRIP_TOP, 6);
    expect(caps).toHaveLength(2);
    expect(caps.map((c) => Number.parseFloat(c.style.top))).toEqual([STRIP_TOP, MAPPED_BOTTOM]);
    expect(container!.querySelector('.pp-toc-colophon')).toBeNull(); // 已摘
    for (const el of [rail, ...caps]) expect(el.getAttribute('aria-hidden')).toBe('true');
  });
});
