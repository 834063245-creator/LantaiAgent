// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 目次带 v3「甲：可点层 / 装饰层分家」守护（2026-09-14 用户拍板「丙：甲 + 乙」）。
//
// 现场（实机实测）：289 枚刻痕全做成 button 命中盒（10×8）——tool 刻痕 255 枚
// 把 18 枚阶段锚挤到平均 3.8px 间距，命中盒相互叠压、DOM 后渲染者胜：点自己
// 那枚的比例只有 7.3%（268/289 被相邻刻痕盖住），用户读作「刻痕点不中」。
// 修法（本文件钉死）：
//   ① 阶段锚 = 带内**唯一可点目标**（28px 命中盒 ≥ 热区纪律 24px），点击飞到
//      该阶段首块；按下锚不启动 scrub（两个落点不抢同一根指针）；
//   ② 装饰刻痕（tool/plan/error + 无阶段单元的用户块）= 纯扫读信号：惰性 div +
//      aria-hidden + CSS pointer-events:none——不是点击靶、也不再是 289 个 tab
//      停靠点；
//   ③ 连续 scrub 归滑块 + 带空白处（滚动条语义）；
//   ④ hover 卡与命中盒同源：卡片所示即点击所得（锚优先「阶段 N · 首句」）。

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
import type { WorkUnit } from '../src/paper/group';
import { createInkCache } from '../src/paper/ink';
import {
  PaperDockContext,
  type PaperDockContextValue,
  PaperRegionContext,
  type PaperRegionContextValue,
} from '../src/paper/overlay-context';
import type { RegionView } from '../src/paper/region-view';
import { STAGE_HIT_H, TocStrip } from '../src/plugins/builtin/compose-dock/TocStrip';
import { useCanvasViewStore } from '../src/state/canvas-view-store';

/** 纸壳样式（目次带规则所在）：CSS 契约断言用（同 paper-visual-decisions 口径）。 */
const PANEL_CSS = readFileSync(
  join(__dirname, '..', 'src', 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'),
  'utf8',
);
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

/** 流区夹具（2000 世界高 / 映射 770px，scale ≈ 0.385）：两阶段（user 单元）
 *  + 两枚工具刻痕 + 一枚报错刻痕。刻痕与阶段锚隔 ≥96px——hover 判定互不干扰。 */
function fakeRegion(): { region: RegionView; anchorWorldY: number[] } {
  const mk = (kind: 'user' | 'tool' | 'markdown', text: string, y: number, h: number) => {
    const b =
      kind === 'tool'
        ? createBlock(
            'tool',
            { toolId: 't', name: 'read', label: '读文件', args: '{}', status: 'done' as const },
            { messageId: 'm', part: null },
          )
        : createBlock(kind, { text }, { messageId: 'm', part: null });
    return { b, y, h };
  };
  const rows = [
    mk('user', '第一轮来文：把目次带的口径改一改', -2000, 100),
    mk('tool', '读文件', -1700, 100),
    mk('tool', '读文件', -1500, 100),
    mk('markdown', '正文', -1200, 100),
    mk('user', '第二轮来文：刻痕点不中怎么办', -1000, 100),
    mk('tool', '读文件', -600, 100),
    mk('markdown', '正文', -300, 100),
  ];
  const blocks: SourcedBlock[] = rows.map((r) => r.b);
  const flowGeom: RegionView['flowGeom'] = rows.map((r) => ({ id: r.b.id, y: r.y, h: r.h, x: -720, w: 1440 }));
  const layout = new Map(rows.map((r) => [r.b.id, { x: -720, y: r.y }]));
  const units: WorkUnit[] = [
    { id: `u:${rows[0].b.id}`, kind: 'user', memberIds: [rows[0].b.id, rows[1].b.id, rows[2].b.id], sealed: true },
    { id: `u:${rows[4].b.id}`, kind: 'user', memberIds: [rows[4].b.id, rows[5].b.id], sealed: true },
  ];
  return {
    region: {
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
      units,
      stageLeadIds: new Set(),
      unitLeadIds: new Set(),
      verifyDoneIds: new Set(),
      writingBlockId: null,
    },
    // 阶段锚的世界落点 = 首成员块中心
    anchorWorldY: [-1950, -950],
  };
}

const VIEW_RECT = { x0: -4000, y0: -4000, x1: 4000, y1: 0 };
const CANVAS_SIZE = { w: 1200, h: 1000 };
/** 创作坞几何（2026-09-17）：目次带只读 height（**出厂底带口径，不随坞浮动让位**——
 *  用户 2026-09-17 裁定），几何数值与浮动化前逐字相同。 */
const COMPOSER_DOCK = { bottom: 96, height: 130 };

describe('目次带 v3 — 阶段锚可点 / 装饰刻痕不参与命中', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let flyToPoint: ReturnType<typeof vi.fn>;
  let fixture: ReturnType<typeof fakeRegion>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fixture = fakeRegion();
    flyToPoint = vi.fn();
    useCanvasViewStore.getState().setView({ panX: 0, panY: 0, zoom: 1 });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function mount(): Promise<void> {
    const ctx: PaperRegionContextValue = {
      regions: [fixture.region],
      activeSessionId: '1',
      viewRect: VIEW_RECT,
      canvasSize: CANVAS_SIZE,
      composerDock: COMPOSER_DOCK,
      foldedOf: () => false,
      minimap: { content: { x0: -720, y0: -2000, x1: 720, y1: 0 }, geo: [] },
      inkCache: createInkCache(),
    };
    const dock: PaperDockContextValue = { activeSessionId: '1', flyToPoint, glideTo: vi.fn() };
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

  const stripYOfTick = (el: HTMLElement): number => Number.parseFloat(el.style.top) + 4;

  it('可点层只有阶段锚：锚=button（28px 热区），刻痕=惰性 div（aria-hidden，无 button）', async () => {
    await mount();
    const anchors = [...container!.querySelectorAll('.pp-toc-anchor')] as HTMLButtonElement[];
    expect(anchors).toHaveLength(2); // 两个 user 单元 = 两枚阶段锚
    expect(STAGE_HIT_H).toBeGreaterThanOrEqual(24); // 热区纪律（≥24px）
    for (const a of anchors) {
      expect(Number.parseFloat(a.style.top)).toBeCloseTo(Number.parseFloat(a.style.top), 3);
      expect(Number.isFinite(Number.parseFloat(a.style.top))).toBe(true);
    }
    // 装饰刻痕：tool × 3（两枚读文件 + 一枚无单元的正文不算）+ 全为惰性 div
    const ticks = [...container!.querySelectorAll('.pp-toc-mark')];
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.tagName).toBe('DIV');
      expect(t.getAttribute('aria-hidden')).toBe('true');
    }
    // 旧病灶：289 个 button 命中盒。现在带内 button 只允许是阶段锚。
    const buttons = [...container!.querySelectorAll('.pp-toc button')];
    expect(buttons).toHaveLength(anchors.length);
  });

  it('点阶段锚 = 飞到该阶段首块（worldY 取块中心）；按下锚不启动 scrub', async () => {
    await mount();
    const anchors = [...container!.querySelectorAll('.pp-toc-anchor')] as HTMLButtonElement[];
    const panY0 = useCanvasViewStore.getState().view.panY;

    // 按下锚：不 scrub（否则同一按既 scrub 又飞）
    act(() => {
      anchors[1].dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientY: 400 }),
      );
    });
    expect(useCanvasViewStore.getState().view.panY).toBe(panY0);

    act(() => {
      anchors[1].click();
    });
    expect(flyToPoint).toHaveBeenCalledWith('1', fixture.anchorWorldY[1]);
  });

  it('点装饰刻痕 = 不跳转：只按位置 scrub（点它不再跳到"最新那枚"的块）', async () => {
    await mount();
    const tick = container!.querySelector('.pp-toc-mark.is-tool') as HTMLElement;
    expect(tick).not.toBeNull();
    const panY0 = useCanvasViewStore.getState().view.panY;
    act(() => {
      // 完整一次按下-抬起-点击（浏览器语义）：旧版刻痕是 button，会吃到这记 click
      const opts = { bubbles: true, cancelable: true, button: 0, clientY: stripYOfTick(tick) };
      tick.dispatchEvent(new MouseEvent('pointerdown', opts));
      tick.dispatchEvent(new MouseEvent('pointerup', opts));
      tick.click();
    });
    expect(flyToPoint).not.toHaveBeenCalled(); // 装饰层不再是点击靶
    expect(useCanvasViewStore.getState().view.panY).not.toBe(panY0); // 但位置 scrub 照旧（事件冒泡到带体）
  });

  it('CSS 契约：装饰层 pointer-events:none；锚的命中盒高 = STAGE_HIT_H（两处同改）', () => {
    // 组件侧 STAGE_HIT_H 与 CSS .pp-toc-anchor height 是同一件事的两处声明——
    // 漂了就出现「卡片说阶段、点击落下 scrub」的错位（卡片/命中盒同源判据）。
    expect(ruleBody(PANEL_CSS, '.pp-toc-mark {')).toContain('pointer-events: none');
    expect(ruleBody(PANEL_CSS, '.pp-toc-anchor {')).toContain(`height: ${STAGE_HIT_H}px`);
  });

  it('hover 卡与命中盒同源：贴刻痕读那枚（且那枚提墨），锚盒内读阶段', async () => {
    await mount();
    const nav = container!.querySelector('.pp-toc') as HTMLElement;
    const tick = container!.querySelector('.pp-toc-mark.is-tool') as HTMLElement;
    const tickY = stripYOfTick(tick);
    act(() => {
      nav.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: tickY }));
    });
    expect(container!.querySelector('.pp-toc-card')?.textContent).toBe('读文件');
    expect(container!.querySelector('.pp-toc-mark.is-tool.is-hover')).not.toBeNull(); // 卡片所示即高亮所在

    // 阶段锚命中盒内（锚 y 与刻痕相隔 ≫ 半高）→ 卡片报阶段序
    const anchorTop = Number.parseFloat((container!.querySelector('.pp-toc-anchor') as HTMLElement).style.top);
    act(() => {
      nav.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: anchorTop + STAGE_HIT_H / 2 }));
    });
    expect(container!.querySelector('.pp-toc-card')?.textContent).toContain('阶段 1 ·');
  });
});
