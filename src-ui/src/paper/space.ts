// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/space — 画布空间内核（一纸多卷，Stage-2）。
//
// 定案（docs/plans/canvas-space/stage-2.md §3.5 + §5）：
//   - 流区宽度 = 1440（720×2，先试，落地看手感再调）
//   - 吸附网格粒度 = 宽度 + 间距 = 2160（X 吸附；Y 用户自主）
//   - 流区移动 = 边缘拖动（悬停左/右缘即拖拽态、光标 move、宽度不变、
//     ~6px 量级，无显式手柄条；手感仿窗口边缘、功能是移动）
//   - 锚点语义 = 流区左下（流从锚点向上长，对齐 D-R1-3 流锚甲：锚点即
//     最新块底边的世界坐标，anchorX = 流区中轴）
//   - 自动落位（Stage-5 用户拍板：X 线性 → 最近空位，不分栏）：
//     nearestFreeRegion 以视口中心为参照、向左右逐列外扩找最近空列。
//
// 本文件是空间层的纯函数 + 常量（零 DOM、零 store 依赖），渲染/交互层
// 消费这里的几何与落位规则。流区位置持久化在 state/canvas-store（Stage-5
// 起随工作区画布状态文件落盘，不再随会话快照）；流区注册表/活跃流区/空间
// 命令在 composition/space-service（ctx.space 通道），本文件不碰存储。

/** 流区（StreamRegion）几何常量（stage-2 §3.5 用户拍板）。 */
export const STREAM_REGION = {
  /** 流区宽度（世界单位）——统一宽度，不做可调宽窄（画布模型拍板 #2） */
  width: 1440,
  /** 流区间距（世界单位）——X 吸附栅格的粒度组成（宽度+间距=2160） */
  spacing: 720,
  /** 边缘拖拽面宽度（屏幕像素量级——光标反馈为主，无需视觉手柄） */
  edgeWidth: 6,
} as const;

/** 吸附网格粒度 = 宽度 + 间距（2160）——边缘拖动松手吸附于此。 */
export const STREAM_SNAP_GRID = STREAM_REGION.width + STREAM_REGION.spacing;

/** 流区锚点（世界坐标）：anchorX = 流区中轴，anchorY = 最新块底边（流向上长）。 */
export interface StreamRegionAnchor {
  x: number;
  y: number;
}

/** 流区位置状态（canvas-store 持久化形状与空间读面的共同单元）。 */
export interface StreamRegionState {
  anchorX: number;
  anchorY: number;
  width: number;
}

/** 默认线性排比落位：第 i 个会话贴第 i 列（i * 网格粒度）。
 *  index = 会话在 sess store 中的序（新建 = 末尾 → 自动落位在最后列右侧）。 */
export function defaultRegionFor(index: number): StreamRegionState {
  return {
    anchorX: index * STREAM_SNAP_GRID,
    anchorY: 0,
    width: STREAM_REGION.width,
  };
}

/** X 轴吸附到网格粒度（边缘拖动松手/移动过程中实时吸附）。 */
export function snapRegionX(x: number): number {
  return Math.round(x / STREAM_SNAP_GRID) * STREAM_SNAP_GRID;
}

/** 流区世界包围盒（x 区间）——边缘拖拽命中测试与视口相交预筛用。 */
export function regionXBounds(anchorX: number, width: number): { x0: number; x1: number } {
  return { x0: anchorX - width / 2, x1: anchorX + width / 2 };
}

/** 书脊拖动落位判据（Stage-3：抽书放桌——找「竖向不打架」的空位）。
 *  x 吸附到网格粒度（复用 Stage-2 吸附/落位判据），并跳过已被其他流区
 *  占用的列（排除自身——拖动中的卷可以留在原列）；y 取用户落点（垂直
 *  自主），系统只保秩序下限（统一宽度 + x 网格）。纯函数便于测试。 */
export function pickDropAnchor(
  regions: Array<{ sessionId: string; anchorX: number }>,
  sessionId: string,
  dropX: number,
  dropY: number,
): StreamRegionState {
  let col = Math.round(dropX / STREAM_SNAP_GRID);
  const occupied = new Set(
    regions.filter((r) => r.sessionId !== sessionId).map((r) => Math.round(r.anchorX / STREAM_SNAP_GRID)),
  );
  while (occupied.has(col)) col++;
  return {
    anchorX: col * STREAM_SNAP_GRID,
    anchorY: dropY,
    width: STREAM_REGION.width,
  };
}

/** 最近空位落位（Stage-5 用户拍板：不分栏，改「最近空位」）。
 *  占用模型 = X 列互斥（统一宽度 + X 吸附栅格；Y 用户自主）——从参考列
 *  （通常 = 视口中心）向左右逐列外扩，落最近空列；Y 取参考 y。纯函数，
 *  便于测试。 */
export function nearestFreeRegion(
  regions: Array<{ sessionId: string; anchorX: number }>,
  refX: number,
  refY: number,
  excludeSessionId?: string,
): StreamRegionState {
  const occupied = new Set(
    regions.filter((r) => r.sessionId !== excludeSessionId).map((r) => Math.round(r.anchorX / STREAM_SNAP_GRID)),
  );
  const start = Math.round(refX / STREAM_SNAP_GRID);
  let d = 0;
  for (; ; d++) {
    for (const c of d === 0 ? [start] : [start + d, start - d]) {
      if (!occupied.has(c)) {
        return { anchorX: c * STREAM_SNAP_GRID, anchorY: refY, width: STREAM_REGION.width };
      }
    }
  }
}
