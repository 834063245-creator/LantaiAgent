// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/space — 画布空间内核（一纸多卷）。
//
// 定案沿革：
//   - Stage-2（2026-08-25）：统一宽 1440 / 吸附栅格 2160 / 拖边缘=移动。
//   - **2026-08-30 用户拍板翻案（实机反馈，pretext 排版引擎线）**：
//     ① 吸附栅格拆除——列模型让会话一字排开、画布排布失去自由度
//     （用户手动布局能力强于预设秩序）；
//     ② 流区宽自由变换 clamp [720, 2160]，四角手柄横向缩放（角落只开放
//     横向——普通窗口角落是全维缩放，流区 Y 由内容生长）；
//     ③ 「拖边缘=移动」手势保留（翻案「边缘=resize」被否：长卷定位卷首
//     成本高）。
//   - 落位从列模型改 **X 区间模型**：自动落位/书脊拖落找「不与既有流区
//     重叠」的最近位置（留 REGION_GAP 间距）；手动移动/缩放自由、允许
//     重叠（用户主权——系统只管自动落位的秩序下限）。
//
// 本文件是空间层纯函数 + 常量（零 DOM、零 store 依赖）。流区位置持久化在
// state/canvas-store（Stage-5 起随工作区画布状态文件落盘，width 是真值）。

/** 流区几何常量。 */
export const STREAM_REGION = {
  /** 新流区初落宽（世界单位）——落位后可四角横向缩放（clamp [MIN, MAX]） */
  width: 1440,
  /** 自动落位/拖落与既有流区的最小间距（区间缓冲） */
  gap: 120,
  /** 边缘拖拽面宽（移动手势） */
  edgeWidth: 6,
} as const;

/** 流区宽上下限（2026-08-30 拍板：min 720 / max 2160）。 */
export const REGION_MIN_W = 720;
export const REGION_MAX_W = 2160;

export function clampRegionW(w: number): number {
  return Math.min(REGION_MAX_W, Math.max(REGION_MIN_W, w));
}

/** 块宽跟随流区的缓冲（两侧各 120——块恒窄于界栏不贴栏；
 *  窄流区压版心：块 w = min(kindW, regionW - REGION_CONTENT_MARGIN)）。 */
export const REGION_CONTENT_MARGIN = 240;

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

const DEFAULT_W = STREAM_REGION.width;

/** 占用区间（含 REGION_GAP 缓冲——自动落位不贴脸）。 */
function occupiedInterval(anchorX: number, width: number): { x0: number; x1: number } {
  return { x0: anchorX - width / 2 - STREAM_REGION.gap, x1: anchorX + width / 2 + STREAM_REGION.gap };
}

/** 合并排序后的占用区间（探测窗 [refX-RANGE, refX+RANGE] 内）。 */
function mergedIntervals(
  regions: Array<{ anchorX: number; width: number; sessionId?: string }>,
  excludeSessionId: string | undefined,
  refX: number,
): Array<{ x0: number; x1: number }> {
  const RANGE = 100000;
  const sorted = regions
    .filter((r) => r.sessionId !== excludeSessionId)
    .map((r) => occupiedInterval(r.anchorX, r.width))
    .filter((o) => o.x1 > refX - RANGE && o.x0 < refX + RANGE)
    .sort((a, b) => a.x0 - b.x0);
  const merged: Array<{ x0: number; x1: number }> = [];
  for (const o of sorted) {
    const last = merged[merged.length - 1];
    if (last && o.x0 <= last.x1) last.x1 = Math.max(last.x1, o.x1);
    else merged.push({ ...o });
  }
  return merged;
}

/** 参考点两侧最近的「能容纳 w 的空闲位」中心（区间模型——栅格拆除后的
 *  最近空位语义）。探测窗全满 → refX 直接落（允许叠，理论兜底）。 */
function nearestFreeCenter(
  regions: Array<{ anchorX: number; width: number; sessionId?: string }>,
  refX: number,
  w: number,
  excludeSessionId?: string,
): number {
  const merged = mergedIntervals(regions, excludeSessionId, refX);
  const RANGE = 100000;
  const gaps: Array<{ x0: number; x1: number }> = [];
  let prev = refX - RANGE;
  for (const m of merged) {
    if (m.x0 > prev) gaps.push({ x0: prev, x1: m.x0 });
    prev = Math.max(prev, m.x1);
  }
  gaps.push({ x0: prev, x1: refX + RANGE });
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const g of gaps) {
    if (g.x1 - g.x0 < w) continue;
    const cx = Math.min(Math.max(refX, g.x0 + w / 2), g.x1 - w / 2);
    const d = Math.abs(cx - refX);
    if (d < bestDist) {
      bestDist = d;
      best = cx;
    }
  }
  return best ?? refX;
}

/** 首帧兜底落位（正式落位走 nearestFreeRegion——effect 自动找位补正；
 *  仅保证确定性非全叠的初值，无栅格语义）。 */
export function defaultRegionFor(index: number): StreamRegionState {
  return { anchorX: index * (DEFAULT_W + STREAM_REGION.gap), anchorY: 0, width: DEFAULT_W };
}

/** 自动落位（Stage-5 拍板「最近空位」的区间模型版）：以参考点（视口中心）
 *  为参照找最近可容纳位，Y 取参考 y。 */
export function nearestFreeRegion(
  regions: Array<{ anchorX: number; width: number; sessionId?: string }>,
  refX: number,
  refY: number,
  excludeSessionId?: string,
): StreamRegionState {
  return {
    anchorX: nearestFreeCenter(regions, refX, DEFAULT_W, excludeSessionId),
    anchorY: refY,
    width: DEFAULT_W,
  };
}

/** 书脊拖出落位：拖到哪落哪（自由，不吸附）；与既有流区区间重叠 → 推最近
 *  空位（「竖向不打架」拍板语义的区间版）。 */
export function pickDropAnchor(
  regions: Array<{ anchorX: number; width: number; sessionId?: string }>,
  sessionId: string,
  dropX: number,
  dropY: number,
): StreamRegionState {
  const mine = { x0: dropX - DEFAULT_W / 2, x1: dropX + DEFAULT_W / 2 };
  const overlap = regions.some((r) => {
    if (r.sessionId === sessionId) return false;
    const o = { x0: r.anchorX - r.width / 2, x1: r.anchorX + r.width / 2 };
    return mine.x0 < o.x1 && mine.x1 > o.x0;
  });
  if (!overlap) return { anchorX: dropX, anchorY: dropY, width: DEFAULT_W };
  return {
    anchorX: nearestFreeCenter(regions, dropX, DEFAULT_W, sessionId),
    anchorY: dropY,
    width: DEFAULT_W,
  };
}
