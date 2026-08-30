// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-ink — P4 缩远墨迹：墨条几何（walkLineRanges 路径）/ LOD 迟滞 /
// 墨色板 token 字面量镜像钉死。pretext 全 mock（jsdom 无 Canvas 2D）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { walkMock, naturalWidthMock, materializeMock } = vi.hoisted(() => ({
  walkMock: vi.fn(
    (_prepared: unknown, _width: number, onLine: (line: { width: number; start: unknown; end: unknown }) => void) => {
      // 固定两行折行（宽 100 / 80）——行条几何的确定桩
      onLine({ width: 100, start: null, end: null });
      onLine({ width: 80, start: null, end: null });
      return 2;
    },
  ),
  naturalWidthMock: vi.fn(() => 200),
  materializeMock: vi.fn(() => ({ text: '测试行', width: 100, start: null, end: null })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _segs: true })),
  walkLineRanges: walkMock,
  materializeLineRange: materializeMock,
  measureNaturalWidth: naturalWidthMock,
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 1, maxLineWidth: 100 })),
}));

import { createBlock, resetBlockIdCounterForTests } from '../src/paper/block-model';
import {
  createInkCache,
  INK_COLORS,
  inkColorOf,
  inkForBlock,
  inkForText,
  LOD_ENTER,
  LOD_EXIT,
  lodActive,
} from '../src/paper/ink';
import { clearPaperMeasureCache } from '../src/paper/measure';

function block(kind: Parameters<typeof createBlock>[0], payload: object) {
  return createBlock(kind, payload as never, { messageId: 'm', part: null });
}

/* ═══ LOD 迟滞 ═══ */

describe('paper/ink LOD 迟滞', () => {
  it('未激活：跌破进入阈才激活', () => {
    expect(lodActive(0.6, false)).toBe(false);
    expect(lodActive(LOD_ENTER, false)).toBe(false); // 半开区间：< 才进
    expect(lodActive(0.5, false)).toBe(true);
  });
  it('已激活：回升需越过退出阈（阈值间往返不闪烁）', () => {
    expect(lodActive(0.58, true)).toBe(true); // 0.55-0.62 之间保持
    expect(lodActive(0.619, true)).toBe(true);
    expect(lodActive(LOD_EXIT, true)).toBe(false); // 退出阈半开：≥ 即退
    expect(lodActive(0.7, true)).toBe(false);
  });
});

/* ═══ 墨色板（tokens.css 字面量镜像钉死——改 token 两处同步）═══ */

describe('paper/ink INK_COLORS 镜像', () => {
  it('文类→墨色铁律：正文=墨 / 来文=朱砂 / 夹注=赭石 / 脚注族=石青 / 贴黄=次级', () => {
    expect(INK_COLORS.markdown).toBe('#26221c'); // --ink-1
    expect(INK_COLORS.user).toBe('#a63a2e'); // --seal
    expect(INK_COLORS.reasoning).toBe('#6f6e68'); // --graphite
    expect(INK_COLORS.tool).toBe('#3a5b7a'); // --indigo
    expect(INK_COLORS.code).toBe('#3a5b7a');
    expect(INK_COLORS.diff).toBe('#3a5b7a');
    expect(INK_COLORS.plan).toBe('#3a5b7a');
    expect(INK_COLORS.notice).toBe('#55503f'); // --ink-2
    expect(inkColorOf('chart')).toBe('#8a8172'); // 资产/未知 → --ink-3
  });
});

/* ═══ 墨条几何 ═══ */

describe('paper/ink inkForBlock', () => {
  beforeEach(() => {
    walkMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('来文块：逐行真实行宽 + 行原文（materialize 缩微直绘用）', () => {
    const cache = createInkCache();
    const b = block('user', { text: '一段来文' });
    b.w = 560;
    const ink = inkForBlock(b, false, cache);
    // mock 每次走查出 2 行：bars = 2，dy 依次 0 / lineHeight
    expect(ink.bars).toHaveLength(2);
    expect(ink.bars[0]).toMatchObject({ dy: 0, x0: 20, text: '测试行' }); // USER_TEXT_INSET
    expect(ink.bars[1]).toMatchObject({ dy: 16 * 1.9, text: '测试行' });
    expect(ink.lineH).toBe(16 * 1.9);
    expect(ink.size).toBe(16); // 来文楷体字号（缩放直绘用）
  });

  it('缓存命中：同签名二次取墨不重复走查', () => {
    const cache = createInkCache();
    const b = block('user', { text: '稳定' });
    b.w = 560;
    inkForBlock(b, false, cache);
    const calls = walkMock.mock.calls.length;
    inkForBlock(b, false, cache);
    expect(walkMock.mock.calls.length).toBe(calls);
  });

  it('折叠夹注 → 桩条（空 text 走矩形路径，单根短墨保「有物」观感）', () => {
    const cache = createInkCache();
    const b = block('reasoning', { text: '思考' });
    b.w = 720;
    const ink = inkForBlock(b, true, cache);
    expect(ink.bars).toHaveLength(1);
    expect(ink.bars[0]).toMatchObject({ dy: 0, x0: 0, text: '' });
  });

  it('脚注多源：args + output 顺序累计 dy（输出段接在参数段之后）', () => {
    const cache = createInkCache();
    const b = block('tool', { toolId: 't', name: 'n', label: 'l', args: '{}', status: 'done', output: 'out' });
    b.w = 640;
    const ink = inkForBlock(b, false, cache);
    // args（2 行）+ output（2 行）= 4 条；第 3 条 dy = 2 × 脚注行高
    expect(ink.bars).toHaveLength(4);
    expect(ink.bars[2].dy).toBe(2 * 11.5 * 1.6);
  });

  it('签名/宽度变化 → 重算（收缩与 resize 改宽必出新墨）', () => {
    const cache = createInkCache();
    const b = block('user', { text: '一段来文' });
    b.w = 560;
    inkForBlock(b, false, cache);
    const calls = walkMock.mock.calls.length;
    b.w = 400;
    inkForBlock(b, false, cache);
    expect(walkMock.mock.calls.length).toBeGreaterThan(calls);
  });
});

describe('paper/ink inkForText（纸条）', () => {
  it('纸条墨条：.pp-strip 镜像行高与内缩', () => {
    const ink = inkForText('纸条文字', 480);
    expect(ink.lineH).toBe(12.5 * 1.7);
    expect(ink.bars[0]?.x0).toBe(12);
  });
});
