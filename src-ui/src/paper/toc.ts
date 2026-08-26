// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/toc — 目次带（会话内 minimap，Stage-4 §4.4）纯几何。
//
// 拍板（canvas-space-model-notes.md §5 拍板 10）：右缘窄条、屏幕固定、内容
// 跟随活跃会话。骨架 = 轮次锚点（每个 user 输入一个刻度，位置映射相对高度）
// + 点击跳转 + 位置指示 + hover 首句预览。锚点 = 纯 user 轮次（stage-4 §8
// 拍板 4：关键块标记后置）。
//
// 本模块只算几何（零 DOM / 零 store）：
//   - buildTurnAnchors：从活跃流区几何取 user 轮次锚点（世界 y → 带内 y）；
//   - nearestAnchorAt：点带反查最近的轮次锚点（点击跳转的目标）；
//   - viewportMarker：位置指示（当前视口在带上的区间）。
// 渲染层把 strip 上下界与流区内容上下界喂进来即可。

export interface TurnAnchorInput {
  blockId: string;
  kind: string;
  /** 块顶 y（世界） */
  worldY: number;
  /** 块高（世界） */
  worldH: number;
  /** 首句缩略（hover 预览用） */
  preview?: string;
}

export interface TurnAnchor {
  blockId: string;
  /** 锚点刻度在带内的 y（像素）——取块中心 */
  stripY: number;
  /** 块中心 y（世界）——点击跳转的目标 */
  worldY: number;
  preview: string;
}

export interface TocRange {
  /** 流区内容顶（世界 y，最旧块顶） */
  regionTop: number;
  /** 流区内容底（世界 y = 锚点，最新块底边） */
  regionBottom: number;
  /** 带顶（屏幕像素 y） */
  stripTop: number;
  /** 带底（屏幕像素 y） */
  stripBottom: number;
}

/** 世界 y → 带内 y 的线性映射（相对高度——拍板 10「位置映射相对高度」）。
 *  单调递增：越新（worldY 越大）刻度越靠下。 */
export function tocMapper(range: TocRange): (worldY: number) => number {
  const span = Math.max(1, range.regionBottom - range.regionTop);
  return (worldY: number) =>
    range.stripTop + ((worldY - range.regionTop) / span) * (range.stripBottom - range.stripTop);
}

/** 只取 user 轮次块，构建带内锚点（按块中心映射）。 */
export function buildTurnAnchors(blocks: TurnAnchorInput[], range: TocRange): TurnAnchor[] {
  const map = tocMapper(range);
  const out: TurnAnchor[] = [];
  for (const b of blocks) {
    if (b.kind !== 'user') continue;
    const worldY = b.worldY + b.worldH / 2;
    out.push({
      blockId: b.blockId,
      stripY: map(worldY),
      worldY,
      preview: (b.preview ?? '').slice(0, 24) || '（空轮次）',
    });
  }
  // 按带内序（旧 → 新）——blocks 已是消息序，保持即可
  return out;
}

/** 点带反查最近锚点（点击跳转目标）；无锚点 = null。 */
export function nearestAnchorAt(stripY: number, anchors: TurnAnchor[]): TurnAnchor | null {
  if (anchors.length === 0) return null;
  let best = anchors[0];
  let bestD = Math.abs(anchors[0].stripY - stripY);
  for (const a of anchors) {
    const d = Math.abs(a.stripY - stripY);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

/** 位置指示：视口在世界 y 上的可见区间 → 带上的区间（拍板 10「位置指示 =
 *  当前视口在带上的刻度」）。视口区间与流区内容区间求交，映射到带。 */
export function viewportMarker(
  viewY0: number,
  viewY1: number,
  range: TocRange,
): { top: number; bottom: number } | null {
  const y0 = Math.max(viewY0, range.regionTop);
  const y1 = Math.min(viewY1, range.regionBottom);
  if (y1 <= y0) return null;
  const map = tocMapper(range);
  const top = map(y0);
  const bottom = map(y1);
  return { top, bottom: Math.max(bottom, top + 2) };
}
