// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/virtualize — V3a 视口虚拟化（设计文档 §2.3：数据层全量永驻，
// 渲染只画视口内，交互用平移——三者各司其职）。
//
// 纯函数零依赖（只 import canvas-math 的类型/换算）：
//   - flow 块是垂直连续栈（layoutFlow：顶边 y 随栈序单调递增）→ 视口窗口
//     是连续区间，二分查找，O(log n) 定位 + O(k) 输出（k = 可见块数）。
//   - pinned 块散布在世界坐标（D-R2-4）→ 逐块矩形相交测试，O(m)。
// 长会话成本：布局数学 O(n)（廉价算术），DOM 渲染 O(k)——虚拟化砍的是后者。

import type { Viewport } from './canvas-math';

/** 世界矩形（x0 < x1, y0 < y1，世界单位） */
export interface WorldRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 视口（屏幕 [0,w]×[0,h]）对应的世界矩形。 */
export function viewportWorldRect(v: Viewport, w: number, h: number): WorldRect {
  // screen = world * zoom + pan → world = (screen - pan) / zoom
  return {
    x0: (0 - v.panX) / v.zoom,
    y0: (0 - v.panY) / v.zoom,
    x1: (w - v.panX) / v.zoom,
    y1: (h - v.panY) / v.zoom,
  };
}

/** flow 块几何（栈序 = 消息序，旧→新；顶边 y 单调递增） */
export interface FlowGeom {
  id: string;
  /** 块顶 y（世界） */
  y: number;
  /** 块高（pinned 块在流原序位是占位符高度） */
  h: number;
  /** 块左 x（世界） */
  x: number;
  w: number;
}

/**
 * 视口内可见的 flow 块区间（半开 [first, lastExcl)，栈序连续）。
 * overscan：视口上下各外扩的世界单位数（缓冲一屏滚动，避免逐帧抖动）。
 */
export function visibleFlowWindow(
  flow: FlowGeom[],
  rect: WorldRect,
  overscan = 0,
): { first: number; lastExcl: number } {
  const y0 = rect.y0 - overscan;
  const y1 = rect.y1 + overscan;
  if (flow.length === 0 || y1 < flow[0].y || y0 > flow[flow.length - 1].y + flow[flow.length - 1].h) {
    return { first: 0, lastExcl: 0 };
  }
  // 第一个底边 ≥ y0 的块（bottom 单调递增）
  let lo = 0;
  let hi = flow.length - 1;
  let first = flow.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flow[mid].y + flow[mid].h >= y0) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (first === flow.length) return { first: 0, lastExcl: 0 };
  // 最后一个顶边 ≤ y1 的块（top 单调递增）
  lo = first;
  hi = flow.length - 1;
  let last = first - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flow[mid].y <= y1) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (last < first) return { first: 0, lastExcl: 0 };
  return { first, lastExcl: last + 1 };
}

/** pinned 块几何（世界坐标唯一真相 D-R2-4） */
export interface PinnedGeom {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 视口内可见的 pinned 块 id（矩形相交，散布无序 → 线性扫）。 */
export function visiblePinnedIds(pinned: PinnedGeom[], rect: WorldRect, overscan = 0): string[] {
  const x0 = rect.x0 - overscan;
  const y0 = rect.y0 - overscan;
  const x1 = rect.x1 + overscan;
  const y1 = rect.y1 + overscan;
  const out: string[] = [];
  for (const b of pinned) {
    if (b.x <= x1 && b.x + b.w >= x0 && b.y <= y1 && b.y + b.h >= y0) out.push(b.id);
  }
  return out;
}

/** 矩形相交（通用几何谓词——minimap 视口框换算也用）。 */
export function rectsIntersect(a: WorldRect, b: WorldRect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}
