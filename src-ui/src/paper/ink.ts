// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/ink — 缩远墨迹（P4 LOD）：远缩档把 DOM 块树替换为 canvas「真墨」行条
// 骨架——每行按真实行宽（walkLineRanges 无字符串分配路径）画条，远看是真卷轴
// 全景，近看回 DOM 正文。纯几何层：文类分派在 measure.inkSourcesFor（单一真源，
// 与测高共用 payload 语义与镜像常量）。
//
// 墨条语义：dy = 距块顶的纵向偏移（世界单位），x0 = 距块左的横向偏移（含文类
// 内缩），w = 行宽。行高来自文类 lineHeight——LOD 抽象层，不镜像 6-14px 级
// 块内间距（骨架与 DOM 实高允许小漂移，行数/行宽是精确的）。
//
// 封顶语义（镜像渲染端滚动区）：超过 cap 的行只推进 dy 不画条——滚动部分不占
// 视觉、但占骨架高度，与测高的 cappedH 同一语义。

import {
  type LayoutLineRange,
  type PreparedTextWithSegments,
  prepareWithSegments,
  walkLineRanges,
} from '@chenglou/pretext';
import type { SourcedBlock } from './block-model';
import { type InkSource, inkSourcesFor, measureSignature, STRIP_INK } from './measure';

/** 单根墨条。 */
export interface InkBar {
  /** 距块顶的纵向偏移（世界单位） */
  dy: number;
  /** 距块左的横向偏移（世界单位，含文类内缩） */
  x0: number;
  /** 行宽（世界单位） */
  w: number;
}

/** 一块的墨迹骨架。 */
export interface BlockInk {
  bars: InkBar[];
  /** 主行高（画条粗细用） */
  lineH: number;
}

/* ── LOD 迟滞（防抖）：进入 < 0.55，退出需 > 0.62——阈值间往返不闪烁 ── */
export const LOD_ENTER = 0.55;
export const LOD_EXIT = 0.62;

export function lodActive(zoom: number, prev: boolean): boolean {
  return prev ? zoom < LOD_EXIT : zoom < LOD_ENTER;
}

/* ── 墨色板（镜像 tokens.css L17-27——canvas 读不了 CSS 变量，字面量进镜像纪律，
 * tests/paper-ink.test.ts 钉死字面量；改 token 两处同步）──
 * 正文=墨 --ink-1 / 来文=朱砂 --seal / 夹注=赭石 --graphite / 脚注·程文·抄录·
 * 拟策=石青 --indigo / 贴黄=次级 --ink-2 / 资产与未知=三级 --ink-3 */
export const INK_COLORS = {
  markdown: '#26221c',
  user: '#a63a2e',
  reasoning: '#6f6e68',
  tool: '#3a5b7a',
  code: '#3a5b7a',
  diff: '#3a5b7a',
  plan: '#3a5b7a',
  notice: '#55503f',
  _default: '#8a8172',
  _strip: '#55503f',
} as const;

export function inkColorOf(kind: string): string {
  return (INK_COLORS as Record<string, string>)[kind] ?? INK_COLORS._default;
}

/* ink 段缓存（prepareWithSegments 与 prepare 同价——同款 FIFO 纪律） */
const INK_SEG_CACHE_MAX = 400;
const inkSegCache = new Map<string, PreparedTextWithSegments>();

function getInkSeg(text: string, font: string): PreparedTextWithSegments {
  const key = `${font}::${text}`;
  let p = inkSegCache.get(key);
  if (p === undefined) {
    p = prepareWithSegments(text, font, { whiteSpace: 'pre-wrap' });
    inkSegCache.set(key, p);
    if (inkSegCache.size > INK_SEG_CACHE_MAX) {
      const first = inkSegCache.keys().next().value;
      if (first !== undefined) inkSegCache.delete(first);
    }
  }
  return p;
}

/** 单源一趟走查：lines = 画出的行（封顶截断），total = 全部行数（含空行与
 *  封顶外的行——只占 dy 不画）。 */
function inkForSource(src: InkSource, width: number): { lines: Array<{ x0: number; w: number }>; total: number } {
  const lines: Array<{ x0: number; w: number }> = [];
  let total = 0;
  const maxBars = src.cap ?? Number.POSITIVE_INFINITY;
  for (const seg of src.text.split('\n')) {
    if (seg === '') {
      total += 1;
      continue;
    }
    const prepared = getInkSeg(seg, src.font);
    walkLineRanges(prepared, Math.max(80, width), (line: LayoutLineRange) => {
      total += 1;
      if (lines.length < maxBars) lines.push({ x0: src.inset, w: line.width });
    });
  }
  return { lines, total };
}

/** 自由文本 → 墨条（纸条等无块语义的散墨）。 */
export function inkForText(text: string, width: number): BlockInk {
  const src: InkSource = { text, font: STRIP_INK.font, lineHeight: STRIP_INK.lineHeight, inset: STRIP_INK.inset };
  const { lines } = inkForSource(src, width);
  return {
    bars: lines.map((l, i) => ({ dy: i * src.lineHeight, x0: l.x0, w: l.w })),
    lineH: src.lineHeight,
  };
}

/* ── 块级墨迹缓存（与 BlockMeasureCache 同纪律：块 id + 签名 + 宽 记忆）── */

export interface InkCache {
  byId: Map<string, { key: string; ink: BlockInk }>;
}

export function createInkCache(): InkCache {
  return { byId: new Map() };
}

/** 折叠/空内容块的桩条宽（无行可画时给一根短墨条保住「有物」的观感）。 */
const STUB_BAR_W = 120;

/** 块墨迹（缓存优先）：文类分派走 inkSourcesFor，几何走 walkLineRanges。 */
export function inkForBlock(b: SourcedBlock, folded: boolean, cache: InkCache): BlockInk {
  const key = `${measureSignature(b, folded)}|w=${b.w}`;
  const hit = cache.byId.get(b.id);
  if (hit && hit.key === key) return hit.ink;
  const sources = inkSourcesFor(b, folded);
  const bars: InkBar[] = [];
  let dy = 0;
  let lineH = 14;
  for (const src of sources) {
    lineH = src.lineHeight;
    const { lines, total } = inkForSource(src, b.w - src.inset);
    for (const l of lines) {
      bars.push({ dy, x0: l.x0, w: l.w });
      dy += src.lineHeight;
    }
    dy += (total - lines.length) * src.lineHeight;
  }
  const ink: BlockInk = bars.length === 0 ? { bars: [{ dy: 0, x0: 0, w: STUB_BAR_W }], lineH: 14 } : { bars, lineH };
  cache.byId.set(b.id, { key, ink });
  return ink;
}
