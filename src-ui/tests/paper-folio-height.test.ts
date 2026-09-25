// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷首测高契约（2026-09-16「版心天头」重排配套**行为测**）——与
// paper-visual-decisions.test.ts 的**源文本钉值**互补：那边钉「CSS/token 字面量有
// 没有被偷改」，这边钉「测高函数的行为对不对」。钉值全绿而行为错是最坏情形，
// 本批修的正是这一类：CSS 与 token 都写着题字 32px/1.2，但调用点手写
// `anchor.width - 32` 漏了 720 版心封顶 —— 默认 1440 宽流区实得「可用宽 1408」，
// 长题字永不换行，实测卷首高度与实际渲染的换行长期不符。
//
// pretext 是真实文本引擎（node 下要 OffscreenCanvas）——此处按纸面测高约定打桩：
// 每字宽 = 字号（CJK 全角 ≈ 1em），行数 = ceil(内容宽 / 可用宽)，高 = 行数 × 行高。
// 桩让「可用宽」成为可观测量（layoutMock 记下每次 maxWidth），这正是被测语义。

import { describe, expect, it, vi } from 'vitest';

const layoutMock = vi.hoisted(() => vi.fn());

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

const { measureFolioHeadHeight } = await import('../src/plugins/builtin/paper-shell/measure');
const { FOLIO_TOKENS } = await import('../src/plugins/builtin/paper-shell/type-tokens');

/** 每字宽 = 题字号（全角汉字 ≈ 1em）。 */
const GLYPH_W = FOLIO_TOKENS.titleSize;
/** 本桩下的行高（measure.ts 传的是 FOLIO_TITLE_LINE_HEIGHT）。 */
const LINE_H = FOLIO_TOKENS.titleSize * FOLIO_TOKENS.titleLh;

layoutMock.mockImplementation((p: { _text: string }, maxWidth: number, lineHeight: number) => {
  const lineCount = Math.max(1, Math.ceil((p._text.length * GLYPH_W) / maxWidth));
  return { height: lineCount * lineHeight, lineCount };
});

/** 固定结构高度（不含题字与头距）：与 measure.ts 的求和式逐项对应。 */
const FIXED_H =
  FOLIO_TOKENS.padTop +
  FOLIO_TOKENS.yuweiH +
  FOLIO_TOKENS.eyebrowH +
  FOLIO_TOKENS.titleMarginTop +
  FOLIO_TOKENS.subMarginTop +
  FOLIO_TOKENS.subH +
  FOLIO_TOKENS.padBottom;

/** 39 字 → 内容宽 1404：可用宽 720 时 2 行、688 时 3 行（版心封顶可观测）。 */
const LONG = '卷'.repeat(39);

/** 最近一次测高用到的题字可用宽。 */
function lastAvailWidth(): number {
  const call = layoutMock.mock.calls.at(-1);
  return call ? (call[1] as number) : Number.NaN;
}

describe('卷首测高契约（measureFolioHeadHeight）', () => {
  it('① 宽流区：题字可用宽封在版心 720，不再是「流区宽 − 32」', () => {
    for (const regionW of [800, 1000, 1440, 2160]) {
      layoutMock.mockClear();
      const h = measureFolioHeadHeight('卷首题字', regionW);
      expect(lastAvailWidth()).toBe(FOLIO_TOKENS.colW);
      expect(h).toBeCloseTo(measureFolioHeadHeight('卷首题字', 1440), 6);
    }
  });

  it('① 窄流区：可用宽退为「流区宽 − 32」（左右内距 16×2）', () => {
    layoutMock.mockClear();
    measureFolioHeadHeight('卷首题字', FOLIO_TOKENS.colW);
    expect(lastAvailWidth()).toBe(FOLIO_TOKENS.colW - 32);
  });

  it('② 宽流区收窄到版心前不再影响高度；越过版心后题字多折一行、卷首变高', () => {
    const wide = measureFolioHeadHeight(LONG, 1440); // 可用宽 720 → 2 行
    const mid = measureFolioHeadHeight(LONG, 800); // 可用宽 720 → 2 行（同）
    const narrow = measureFolioHeadHeight(LONG, FOLIO_TOKENS.colW); // 可用宽 688 → 3 行
    expect(mid).toBeCloseTo(wide, 6);
    expect(narrow).toBeCloseTo(wide + LINE_H, 6);
  });

  it('③ 单行题字：总高 = 固定结构 + 一行题字 + 头距（headGap 已并入返回值）', () => {
    expect(measureFolioHeadHeight('短名', 1440)).toBeCloseTo(FIXED_H + LINE_H + FOLIO_TOKENS.headGap, 6);
  });

  it('④ 题字换行按行计入（每多一行恰多一个行高）', () => {
    const one = measureFolioHeadHeight('卷'.repeat(18), 1440); // 648 < 720 → 1 行
    const two = measureFolioHeadHeight('卷'.repeat(19), 1440); // 684 < 720 → 1 行
    const three = measureFolioHeadHeight(LONG, 1440); // 2 行
    expect(two).toBeCloseTo(one, 6);
    expect(three).toBeCloseTo(one + LINE_H, 6);
  });
});
