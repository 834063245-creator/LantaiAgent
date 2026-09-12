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
  INK_BAR_COLORS,
  INK_COLORS,
  inkBarColorOf,
  inkColorOf,
  inkForBlock,
  LOD_BAR_ENTER,
  LOD_BAR_EXIT,
  LOD_ENTER,
  LOD_EXIT,
  LOD_SIL_ENTER,
  LOD_SIL_EXIT,
  lodActive,
  lodFarActive,
  lodTierOf,
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

/* ═══ 远景三档（P4c，2026-09-06）——档位判定与迟滞 ═══ */

describe('paper/ink 远景三档（P4c）', () => {
  it('文字档 → 行影档：跌破 0.36 进，回升越过 0.39 才出（阈值间保持不闪档）', () => {
    expect(lodTierOf(0.55, 'text')).toBe('text');
    expect(lodTierOf(LOD_BAR_ENTER, 'text')).toBe('text'); // 半开：< 才进
    expect(lodTierOf(0.35, 'text')).toBe('bar');
    // 0.36-0.39 之间保持行影（迟滞带）
    expect(lodTierOf(0.37, 'bar')).toBe('bar');
    expect(lodTierOf(LOD_BAR_EXIT, 'bar')).toBe('text'); // ≥ 即回文字
  });
  it('行影档 → 剪影档：跌破 0.14 进，回升越过 0.16 才出', () => {
    expect(lodTierOf(0.2, 'bar')).toBe('bar');
    expect(lodTierOf(LOD_SIL_ENTER, 'bar')).toBe('bar');
    expect(lodTierOf(0.13, 'bar')).toBe('silhouette');
    expect(lodTierOf(0.15, 'silhouette')).toBe('silhouette'); // 迟滞带
    expect(lodTierOf(LOD_SIL_EXIT, 'silhouette')).toBe('bar');
  });
  it('剪影档直跨：极远回升到 0.4 一步回文字档（跨档不粘滞）', () => {
    expect(lodTierOf(0.5, 'silhouette')).toBe('bar'); // 先出剪影档
    expect(lodTierOf(0.5, 'bar')).toBe('text'); // 再出行影档
  });
  it('lodFarActive（DOM 退场旗标）：与行影档同边界同迟滞', () => {
    expect(lodFarActive(0.5, false)).toBe(false);
    expect(lodFarActive(0.35, false)).toBe(true);
    expect(lodFarActive(0.37, true)).toBe(true); // 迟滞带保持
    expect(lodFarActive(LOD_BAR_EXIT, true)).toBe(false);
  });
});

/* ═══ 行影档墨色（P4c 距离墨量补偿——字面量钉死）═══ */

describe('paper/ink INK_BAR_COLORS 行影档镜像（P4c）', () => {
  it('条面 alpha ≈ 文字色面 × 0.45 兑水（远看应有的灰度，非黑墙）', () => {
    expect(INK_BAR_COLORS.markdown).toBe('rgba(38, 34, 28, 0.42)');
    expect(INK_BAR_COLORS.user).toBe('rgba(166, 58, 46, 0.58)'); // 朱砂 landmark 略提亮
    expect(INK_BAR_COLORS.reasoning).toBe('rgba(111, 110, 104, 0.38)');
    expect(INK_BAR_COLORS.tool).toBe('rgba(58, 91, 122, 0.44)');
    expect(inkBarColorOf('chart')).toBe('rgba(38, 34, 28, 0.24)'); // 未知/资产 → 最淡
  });
});

/* ═══ 墨色板（tokens.css 字面量镜像钉死——改 token 两处同步）═══ */

describe('paper/ink INK_COLORS 镜像', () => {
  it('文类→墨色铁律：正文=墨 / 来文=朱砂 / 夹注=赭石 / 脚注族=石青 / 贴黄=次级', () => {
    expect(INK_COLORS.markdown).toBe('rgba(38, 34, 28, 0.94)'); // --ink-1 alpha 墨（2026-08-31 浸墨化 v2）
    expect(INK_COLORS.user).toBe('#a63a2e'); // --seal
    expect(INK_COLORS.reasoning).toBe('#6f6e68'); // --graphite
    expect(INK_COLORS.tool).toBe('#3a5b7a'); // --indigo
    expect(INK_COLORS.code).toBe('#3a5b7a');
    expect(INK_COLORS.diff).toBe('#3a5b7a');
    expect(INK_COLORS.plan).toBe('#3a5b7a');
    expect(INK_COLORS.notice).toBe('rgba(38, 34, 28, 0.7)'); // --ink-2 alpha 墨（2026-08-31 浸墨化 v2）
    expect(inkColorOf('chart')).toBe('rgba(38, 34, 28, 0.48)'); // 资产/未知 → --ink-3 alpha 墨（2026-08-31 浸墨化 v2）
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
    expect(ink.bars[0]).toMatchObject({ dy: 0, x0: 0, text: '测试行' }); // 2026-08-30 标题化：左批线退役，inset=0
    expect(ink.bars[1]).toMatchObject({ dy: 22 * 1.65, text: '测试行' });
    expect(ink.lineH).toBe(22 * 1.65);
    expect(ink.size).toBe(22); // 来文楷体字号（缩放直绘用）——标题化放大
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
    // args 用 JSON 字符串值：容器经 toolDisplay 摊成多行，桩「每段恒 2 行」
    // 的算术就乱了——标量值（顶层串）保住「args 2 行 + output 2 行 = 4 条」的可读账
    const b = block('tool', { toolId: 't', name: 'n', label: 'l', args: '"x"', status: 'done', output: 'out' });
    b.w = 640;
    const ink = inkForBlock(b, false, cache);
    // args（2 行）+ output（2 行）= 4 条；第 3 条 dy = 2 × 脚注行高
    expect(ink.bars).toHaveLength(4);
    expect(ink.bars[2].dy).toBe(2 * 11.5 * 1.6);
  });

  it('F1 无意义参数不进脚注：args "{}" 只剩 output 源（镜像 hasArgsToShow 判据）', () => {
    const cache = createInkCache();
    const b = block('tool', { toolId: 't', name: 'n', label: 'l', args: '{}', status: 'done', output: 'out' });
    b.w = 640;
    const ink = inkForBlock(b, false, cache);
    // 空骨架参数被砍（2026-09-01 三轴审计 F1）——仅 output（2 行）
    expect(ink.bars).toHaveLength(2);
  });

  it('签名/宽度变化 → 重算（收缩与resize 改宽必出新墨）', () => {
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
