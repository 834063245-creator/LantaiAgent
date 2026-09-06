// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 小地图包围盒域（paper-panel-split C4）——跨流区内容聚落 + 公共物（纸条 +
// 孤儿钉快照）计入画布范围。P2-3：包围盒只依赖内容侧（几何/纸条/孤儿钉）——
// 复合键缓存，平移帧零重扫（O(总块数) 降为 O(卷数) 键比较）；视口框随帧轻包装。

import { useMemo, useRef } from 'react';
import type { PaperStrip, RegionView } from './host';
import { sameKey } from './use-paper-regions';

/** 小地图包围盒（paper-panel-split C4，自 PaperPanel 2192-2262 域内原样搬入）。 */
export function useMinimapBounds(params: {
  regions: RegionView[];
  canvasStrips: PaperStrip[];
  orphanPins: Array<[string, { x: number; y: number; w: number }]>;
  viewRect: { x0: number; y0: number; x1: number; y1: number };
}) {
  const { regions, canvasStrips, orphanPins, viewRect } = params;
  const minimapContentCacheRef = useRef<{
    key: unknown[];
    content: { x0: number; y0: number; x1: number; y1: number };
  } | null>(null);
  const minimapContent = useMemo(() => {
    const key: unknown[] = [canvasStrips, orphanPins];
    for (const r of regions) key.push(r.flowGeom, r.pinnedGeom, r.extent);
    const prev = minimapContentCacheRef.current;
    if (prev && sameKey(prev.key, key)) return prev.content;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of regions) {
      // P2-2：stub 卷用最近已知包围盒（离屏不增长——回场刷新）
      if (r.stubbed && r.extent) {
        x0 = Math.min(x0, r.extent.x0);
        y0 = Math.min(y0, r.extent.y0);
        x1 = Math.max(x1, r.extent.x1);
        y1 = Math.max(y1, r.extent.y1);
        continue;
      }
      for (const g of r.flowGeom) {
        x0 = Math.min(x0, g.x);
        y0 = Math.min(y0, g.y);
        x1 = Math.max(x1, g.x + g.w);
        y1 = Math.max(y1, g.y + g.h);
      }
      for (const g of r.pinnedGeom) {
        x0 = Math.min(x0, g.x);
        y0 = Math.min(y0, g.y);
        x1 = Math.max(x1, g.x + g.w);
        y1 = Math.max(y1, g.y + g.h);
      }
    }
    for (const s of canvasStrips) {
      x0 = Math.min(x0, s.x);
      y0 = Math.min(y0, s.y);
      x1 = Math.max(x1, s.x + s.w);
      y1 = Math.max(y1, s.y + 96);
    }
    for (const [, pin] of orphanPins) {
      x0 = Math.min(x0, pin.x);
      y0 = Math.min(y0, pin.y);
      x1 = Math.max(x1, pin.x + pin.w);
      y1 = Math.max(y1, pin.y + 96);
    }
    if (!Number.isFinite(x0)) {
      // 空画布兜底（无卷/纸条/钉）：不要用极窄固定块（会把视口框 scale 放大
      // 成溢出容器的巨大红框）——以视口为基准外扩一圈，保证比例自然。
      // ⚠ 空兜底不写缓存（viewRect 每帧变——写缓存会让内容侧键命中旧值）。
      const vx0 = viewRect.x0;
      const vy0 = viewRect.y0;
      const vx1 = viewRect.x1;
      const vy1 = viewRect.y1;
      const vw = Math.max(800, vx1 - vx0);
      const vh = Math.max(600, vy1 - vy0);
      return {
        x0: (vx0 + vx1) / 2 - vw,
        y0: (vy0 + vy1) / 2 - vh / 2,
        x1: (vx0 + vx1) / 2 + vw,
        y1: (vy0 + vy1) / 2 + vh / 2,
      };
    }
    const content = { x0, y0, x1, y1 };
    minimapContentCacheRef.current = { key, content };
    return content;
  }, [regions, canvasStrips, orphanPins, viewRect]);

  return { minimapContent };
}
