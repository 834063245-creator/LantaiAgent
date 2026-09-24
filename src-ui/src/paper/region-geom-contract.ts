// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/region-geom-contract — 视口/流区**几何形状契约**（批 9c-2，2026-09-26）。
//
// 为什么三类型留内核：它们是内核几何层的公共词汇——`paper/region-view.ts`（区域视图模型）
// 与 `paper/overlay-context.ts`（浮层坐标换算）都用它们，而**实现**（可见窗口筛选）住
// paper-shell 产物（`virtualize.ts` 整件随包）。形状留内核 = 两侧可引用而不反向依赖产物。

/** 世界矩形（x0 < x1, y0 < y1，世界单位） */
export interface WorldRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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

/** pinned 块几何（世界坐标唯一真相 D-R2-4） */
export interface PinnedGeom {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 单个流区的完整几何（flow 已是世界坐标——layoutRegion 平移后的产物）。 */
export interface RegionFlowGeom {
  sessionId: string;
  /** 该流区的 flow 块几何（世界坐标，栈序 = 消息序） */
  flow: FlowGeom[];
  /** 流区中轴（世界） */
  anchorX: number;
  /** 流区最新块底边（世界） */
  anchorY: number;
  /** 流区宽（世界） */
  width: number;
}
