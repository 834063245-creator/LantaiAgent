// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper V3a 无头测试 — 测量封装（mock canvas）/ 虚拟化 / 抽纸条。
// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock '@chenglou/pretext'，
// 只测分派/缓存/常量面；真测量的数值精度属上游包自己的测试域。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prepareMock, layoutMock, prepareRichMock, richStatsMock } = vi.hoisted(() => ({
  prepareMock: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
  prepareRichMock: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  richStatsMock: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: prepareMock,
  layout: layoutMock,
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: prepareRichMock,
  measureRichInlineStats: richStatsMock,
}));

import { createBlock, DEFAULT_BLOCK_WIDTH, resetBlockIdCounterForTests } from '../src/paper/block-model';
import { layoutFlow, panBy, zoomAt } from '../src/paper/canvas-math';
import { composerSubmitOnKey } from '../src/paper/ime';
import {
  CIRCLE_EXTRA,
  CODE_OUT_TEXT_MAX,
  CODE_SRC_MAX_H,
  clearPaperMeasureCache,
  createBlockMeasureCache,
  FOLD_ROW_H,
  measureBlockHeight,
  measureBlockHeightCached,
  measureTextHeight,
  OUT_MAX_H,
  PAPER_BODY_FONT,
  PAPER_MONO_FONT,
  PAPER_USER_FONT,
  PAPER_USER_LINE_HEIGHT,
  PRE_MAX_H,
  SEC_HEAD_GAP,
  SEC_HEAD_H,
} from '../src/paper/measure';
import {
  makeStrip,
  moveStrip,
  resetStripIdCounterForTests,
  selectionMaskRects,
  sliceSelection,
  tryMakeStripFromSelection,
} from '../src/paper/selection';
import { cssUsedPx } from '../src/paper/type-tokens';
import {
  type FlowGeom,
  type PinnedGeom,
  rectsIntersect,
  viewportWorldRect,
  visibleFlowWindow,
  visiblePinnedIds,
} from '../src/paper/virtualize';

function block(kind: Parameters<typeof createBlock>[0], payload: object) {
  return createBlock(kind, payload as never, { messageId: 'm', part: null });
}

/* ═══ 测量封装 ═══ */

describe('paper/measure', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('文本块高 = 纯测量文本高（注疏版式：透明块无壳 chrome，mock 常量 36）', () => {
    const b = block('markdown', { text: '两行文本' });
    expect(measureBlockHeight(b)).toBe(36);
  });

  it('空文本块高 = 0（测量零成本路径）', () => {
    const b = block('markdown', { text: '' });
    expect(measureBlockHeight(b)).toBe(0);
  });

  it('diff 块：lang 行计高，图版 chrome（30）+ pre 封顶 PRE_MAX_H', () => {
    const withLang = block('diff', { lang: 'ts', text: 'code' });
    const noLang = block('diff', { text: 'code' });
    // lang 16 + 图版 padding/border 30 + 36
    expect(measureBlockHeight(withLang)).toBe(16 + 30 + 36);
    expect(measureBlockHeight(noLang)).toBe(0 + 30 + 36);
  });

  it('tool 块：注线顶距 + 折叠行 + args + output + err 各计一段，output/err 封顶 OUT_MAX_H', () => {
    const b = block('tool', { toolId: 't', name: 'n', label: 'l', args: 'a', status: 'done', output: 'o', err: 'e' });
    // 顶距 10 + 折叠行 20；args 段头 14 + 36；output/err 各段头 14 + 上距 6 + 36
    const sec = (gap: boolean) => SEC_HEAD_H + (gap ? SEC_HEAD_GAP : 0) + 36;
    expect(measureBlockHeight(b)).toBe(10 + FOLD_ROW_H + sec(false) + sec(true) * 2);
  });

  it('prepare 缓存：同文本同字体只 prepare 一次（FIFO 纪律）', () => {
    const t = '同一段文本测量两次';
    measureTextHeight(t, 600);
    measureTextHeight(t, 300); // 宽度变化只重 layout
    expect(prepareMock).toHaveBeenCalledTimes(1);
    measureTextHeight(t, 600, PAPER_MONO_FONT); // 字体变化 → 新条目
    expect(prepareMock).toHaveBeenCalledTimes(2);
  });

  it('字体常量是具名栈（2026-09-10 三体换代：统一 MiSans，不用 system-ui）', () => {
    expect(PAPER_BODY_FONT).not.toContain('system-ui');
    expect(PAPER_MONO_FONT).not.toContain('ui-monospace');
    expect(PAPER_BODY_FONT).toContain('MiSans');
    expect(PAPER_MONO_FONT).toContain('MiSans');
  });

  it('B4 环1 钉值：来文 22px / 行高 22×1.65=36.3——测高取 CSS **用值** 36.296875（seal-deep 不变；2026-08-30 标题化：题 > 正文 17；手迹位三体换代后同 MiSans）', () => {
    expect(PAPER_USER_FONT).toContain('22px');
    expect(PAPER_USER_FONT).toContain('MiSans');
    // 2026-09-19 行高量化：token 算式仍是 22×1.65 = 36.3，但引擎把 line-height
    // 存成 LayoutUnit（1/64px）= 36.296875——测高必须用同一个数（真机读数：
    // 8 行 pre-wrap 盒 = 290.375 = 8×36.296875），否则每行攒 0.003px 的确定
    // 性偏差（夹注 24.975 → 24.96875 是同一律，1702 行攒 −10.6px）。
    expect(cssUsedPx(22 * 1.65)).toBe(36.296875);
    expect(PAPER_USER_LINE_HEIGHT).toBe(36.296875);
  });

  // CSS 字面量钉值在 tests/paper-visual-decisions.test.ts（node 环境 readFileSync；
  // jsdom 下 node: 模块 baseline 不可用、?raw 被 vitest css 管线吞空——两条路试过）。

  it('user/reasoning/notice/plan 四类分支各自计高（kinds 全谱）', () => {
    // user 题签 48 + 纯文本 36 + asterism 44（2026-08-30 标题化：题签置顶占高，

    // reasoning 展开态 = 折叠行 20 + 纯文本 36（折叠机制 2026-08-30）；
    // notice 带贴黄 chrome 17；plan 带拟策 chrome 31 + 标题实测 48
    expect(measureBlockHeight(block('user', { text: 'hi' }))).toBe(48 + 36 + 44);
    expect(measureBlockHeight(block('reasoning', { text: 'think' }))).toBe(FOLD_ROW_H + 36);
    expect(measureBlockHeight(block('notice', { text: 'n', level: 'info' }))).toBe(17 + 36);
    // 拟策 2026-09-10 渲染专项：内容走 markdown 体（measureMdBlocks）；
    // 标题实测（mock 36）+ head margin 12——旧固定 39 已退役
    expect(measureBlockHeight(block('plan', { planId: 'p', title: 't', content: 'c', status: 's' }))).toBe(
      31 + 36 + 12 + 36,
    );
  });

  it('B1 垂直节奏：块距 48；user 头顶 48+24、尾部 8（asterism 让位）；markdown 段距 14', () => {
    // 三块栈（旧→新）：a(markdown) → u(user) → b(markdown)，自底向上累积。
    // 几何：u 的头顶 = u 与上方 a 的间距；u 的尾距 = u 与下方 b 的间距。
    const stack = [
      { id: 'a', h: 100, kind: 'markdown' },
      { id: 'u', h: 50, kind: 'user' },
      { id: 'b', h: 100, kind: 'markdown' },
    ];
    const lay = layoutFlow(stack);
    // 最新块 b 底边贴锚 y=0 → b 顶 -100
    expect(lay.get('b')?.y).toBe(-100);
    // u 尾距（u 底到 b 顶）：userTailGap 8 → u 顶 = -100 - 8 - 50 = -158
    expect(lay.get('u')?.y).toBe(-100 - 8 - 50);
    // u 头顶（u 顶到 a 底）：blockGap 48 + userLeadGap 24 = 72 → a 顶 = -158 - 72 - 100 = -330
    expect(lay.get('a')?.y).toBe(-100 - 8 - 50 - 48 - 24 - 100);
    // 双换行分段：两段各 36 + 段距 14（2026-08-30 markdown 专项：10→14）
    expect(measureBlockHeight(block('markdown', { text: 'p1\n\np2' }))).toBe(36 + 14 + 36);
  });

  it('PRE_MAX_H/OUT_MAX_H 截断路径：mock 返超高时封顶生效（滚动不占高）', () => {
    // 模拟超长 diff：layout 返回 9999 → 截断到 PRE_MAX_H
    layoutMock.mockReturnValueOnce({ height: 9999, lineCount: 999 });
    const diff = block('diff', { lang: 'ts', text: 'x'.repeat(1000) });
    expect(measureBlockHeight(diff)).toBe(16 + 30 + PRE_MAX_H);
    // 超长 tool output：截断到 OUT_MAX_H
    layoutMock.mockReturnValueOnce({ height: 9999, lineCount: 999 });
    const tool = block('tool', {
      toolId: 't',
      name: 'n',
      label: 'l',
      args: '',
      status: 'done',
      output: 'y'.repeat(1000),
    });
    // args 为空走零成本路径；折叠行 20 + 输出段头 14 + output 截断后，加顶距 10
    expect(measureBlockHeight(tool)).toBe(10 + FOLD_ROW_H + SEC_HEAD_H + OUT_MAX_H);
    // 超长程文（2026-08-30 溢出修复钉值）：程序体内容预算 320-20 内距、文本宽
    // w-17 内缩；输出截断到 200（.pp-code .pp-out 上限——2026-09-14 内距归段头）
    layoutMock.mockReturnValueOnce({ height: 9999, lineCount: 999 });
    layoutMock.mockReturnValueOnce({ height: 9999, lineCount: 999 });
    const code = block('code', {
      toolId: 't',
      description: 'd',
      code: 'x'.repeat(1000),
      status: 'done',
      output: 'y'.repeat(1000),
    });
    expect(measureBlockHeight(code)).toBe(
      10 + FOLD_ROW_H + CODE_SRC_MAX_H + SEC_HEAD_H + SEC_HEAD_GAP + CODE_OUT_TEXT_MAX,
    );
    expect(layoutMock).toHaveBeenCalled();
  });

  it('FIFO 淘汰：缓存超 500 条目时最早的被逐出（重复测量重新 prepare）', () => {
    // 填满 500 条（上限内，无淘汰），第 501 条插入触发最早条目逐出
    for (let i = 0; i < 500; i++) {
      measureTextHeight('fifo-' + i, 600);
    }
    const callsAfterFill = prepareMock.mock.calls.length;
    measureTextHeight('fifo-overflow', 600); // 第 501 条：插入即逐出 fifo-0
    expect(prepareMock.mock.calls.length).toBe(callsAfterFill + 1);
    measureTextHeight('fifo-0', 600); // 已被逐出 → miss → 重新 prepare
    expect(prepareMock.mock.calls.length).toBe(callsAfterFill + 2);
    // 最新插入的仍在缓存：hit 不增 prepare
    measureTextHeight('fifo-overflow', 600);
    expect(prepareMock.mock.calls.length).toBe(callsAfterFill + 2);
  });
});

/* ═══ 虚拟化 ═══ */

describe('paper/virtualize', () => {
  // 构造一个 10 块流：每块高 100，间距 0（简化），顶边 y = -1000 + i*100
  const flow: FlowGeom[] = Array.from({ length: 10 }, (_, i) => ({
    id: 'f' + i,
    y: -1000 + i * 100,
    h: 100,
    x: -360,
    w: 720,
  }));

  it('viewportWorldRect：屏幕 [0,w]×[0,h] → 世界矩形互逆', () => {
    const v = { panX: 500, panY: 704, zoom: 2 };
    const rect = viewportWorldRect(v, 1000, 800);
    // 左上角世界坐标 = (0-500)/2 = -250, (0-704)/2 = -352
    expect(rect.x0).toBe(-250);
    expect(rect.y0).toBe(-352);
    expect(rect.x1).toBe((1000 - 500) / 2);
    expect(rect.y1).toBe((800 - 704) / 2);
  });

  it('visibleFlowWindow：视口中部 → 连续区间（含与上缘相接的块）', () => {
    // 视口世界 y ∈ [-600, -100]：块 3 底边恰为 -600（相接可见）→ 块 3..9
    const rect = { x0: -1e9, y0: -600, x1: 1e9, y1: -100 };
    const w = visibleFlowWindow(flow, rect);
    expect(w.first).toBe(3);
    expect(w.lastExcl).toBe(10);
  });

  it('visibleFlowWindow：视口在流上方（全不可见）→ 空区间', () => {
    const rect = { x0: 0, y0: -2000, x1: 100, y1: -1500 };
    const w = visibleFlowWindow(flow, rect);
    expect(w.first).toBe(0);
    expect(w.lastExcl).toBe(0);
  });

  it('visibleFlowWindow：视口跨流尾（最新块在锚点 y=0）→ 含最后一块', () => {
    const rect = { x0: -1e9, y0: -50, x1: 1e9, y1: 500 };
    const w = visibleFlowWindow(flow, rect);
    expect(w.first).toBe(9);
    expect(w.lastExcl).toBe(10);
  });

  it('visibleFlowWindow：overscan 外扩吃进相邻块', () => {
    // 紧贴块 5 顶边（y=-500）的视口上缘，overscan=150 吃进块 3/4
    const rect = { x0: -1e9, y0: -500, x1: 1e9, y1: -400 };
    const w = visibleFlowWindow(flow, rect, 150);
    expect(w.first).toBe(3); // -500-150=-650 → 第一个底边≥-650 的是块 3
  });

  it('visibleFlowWindow：空流 → 空区间', () => {
    const w = visibleFlowWindow([], { x0: 0, y0: 0, x1: 10, y1: 10 });
    expect(w.first).toBe(0);
    expect(w.lastExcl).toBe(0);
  });

  it('visiblePinnedIds：矩形相交保留，不相交剔除', () => {
    const pinned: PinnedGeom[] = [
      { id: 'p1', x: 1000, y: -500, w: 720, h: 300 },
      { id: 'p2', x: -2000, y: -3000, w: 720, h: 300 },
      { id: 'p3', x: 800, y: -400, w: 720, h: 300 }, // 右伸 x∈[800,1520] 与矩形 x1=1500 相交
    ];
    const rect = { x0: -500, y0: -1000, x1: 1500, y1: 0 };
    expect(visiblePinnedIds(pinned, rect)).toEqual(['p1', 'p3']);
  });

  it('rectsIntersect 谓词（含边界相接）', () => {
    const a = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(rectsIntersect(a, { x0: 10, y0: 10, x1: 20, y1: 20 })).toBe(true); // 边相接
    expect(rectsIntersect(a, { x0: 10.1, y0: 0, x1: 20, y1: 10 })).toBe(false);
  });

  it('平移/缩放组合下窗口跟随（真实视口变换全链路）', () => {
    // 初始视口（落位几何：1000×800，最新块底边贴下缘上方 96px → 锚点屏幕 (500, 704)、zoom 1）
    // 注：落位算式自 2026-09-17 归产地域（`plugins/builtin/paper-shell/landing.ts`），
    //     本用例只借它当夹具，故直接写字面值，不跨域取函数。
    let v = { panX: 500, panY: 800 - 96, zoom: 1 };
    // 视口世界 y ∈ [-704, 96] → 可见块：底边 ≥ -704 的第一个 = 块 2（-800..-700）
    let w = visibleFlowWindow(flow, viewportWorldRect(v, 1000, 800));
    expect(w.first).toBe(2);
    expect(w.lastExcl).toBe(10);
    // 沿流向上看更旧内容：把纸往下拖 300px（panY 增大）→ y ∈ [-1004, -204]
    v = panBy(v, 0, 300);
    w = visibleFlowWindow(flow, viewportWorldRect(v, 1000, 800));
    expect(w.first).toBe(0); // 块 0 顶 -1000 已进视口
    expect(flow[w.lastExcl - 1].y).toBeLessThanOrEqual(-204 + 1);
    // 放大 2 倍（围绕视口中心）：世界窗口减半 → 可见块更少
    v = zoomAt(v, 500, 400, 2);
    const rect = viewportWorldRect(v, 1000, 800);
    const w2 = visibleFlowWindow(flow, rect);
    expect(w2.lastExcl - w2.first).toBeLessThan(w.lastExcl - w.first);
  });
});

/* ═══ 抽纸条（待定 #10 定案）═══ */

describe('paper/selection', () => {
  beforeEach(() => resetStripIdCounterForTests());

  it('makeStrip：拷贝语义快照 + 世界坐标', () => {
    const s = makeStrip('一段引用文字', 300, -200);
    expect(s.id.startsWith('strip')).toBe(true);
    expect(s.text).toBe('一段引用文字');
    expect(s.x).toBe(300);
    expect(s.y).toBe(-200);
    expect(s.w).toBe(480);
  });

  it('strip id 单调唯一、与块 id 空间区分', () => {
    const a = makeStrip('a', 0, 0);
    const b = makeStrip('b', 0, 0);
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith('pb')).toBe(false);
  });

  it('moveStrip 只改坐标', () => {
    const s = moveStrip(makeStrip('t', 0, 0), 5, -5);
    expect(s.x).toBe(5);
    expect(s.y).toBe(-5);
    expect(s.text).toBe('t');
  });

  it('sliceSelection：边界夹取 + 双向容错', () => {
    expect(sliceSelection('0123456789', 2, 5)).toBe('234');
    expect(sliceSelection('0123456789', 5, 2)).toBe('234'); // 反向选区
    expect(sliceSelection('0123456789', -3, 99)).toBe('0123456789'); // 越界夹取
  });

  it('tryMakeStripFromSelection：纯空白选区不产生纸条（手势落空）', () => {
    expect(tryMakeStripFromSelection('   \n  ', 0, 5, 0, 0)).toBeNull();
    expect(tryMakeStripFromSelection('', 0, 0, 0, 0)).toBeNull();
    const ok = tryMakeStripFromSelection('  有货  ', 0, 5, 10, -10);
    expect(ok).not.toBeNull();
    expect(ok?.text).toBe('有货'); // trim
  });

  it('selectionMaskRects：屏幕矩形 → 世界矩形（lift 遮罩定位原语）', () => {
    const view = { panX: 100, panY: -50, zoom: 0.5 };
    const origin = { x: 10, y: 20 };
    const masks = selectionMaskRects(
      [
        // screen = world*zoom + pan + 画布原点 → world = (screen - 原点 - pan) / zoom
        { left: 110, top: 30, right: 210, bottom: 62, width: 100, height: 32 },
        { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, // 折叠边缘矩形跳过
      ],
      view,
      origin,
    );
    expect(masks).toHaveLength(1);
    expect(masks[0]).toEqual({ x: 0, y: 120, w: 200, h: 64 });
  });

  it('selectionMaskRects：跨行选区产出多矩形（逐行遮罩）', () => {
    const masks = selectionMaskRects(
      [
        { left: 0, top: 0, right: 300, bottom: 20, width: 300, height: 20 },
        { left: 0, top: 20, right: 120, bottom: 40, width: 120, height: 20 },
      ],
      { panX: 0, panY: 0, zoom: 1 },
      { x: 0, y: 0 },
    );
    expect(masks).toHaveLength(2);
    expect(masks[1]).toEqual({ x: 0, y: 20, w: 120, h: 20 });
  });
});

/* ═══ IME 安全谓词（V3a spike·待定 #8 前置验证）═══ */

describe('paper/ime', () => {
  it('合成中的 Enter（候选确认）不提交', () => {
    expect(composerSubmitOnKey('Enter', true, false)).toBe(false);
  });
  it('合成结束后的 Enter 正常提交', () => {
    expect(composerSubmitOnKey('Enter', false, false)).toBe(true);
  });
  it('Safari 反序时序（compositionend 先于 keydown）也安全：keydown 时 isComposing 已 false → 提交', () => {
    // 反序场景下用户意图就是换行/提交，谓词判据是 keydown 当刻标志——正确放行
    expect(composerSubmitOnKey('Enter', false, false)).toBe(true);
  });
  it('Shift+Enter 不提交（留给 textarea 原生换行，2026-09-03 补判）', () => {
    expect(composerSubmitOnKey('Enter', false, true)).toBe(false);
    // IME 组合中按 Shift+Enter 同样不提交（双保险）
    expect(composerSubmitOnKey('Enter', true, true)).toBe(false);
  });
  it('非 Enter 键一律不提交（含 IME 导航键）', () => {
    expect(composerSubmitOnKey('ArrowDown', false, false)).toBe(false);
    expect(composerSubmitOnKey('Escape', false, false)).toBe(false);
    expect(composerSubmitOnKey('Enter', true, false)).toBe(false);
  });
});

/* ═══ 测量 × 布局链路（mock 测量与真实布局的接缝）═══ */

describe('paper/measure → layoutFlow 接缝', () => {
  it('测量高度喂 layoutFlow：最新块底边贴锚点不变（D-R1-3 几何不因测量来源漂移）', async () => {
    const { layoutFlow, ANCHOR } = await import('../src/paper/canvas-math');
    const blocks = [
      block('markdown', { text: 'a' }),
      block('markdown', { text: 'b' }),
      block('markdown', { text: 'c' }),
    ];
    const laid = layoutFlow(blocks.map((b) => ({ id: b.id, h: measureBlockHeight(b), w: b.w })));
    const last = blocks[blocks.length - 1];
    // 最新块底边 = y + h = 0（锚点）
    expect(laid.get(last.id)?.y).toBe(-measureBlockHeight(last));
    // 块间 gap 语义：中块底 = 新块顶 - gap
    const mid = blocks[1];
    expect(laid.get(mid.id)?.y).toBe(-measureBlockHeight(last) - ANCHOR.blockGap - measureBlockHeight(mid));
    void DEFAULT_BLOCK_WIDTH;
  });
});

/* ═══ 块级测量缓存（性能专项第一刀：签名未变零重测）═══ */

describe('paper/measure 块级缓存', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('签名不变 → 命中块级缓存，不重复真测（layout 不二次调用）', () => {
    const cache = createBlockMeasureCache();
    const b = block('markdown', { text: '稳定文本' });
    expect(measureBlockHeightCached(b, cache)).toBe(36);
    expect(layoutMock).toHaveBeenCalledTimes(1);
    measureBlockHeightCached(b, cache);
    expect(layoutMock).toHaveBeenCalledTimes(1); // 命中缓存，未重测
  });

  it('内容签名变 → 该块重测，其余块仍命中（流式只真测被触碰块）', () => {
    const cache = createBlockMeasureCache();
    const stable = block('markdown', { text: 'stable' });
    const growing = block('markdown', { text: 'v1' });
    measureBlockHeightCached(stable, cache);
    measureBlockHeightCached(growing, cache);
    layoutMock.mockClear();
    // 流式：growing 文本变长（block id 不变、payload 原位变更）
    growing.payload.text = 'v1 变长';
    measureBlockHeightCached(stable, cache); // 命中，零真测
    measureBlockHeightCached(growing, cache); // 重测一次
    expect(layoutMock).toHaveBeenCalledTimes(1);
  });

  it('不同块同签名各自记账（key 是块 id 而非内容）', () => {
    const cache = createBlockMeasureCache();
    const a = block('markdown', { text: '同文本' });
    const b = block('markdown', { text: '同文本' });
    measureBlockHeightCached(a, cache);
    measureBlockHeightCached(b, cache);
    expect(layoutMock).toHaveBeenCalledTimes(2);
  });
});

/* ═══ 富行内精确测量（P3 rich-inline：0.96 系数退役）═══ */

describe('paper/measure 富行内（P3）', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    prepareRichMock.mockClear();
    richStatsMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('富行内走 rich 路径且宽度不打折（0.96 偏窄系数死刑验证）', () => {
    const b = block('markdown', { text: '一段**加粗**正文' });
    measureBlockHeight(b);
    expect(prepareRichMock).toHaveBeenCalledTimes(1);
    expect(layoutMock).not.toHaveBeenCalled(); // 富标志不再落回纯文本近似路
    const widthArg = richStatsMock.mock.calls[0][1];
    expect(widthArg).toBe(b.w); // 段落原宽——不再 ×0.96
  });

  it('纯文本仍走 prepare+layout 旧路（rich 零接触，存量语义不变）', () => {
    measureBlockHeight(block('markdown', { text: '两行纯文本' }));
    expect(prepareRichMock).not.toHaveBeenCalled();
    expect(layoutMock).toHaveBeenCalledTimes(1);
  });

  it('rich 缓存命中：同内容二次测量只 prepare 一次（FIFO 同 prepareCache 纪律）', () => {
    const b = block('markdown', { text: '**粗**体' });
    measureBlockHeight(b);
    measureBlockHeight(b);
    expect(prepareRichMock).toHaveBeenCalledTimes(1);
  });

  it('圈点来文走 rich：圈点段 = 原子件 + 椭圆 chrome 11 + 600 楷体', () => {
    richStatsMock.mockReturnValueOnce({ lineCount: 1, maxLineWidth: 100 });
    const h = measureBlockHeight(block('user', { text: '看这个【关键词】位置' }));
    const items = prepareRichMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    const circled = items.find((it) => it.extraWidth !== undefined);
    expect(circled).toMatchObject({ text: '关键词', break: 'never', extraWidth: CIRCLE_EXTRA });
    expect(String(circled?.font)).toContain('600');
    // mock lineCount=1 → 文本高 = 1×PAPER_USER_LINE_HEIGHT，加题签 48 + asterism 44（2026-08-30 标题化）
    expect(h).toBe(48 + PAPER_USER_LINE_HEIGHT + 44);
  });

  it('圈点来文逐行拆解：空行占一行（pre-wrap 硬换行语义）', () => {
    richStatsMock.mockReturnValue({ lineCount: 1, maxLineWidth: 100 });
    const h = measureBlockHeight(block('user', { text: '上【词】\n\n下' }));
    // 三行：上（rich 1 行）+ 空行（占一行）+ 下（rich 1 行）→ 3 × 行高 + 题签 48 + asterism
    expect(h).toBe(48 + 3 * PAPER_USER_LINE_HEIGHT + 44);
    expect(prepareRichMock).toHaveBeenCalledTimes(2); // 空行不进 rich
  });
});
