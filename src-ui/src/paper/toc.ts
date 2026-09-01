// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/toc — 目次带几何 v2（2026-09-01 minimap 换血）。
//
// 定位：底子 = minimap（对齐 VSCode 交互语义），超越 = 语义标记/活线/未读
// （拍板 10 的「关键时刻标记」后置债一并清偿）。本模块只算几何
// （零 DOM / 零 store）：
//   - 线性映射：世界 y ↔ 带内 y（内容指纹/滑块/标记共用一把尺）；
//   - 滑块数学：拖拽 scrub（grab offset 锁采样——拖拽中指针与滑块的相对
//     位置固定，刻度增长不追着自己跑）、点滑块外即跳（点击点对视口中心，
//     viewFocusRegion 同语义）再顺势拖、内容不满一屏滑块全高（fit，不可拖）；
//   - 语义标记派生：块类型/状态 → 刻痕（user=朱砂横杠 / tool=石青 /
//     plan=石墨 / error=--fail 实心短刻——墨色语义铁律朱砂=人不可挪用，
//     报错走语义状态 --fail）；
//   - 未读区：上次读到哪 → 带上的区间。
// 内容指纹的数据源不在本模块：paper/ink 的 inkForBlock 是行盒骨架单一真源
// （pretext 真断行 + 签名缓存），渲染端直接消费 InkBar 画 bar——带内缩放比
// 下一行常低于 1px，bar 是唯一诚实原语（真字形 fillText 亚像素不可辨）。
// 渲染层把 strip 上下界与流区内容上下界喂进来即可。

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

/* ── 线性映射（世界 ↔ 带）── */

/** 世界 y → 带内 y 的线性映射（相对高度——拍板 10「位置映射相对高度」）。
 *  单调递增：越新（worldY 越大）刻度越靠下。 */
export function tocMapper(range: TocRange): (worldY: number) => number {
  const span = Math.max(1, range.regionBottom - range.regionTop);
  return (worldY: number) =>
    range.stripTop + ((worldY - range.regionTop) / span) * (range.stripBottom - range.stripTop);
}

/** 带内 y → 世界 y（点击/拖拽落点反查；tocMapper 的逆）。 */
export function stripToWorld(range: TocRange): (stripY: number) => number {
  const span = Math.max(1, range.stripBottom - range.stripTop);
  return (stripY: number) =>
    range.regionTop + ((stripY - range.stripTop) / span) * (range.regionBottom - range.regionTop);
}

/* ── 滑块（VSCode 语义）── */

export interface TocSlider {
  /** 滑块顶（屏幕像素 y，已 clamp 在带内） */
  top: number;
  /** 滑块高（屏幕像素；内容不满一屏 = 全带高） */
  height: number;
  /** 内容超出视口 = 可拖 scrub */
  draggable: boolean;
}

/** 视口世界区间 → 带上滑块。内容高度 ≤ 视口高度 → 全高滑块（fit，
 *  draggable=false——VSCode「minimap 不大于内容」语义）。 */
export function computeSlider(range: TocRange, viewY0: number, viewY1: number): TocSlider {
  const stripH = Math.max(0, range.stripBottom - range.stripTop);
  const contentH = Math.max(1, range.regionBottom - range.regionTop);
  const viewH = Math.max(0, viewY1 - viewY0);
  if (viewH >= contentH || stripH === 0) {
    return { top: range.stripTop, height: stripH, draggable: false };
  }
  const scale = stripH / contentH;
  const height = Math.max(2, viewH * scale);
  const top = clamp(range.stripTop + (viewY0 - range.regionTop) * scale, range.stripTop, range.stripBottom - height);
  return { top, height, draggable: true };
}

/** 按下滑块外的点：目标视口顶（世界 y）——点击点成为视口中心。
 *  与 viewFocusRegion（P1-2 返工）同一落点语义；已 clamp 在内容域。 */
export function jumpViewTopAt(stripY: number, range: TocRange, viewH: number): number {
  const worldY = stripToWorld(range)(stripY);
  return clampViewTop(worldY - viewH / 2, range, viewH);
}

/** 按下时抓取偏移（指针相对滑块顶；clamp 在滑块内——VSCode 同款）。 */
export function grabOffsetAt(pointerStripY: number, slider: TocSlider): number {
  return clamp(pointerStripY - slider.top, 0, Math.max(0, slider.height));
}

/** 拖拽中：指针带偏移 → 目标视口顶（世界 y，已 clamp）。grab offset 锁采样
 *  ——拖拽期间指针与滑块相对位置恒定，内容增长不引起滑块漂移。 */
export function scrubViewTop(pointerStripY: number, grabOffset: number, range: TocRange, viewH: number): number {
  const stripH = Math.max(0, range.stripBottom - range.stripTop);
  const contentH = Math.max(1, range.regionBottom - range.regionTop);
  if (viewH >= contentH || stripH === 0) return clampViewTop(range.regionTop, range, viewH);
  const scale = stripH / contentH;
  const height = Math.max(2, viewH * scale);
  const top = clamp(pointerStripY - grabOffset, range.stripTop, range.stripBottom - height);
  return clampViewTop(range.regionTop + (top - range.stripTop) / scale, range, viewH);
}

/** 视口顶的合法域：内容顶 ≤ viewTop ≤ 内容底 − 视口高（拖不过头）。 */
function clampViewTop(viewTop: number, range: TocRange, viewH: number): number {
  const min = range.regionTop;
  const max = Math.max(min, range.regionBottom - viewH);
  return clamp(viewTop, min, max);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/* ── 语义标记（刻痕）── */

export type TocMarkKind = 'user' | 'tool' | 'plan' | 'error';

/** 带上刻痕：stripY 供显示（块顶），worldY 供跳转（块中心——落点居中舒适）。 */
export interface TocMark {
  blockId: string;
  kind: TocMarkKind;
  stripY: number;
  worldY: number;
  /** hover 预览（user 轮 = 来文首句；tool = 工具名；error = 错误摘要） */
  preview: string;
}

/** 标记派生的最小输入——组件从 SourcedBlock payload 摘取，本模块不碰 payload 形状。 */
export interface TocMarkInput {
  id: string;
  kind: string;
  /** tool/code/toolgroup/subagent 的状态（组 = 子项聚合后的结论） */
  status?: string;
  /** notice/turn-error 的级别 */
  level?: string;
  worldY: number;
  worldH: number;
  preview?: string;
}

/** 块序列 → 刻痕。判定表：
 *  user → user；turn-error → error；notice(level=error) → error；
 *  tool/code(status=error) → error，其余 → tool；
 *  toolgroup/subagent（子项含 error）→ error，其余 → tool；plan → plan；
 *  其余（markdown/reasoning/diff…）不上刻痕——它们活在指纹里。 */
export function deriveMarks(inputs: TocMarkInput[], range: TocRange): TocMark[] {
  const map = tocMapper(range);
  const out: TocMark[] = [];
  for (const b of inputs) {
    const kind = markKindOf(b);
    if (!kind) continue;
    out.push({
      blockId: b.id,
      kind,
      stripY: map(b.worldY),
      worldY: b.worldY + b.worldH / 2,
      preview: (b.preview ?? '').slice(0, 60) || '（空）',
    });
  }
  return out;
}

function markKindOf(b: TocMarkInput): TocMarkKind | null {
  switch (b.kind) {
    case 'user':
      return 'user';
    case 'turn-error':
      return 'error';
    case 'notice':
      return b.level === 'error' ? 'error' : null;
    case 'tool':
    case 'code':
    case 'toolgroup':
    case 'subagent':
      return b.status === 'error' ? 'error' : 'tool';
    case 'plan':
      return 'plan';
    default:
      return null;
  }
}

/* ── 未读区 ── */

/** 上次读到 viewY1 之后新长出的内容 → 带上区间（淡朱）；无欠账 = null。 */
export function unreadBand(lastReadWorldY: number, range: TocRange): { top: number; height: number } | null {
  if (lastReadWorldY >= range.regionBottom) return null;
  const map = tocMapper(range);
  const top = map(Math.max(lastReadWorldY, range.regionTop));
  const bottom = map(range.regionBottom);
  return { top, height: Math.max(2, bottom - top) };
}

/* ── user 轮次锚点（hover 预览解析用）── */

export interface TurnAnchorInput {
  /** 块 id */
  id: string;
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

/** 只取 user 轮次块，构建带内锚点（按块中心映射）。 */
export function buildTurnAnchors(blocks: TurnAnchorInput[], range: TocRange): TurnAnchor[] {
  const map = tocMapper(range);
  const out: TurnAnchor[] = [];
  for (const b of blocks) {
    if (b.kind !== 'user') continue;
    const worldY = b.worldY + b.worldH / 2;
    out.push({
      blockId: b.id,
      stripY: map(worldY),
      worldY,
      preview: (b.preview ?? '').slice(0, 24) || '（空轮次）',
    });
  }
  // 按带内序（旧 → 新）——blocks 已是消息序，保持即可
  return out;
}

/** 点带反查最近锚点（hover 预览解析）；无锚点 = null。 */
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

/* ── 位置指示 ── */

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
