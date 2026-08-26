// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Stage-4 §4.4 目次带纯几何：轮次锚点 / 相对高度映射 / 点带反查 / 视口指示。

import { describe, expect, it } from 'vitest';
import {
  buildTurnAnchors,
  nearestAnchorAt,
  type TocRange,
  type TurnAnchorInput,
  tocMapper,
  viewportMarker,
} from '../src/paper/toc';

const RANGE: TocRange = {
  regionTop: -1000,
  regionBottom: 0,
  stripTop: 80,
  stripBottom: 480,
};

describe('paper/toc tocMapper（相对高度）', () => {
  it('线性映射：新块（y 大）靠下，旧块靠上', () => {
    const map = tocMapper(RANGE);
    expect(map(0)).toBe(480); // 最新块底 → 带底
    expect(map(-1000)).toBe(80); // 最旧块顶 → 带顶
    expect(map(-500)).toBe(280); // 中点
  });

  it('零跨度流区不炸（映射钳制）', () => {
    const map = tocMapper({ ...RANGE, regionTop: 0, regionBottom: 0 });
    expect(map(0)).toBe(80);
  });
});

describe('paper/toc buildTurnAnchors（纯 user 轮次锚点）', () => {
  const blocks: TurnAnchorInput[] = [
    { blockId: 'u1', kind: 'user', worldY: -900, worldH: 60, preview: '第一条来文' },
    { blockId: 'a1', kind: 'markdown', worldY: -700, worldH: 120, preview: '正文不应成为锚点' },
    { blockId: 'u2', kind: 'user', worldY: -200, worldH: 60, preview: '第二条来文' },
  ];

  it('只取 user 块，按块中心映射到带内刻度', () => {
    const anchors = buildTurnAnchors(blocks, RANGE);
    expect(anchors.map((a) => a.blockId)).toEqual(['u1', 'u2']);
    // u1 中心 worldY=-870 → (-870+1000)/1000*400+80 = 132
    expect(anchors[0].stripY).toBeCloseTo(132, 2);
    // u2 中心 worldY=-170 → 412
    expect(anchors[1].stripY).toBeCloseTo(412, 2);
    expect(anchors[1].preview).toBe('第二条来文');
  });

  it('无 user 块 → 空锚点', () => {
    const anchors = buildTurnAnchors(
      [{ blockId: 'a1', kind: 'markdown', worldY: -100, worldH: 10, preview: 'x' }],
      RANGE,
    );
    expect(anchors).toEqual([]);
  });
});

describe('paper/toc nearestAnchorAt（点带反查）', () => {
  const anchors = buildTurnAnchors(
    [
      { blockId: 'u1', kind: 'user', worldY: -900, worldH: 60, preview: '一' },
      { blockId: 'u2', kind: 'user', worldY: -200, worldH: 60, preview: '二' },
    ],
    RANGE,
  );

  it('取最近的轮次锚点', () => {
    expect(nearestAnchorAt(100, anchors)?.blockId).toBe('u1');
    expect(nearestAnchorAt(300, anchors)?.blockId).toBe('u2');
    expect(nearestAnchorAt(500, anchors)?.blockId).toBe('u2'); // 超出取最末
  });

  it('空锚点 → null', () => {
    expect(nearestAnchorAt(100, [])).toBeNull();
  });
});

describe('paper/toc viewportMarker（位置指示）', () => {
  it('视口区间与流区内容求交 → 带上的区间', () => {
    const marker = viewportMarker(-600, -200, RANGE);
    expect(marker).not.toBeNull();
    // -600 → 240, -200 → 400
    expect(marker!.top).toBeCloseTo(240, 2);
    expect(marker!.bottom).toBeCloseTo(400, 2);
  });

  it('视口在流区内容之外 → null（不显示指示）', () => {
    expect(viewportMarker(100, 500, RANGE)).toBeNull();
    expect(viewportMarker(-2000, -1500, RANGE)).toBeNull();
  });
});
