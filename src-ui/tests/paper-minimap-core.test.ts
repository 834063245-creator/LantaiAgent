// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/minimap-core — 小地图纯函数（R3 多卷版）测试。
// 覆盖：投影（minimapProject）、卷色盘（regionColor）、墨条投影（inkBarsFor：
// 非 stub 真墨 / stub 占位砖）、卷框（regionFrame：非 stub 几何 / stub extent）。
// pretext 全 mock（jsdom 无 Canvas 2D）——沿用 paper-ink.test.ts 同款手法。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _segs: true })),
  walkLineRanges: vi.fn((_p: unknown, _w: number, onLine: (l: { width: number }) => void) => {
    onLine({ width: 100 });
    return 1;
  }),
  materializeLineRange: vi.fn(() => ({ text: '行', width: 100 })),
  measureNaturalWidth: vi.fn(() => 100),
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn(() => ({})),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 1, maxLineWidth: 100 })),
}));

import { createInkCache } from '../src/paper/ink';
import { clampViewportFrame, inkBarsFor, minimapProject, regionColor, regionFrame } from '../src/paper/minimap-core';
import type { RegionView } from '../src/paper/region-view';

const CONTENT = { x0: 0, y0: 0, x1: 800, y1: 600 };
const PROJ = minimapProject(CONTENT, 156, 116);

function stubRegion(over?: Partial<RegionView>): RegionView {
  return {
    sessionId: '1',
    sessionNum: 0,
    label: '案卷 1',
    anchor: { anchorX: 0, anchorY: 0, width: 720 },
    blocks: [],
    layout: new Map(),
    flowGeom: [],
    pinnedGeom: [],
    flowWindow: { first: 0, lastExcl: 0 },
    visibleIds: new Set(),
    seq: new Map(),
    units: [],
    stageLeadIds: new Set(),
    regionTop: -200,
    regionBottom: 0,
    regionHeight: 200,
    folioH: 32,
    writingBlockId: null,
    ...over,
  };
}

describe('minimapProject 投影', () => {
  it('等比缩放 + 居中留白（pad=8）', () => {
    // 800×600 内容 → 画布 156×116 内 pad 8 → 可用 148×108
    // 按宽度：148/800 = 0.185；按高度：108/600 = 0.18 → 取小 0.18
    expect(PROJ.scale).toBeCloseTo(0.18);
    // 居中偏移：宽 (148 - 800*0.18)/2 = (148-144)/2 = 2
    expect(PROJ.offX).toBeCloseTo(2);
    expect(PROJ.offY).toBeCloseTo((108 - 600 * 0.18) / 2);
  });

  it('空内容/退化包围盒不炸（scale 取可用面内最大值）', () => {
    const p = minimapProject({ x0: 100, y0: 100, x1: 100, y1: 100 }, 156, 116);
    // cw/ch 兜底 1 → scale = min(148/1, 108/1) = 108
    expect(p.scale).toBe(108);
    expect(Number.isFinite(p.offX)).toBe(true);
    expect(Number.isFinite(p.offY)).toBe(true);
  });
});

describe('regionColor 卷色盘', () => {
  it('按序循环取色（多卷可区分）', () => {
    const c0 = regionColor(0);
    const c1 = regionColor(1);
    const c2 = regionColor(2);
    expect(c0).not.toBe(c1);
    expect(c1).not.toBe(c2);
    expect(c0).not.toBe(c2);
    // 循环：6 色盘
    expect(regionColor(0)).toBe(regionColor(6));
    expect(regionColor(1)).toBe(regionColor(7));
  });
});

describe('inkBarsFor 墨条投影', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('非 stub 卷：真墨条（块 layout 投影到小地图内）', () => {
    const region = stubRegion({
      blocks: [
        {
          id: 'b1',
          kind: 'markdown',
          state: 'flow',
          payload: { text: '一行正文' },
          w: 720,
        } as never,
      ],
      // 块放在 content（0..800 × 0..600）内：x=100, y=-100
      layout: new Map([['b1', { x: 100, y: -100 }]]),
      flowGeom: [{ id: 'b1', x: 100, y: -100, w: 720, h: 30 }],
    });
    const bars = inkBarsFor(region, () => false, createInkCache(), CONTENT, PROJ);
    // 有墨条 + 坐标在小地图范围内（x=100 世界点 → 4+(100-0)*0.18+offX ≈ 24）
    expect(bars.length).toBeGreaterThan(0);
    expect(bars[0]!.x).toBeGreaterThan(0);
    expect(bars[0]!.x).toBeLessThan(156);
  });

  it('stub 卷：占位砖（extent + blockCount 估算）', () => {
    const region = stubRegion({
      stubbed: true,
      extent: { x0: 5000, y0: -4000, x1: 5720, y1: -300 },
      lastBlockCount: 40,
    });
    const bars = inkBarsFor(region, () => false, createInkCache(), CONTENT, PROJ);
    expect(bars.length).toBe(1);
    expect(bars[0]!.kind).toBe('stub');
    // 估算高度：40*6*scale → 取 min(整框高, 估算)
    expect(bars[0]!.h).toBeGreaterThan(0);
    expect(bars[0]!.h).toBeLessThanOrEqual((5720 - 5000) * PROJ.scale);
  });
});

describe('regionFrame 卷框', () => {
  it('非 stub：用 flowGeom/pinnedGeom 求包围盒', () => {
    const region = stubRegion({
      flowGeom: [
        { id: 'a', x: -360, y: -200, w: 720, h: 40 },
        { id: 'b', x: -360, y: -160, w: 720, h: 40 },
      ],
    });
    const f = regionFrame(region, CONTENT, PROJ);
    expect(f).not.toBeNull();
    // 包围盒 = 覆盖两块几何：x -360→360（宽 720），y -200→-120（高 80）
    expect(f!.w).toBeCloseTo(720 * PROJ.scale);
    expect(f!.h).toBeCloseTo(80 * PROJ.scale);
    expect(f!.x).toBeCloseTo(4 + (-360 - CONTENT.x0) * PROJ.scale + PROJ.offX);
    expect(f!.y).toBeCloseTo(4 + (-200 - CONTENT.y0) * PROJ.scale + PROJ.offY);
  });

  it('stub：用 extent 包围盒', () => {
    const region = stubRegion({
      stubbed: true,
      extent: { x0: 100, y0: 100, x1: 300, y1: 200 },
    });
    const f = regionFrame(region, CONTENT, PROJ);
    expect(f).not.toBeNull();
    expect(f!.w).toBeCloseTo(200 * PROJ.scale);
    expect(f!.h).toBeCloseTo(100 * PROJ.scale);
  });

  it('空卷（无几何无 extent）返回 null', () => {
    const region = stubRegion();
    expect(regionFrame(region, CONTENT, PROJ)).toBeNull();
  });
});

describe('clampViewportFrame 视口框保险丝（红框事故回归）', () => {
  it('正常视口：不裁剪（原值保持）', () => {
    const f = clampViewportFrame({ left: 10, top: 8, width: 100, height: 60 }, 156, 116);
    expect(f).toEqual({ left: 10, top: 8, width: 100, height: 60 });
  });

  it('巨大视口（内容极小 → scale 巨大）：宽/高 clamp 到容器内', () => {
    // 模拟空卷场景：content 兜底极小（如视口外扩 ±1 且视口 1600×900）
    // → scale 巨大 → 视口框投影 2000px 宽 → 必须 clamp 到 154
    const f = clampViewportFrame({ left: -900, top: -400, width: 2000, height: 1200 }, 156, 116);
    expect(f.left).toBeGreaterThanOrEqual(2);
    expect(f.top).toBeGreaterThanOrEqual(2);
    expect(f.width).toBeLessThanOrEqual(154);
    expect(f.height).toBeLessThanOrEqual(114);
    expect(f.width).toBeGreaterThanOrEqual(2);
  });

  it('越界位置：left/top clamp 回容器内', () => {
    const f = clampViewportFrame({ left: 800, top: 500, width: 50, height: 40 }, 156, 116);
    expect(f.left).toBeLessThanOrEqual(154);
    expect(f.top).toBeLessThanOrEqual(114);
  });
});
