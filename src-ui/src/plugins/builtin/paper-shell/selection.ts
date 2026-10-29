// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-shell/selection — 纸条（paper-strip）实现（**批 9c-1 归家**：原 `paper/selection.ts`
// 整件移入产物包；形状面 `PaperStrip` / `PaperStripSource` 上收内核
// `paper/selection-contract.ts`——内核 `state/canvas-store.ts` 存纸条，两侧共享形状）。
//
// V3a 抽纸条（paper-shell 待定 #10 定案：混合方案，重心选区拖出）。
//
// 语义（用户拍板 2026-08-21）：
//   - 块级为默认粒度（流视觉密度不涨、id 稳定性不伤）——整块拖出钉住
//     走 D-R2-1 既有通道（活引用）。
//   - **选中一段文字拖离流 = 抽纸条**（与 D-R2-3「塞纸条」隐喻同构）——
//     选区块是**拷贝语义**（纸条本体），活引用仅块级保留。
//   - 转译层不做段落预拆（块 id 续命机制保持现状）。
//
// 本文件是纸条的真相层模型 + 纯操作：
//   纸条 = 用户层物件（设计文档 §2.2 用户自定义层），文字快照自选区抽出，
//   世界坐标唯一真相（D-R2-4 同款纪律），不挂消息源（拷贝非活引用——
//   源消息更新不追纸条，源消息删除纸条照活）。
//
// 【持久化收尾 2026-08-24】扩展 PaperStrip 增加 source 可选元信息
// （仅用于溯源展示，不用于同步——拷贝语义不变）。

import type { PaperStrip, PaperStripSource } from '../../../paper/selection-contract';

export type { PaperStrip, PaperStripSource };

/** 纸条 id 前缀（与块 id 空间区分） */
export const STRIP_ID_PREFIX = 'strip';

let stripSeq = 0;

export function nextStripId(): string {
  stripSeq += 1;
  return STRIP_ID_PREFIX + stripSeq;
}

/** 测试复位（生产不调用）。 */
export function resetStripIdCounterForTests(): void {
  stripSeq = 0;
}

/** 从文本选区抽纸条（纯函数——壳层负责拿到选区文本与世界落点）。 */
export function makeStrip(text: string, x: number, y: number, w = 480, source?: PaperStripSource): PaperStrip {
  return { id: nextStripId(), text: text.trim(), x, y, w, ...(source ? { source } : {}) };
}

/** 纸条拖动（每 move 一帧——与块级 movePinned 同款语义）。 */
export function moveStrip(s: PaperStrip, x: number, y: number): PaperStrip {
  return { ...s, x, y };
}

/**
 * 从选区锚点/焦点算选中文本（DOM Selection 语义的纯函数化投影）。
 * 输入是「块文本 + 选区两端偏移」——壳层从 window.getSelection() 换算
 * offset，本函数只做切片与边界夹取。拷贝语义的抽取原语。
 */
export function sliceSelection(text: string, start: number, end: number): string {
  const s = Math.max(0, Math.min(text.length, Math.min(start, end)));
  const e = Math.max(0, Math.min(text.length, Math.max(start, end)));
  return text.slice(s, e);
}

/**
 * 抽纸条守卫：空选区/纯空白不抽（拖出无物 = 手势落空，不是纸条）。
 * 返回 null 表示该手势不产生纸条。
 */
export function tryMakeStripFromSelection(
  text: string,
  start: number,
  end: number,
  x: number,
  y: number,
  source?: PaperStripSource,
): PaperStrip | null {
  const sel = sliceSelection(text, start, end);
  if (sel.trim().length === 0) return null;
  return makeStrip(sel, x, y, 480, source);
}

/* ── 拖拽语义几何（收尾批 II 2026-08-24：A+B 交互重做）── */

/** 拖拽落点分类——幽灵预览/成条判据的单一真源。
 *  flow：流锚窄带内（普通选择/阅读行为，不抽条）；
 *  strip：带外画布内（松手成条）。 */
export type StripDropZone = 'flow' | 'strip';

/** 判落点分区：输入是光标的世界坐标 + 画布屏幕尺寸（画布外由调用方先排除）。
 *  与壳层手势共用同一判据——带边界 = ANCHOR.bandHalfWidth 语义（调用方传入，
 *  纯函数不 import canvas-math，保持 selection.ts 零依赖纪律）。 */
export function classifyDropZone(worldX: number, bandHalfWidth: number): StripDropZone {
  return Math.abs(worldX) <= bandHalfWidth ? 'flow' : 'strip';
}

/** 点是否落在世界矩形内（±slack，世界单位）——**钉住的公共物**的拖出判据
 *  （卡片不在任何流带里，改按卡片自身几何量；用世界坐标是为了滚屏/平移期间
 *  判据不漂——屏幕矩形在平移帧里会脱手）。 */
export function pointInWorldRect(
  rect: { x: number; y: number; w: number; h: number },
  x: number,
  y: number,
  slack = 0,
): boolean {
  return x >= rect.x - slack && x <= rect.x + rect.w + slack && y >= rect.y - slack && y <= rect.y + rect.h + slack;
}

/* ── 选区命中带（2026-10-29「抽纸条莫名其妙失灵」批）──
 * A 路（按住已有选区拖出）的 mousedown 探针原按**逐碎片矩形 ±4px** 判，而浏览器
 * `Range.getClientRects()` 给的是**字面盒**：16px/1.75 正文实测行盒高 20、行间空档
 * 8 ⇒ 行距中段与行尾空白都不在盒内，按住「明明选中的那一块」偶发没反应（用户读作
 * 随机失灵）。命中带把同一选区的碎片按行合并、并把**相邻行之间的空档填满**：
 * 竖直方向在选区内部没有死带；横向仍只到该行**已选字节的起止**（在未选中的字上
 * 按下仍是起新选区，不被旧选区吞掉）。 */
export interface SelectionHitBand {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 行间空档并入上限（px）：超此值就不是「行距」而是块间/段落间空白——不并，
 *  免得按住两个块之间的缝也算抓住选区。 */
const HIT_LINE_GAP_MAX = 16;

/** 选区碎片矩形 → 命中带（屏幕坐标；空/退化矩形跳过）。 */
export function selectionHitBands(
  rects: ArrayLike<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>,
): SelectionHitBand[] {
  const frags: SelectionHitBand[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.width <= 0.5 || r.height <= 0.5) continue;
    frags.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  frags.sort((a, b) => a.top - b.top || a.left - b.left);
  // ① 同行碎片合并（垂直重叠过半 = 同行，行高自适应——与 sel-ink 同判据）
  const lines: SelectionHitBand[] = [];
  for (const f of frags) {
    const cur = lines[lines.length - 1];
    if (cur && f.top < cur.bottom - Math.min(cur.bottom - cur.top, f.bottom - f.top) * 0.5) {
      cur.left = Math.min(cur.left, f.left);
      cur.right = Math.max(cur.right, f.right);
      cur.bottom = Math.max(cur.bottom, f.bottom);
    } else {
      lines.push({ ...f });
    }
  }
  // ② 相邻行之间的空档填满（行距死带消失；横向仍按各自行）
  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i];
    const next = lines[i + 1];
    const gap = next.top - cur.bottom;
    if (gap > 0 && gap <= HIT_LINE_GAP_MAX) cur.bottom = next.top;
  }
  return lines;
}

/** 命中判定（pad = 边缘容差，屏幕 px）。 */
export function pointInHitBands(bands: readonly SelectionHitBand[], x: number, y: number, pad = 4): boolean {
  return bands.some((b) => x >= b.left - pad && x <= b.right + pad && y >= b.top - pad && y <= b.bottom + pad);
}

/** 浮钮路径的纸条落点：流带右侧空地第一档（x = bandHalfWidth + 边距），
 *  y 跟选区几何（选区中点的世界 y）；同档已有纸条则向下叠放（+STRIP_STACK_GAP，
 *  逐条探测直到空档）——「点了就落在看得见的旁边，不压已有纸条」。
 *  纯函数：occupied 传当前纸条矩形列表。 */
export const STRIP_STASH_GAP = 48;
export const STRIP_STACK_GAP = 24;
/** 纸条渲染高的近似值（浮钮叠放探测用——真高度由 CSS 内容决定，
 *  这里取结构高度近似，叠放宁可多留空不重叠）。
 *  2026-09-19 便条批：纸条纸内白边 10/12 → 18/20 并添报头来源行（.pp-strip-src），
 *  结构高从 ~120 抬到 ~150（18×2 内距 + 题签行 + 两三行正文 + 来源行），
 *  近似值同步抬一档——宁可多留空。 */
export const STRIP_H_APPROX = 150;

export function stashStripPosition(
  selectionMidY: number,
  occupied: Array<{ x: number; y: number; w: number }>,
  bandHalfWidth: number,
): { x: number; y: number } {
  return stashStripPositionAt(selectionMidY, occupied, bandHalfWidth, 0);
}

/** 同档叠放探测（浮钮两路共用）：给定落点 x 与起始 y，向下找第一条不撞已有纸条的档。 */
function stackStripY(x: number, y: number, occupied: Array<{ x: number; y: number; w: number }>): number {
  const w = 480; // 纸条默认宽（makeStrip 缺省）
  const overlaps = (yy: number): boolean =>
    occupied.some((o) => Math.abs(o.x - x) < w && yy < o.y + STRIP_H_APPROX && o.y < yy + STRIP_H_APPROX);
  let out = y;
  let guard = 0;
  while (overlaps(out) && guard < 200) {
    out += STRIP_H_APPROX + STRIP_STACK_GAP;
    guard += 1;
  }
  return out;
}

/** 浮钮路径的纸条落点（Stage-2 一纸多卷：流区中轴在 centerX——落点相对
 *  该流区右侧空地第一档，x = centerX + bandHalfWidth + 边距）。 */
export function stashStripPositionAt(
  selectionMidY: number,
  occupied: Array<{ x: number; y: number; w: number }>,
  bandHalfWidth: number,
  centerX: number,
): { x: number; y: number } {
  const x = centerX + bandHalfWidth + STRIP_STASH_GAP;
  return { x, y: stackStripY(x, selectionMidY, occupied) };
}

/** 无源流带来源（**钉住的公共物**）的浮钮落点：选区右缘空地第一档（同档向下叠放）。
 *  为什么另开一路：流带落点要「流区中轴 + 半带宽」，而钉住的卡片不在任何流带里——
 *  按带算会把纸条丢到纸外（用户读作「点了没反应」）。2026-10-29 抽纸条失灵批。 */
export function stashStripBesideRight(
  rightWorldX: number,
  selectionMidY: number,
  occupied: Array<{ x: number; y: number; w: number }>,
): { x: number; y: number } {
  const x = rightWorldX + STRIP_STASH_GAP;
  return { x, y: stackStripY(x, selectionMidY, occupied) };
}

/* ── lift 遮罩几何（P1 手感修复 2026-08-30：拖出时原地「被揭起」占位）── */

/** 世界矩形（壳层直接定位用：left/top/width/height 语义）。 */
export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 选区屏幕矩形 → 世界矩形数组（lift 遮罩定位原语）。
 * 输入 rects 是 Range.getClientRects() 产物（屏幕坐标，跨行选区 = 多矩形），
 * view/canvasOrigin 由壳层传入（本文件保持零依赖纪律，不 import canvas-math）。
 * 零宽/零高矩形（选区折叠边缘）跳过。
 */
export function selectionMaskRects(
  rects: ArrayLike<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>,
  view: { panX: number; panY: number; zoom: number },
  canvasOrigin: { x: number; y: number },
): MaskRect[] {
  const out: MaskRect[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.width <= 0 || r.height <= 0) continue;
    const x0 = (r.left - canvasOrigin.x - view.panX) / view.zoom;
    const y0 = (r.top - canvasOrigin.y - view.panY) / view.zoom;
    const x1 = (r.right - canvasOrigin.x - view.panX) / view.zoom;
    const y1 = (r.bottom - canvasOrigin.y - view.panY) / view.zoom;
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}
