// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/ink — 缩远墨迹（P4 LOD）：远缩档把 DOM 块树替换为 canvas「真文字缩微」
// ——每行由 materializeLineRange 取回原文，canvas 按缩放字号直绘，远看是真实的
// 缩小纸面（真卷轴），近看无缝回 DOM 正文。纯几何层：文类分派在
// measure.inkSourcesFor（单一真源，与测高共用 payload 语义与镜像常量）。
//
// 墨条语义：dy = 距块顶的纵向偏移（世界单位），x0 = 距块左的横向偏移（含文类
// 内缩），w = 行宽，text = 行原文。行高来自文类 lineHeight——LOD 抽象层，不
// 镜像 6-14px 级块内间距（骨架与 DOM 实高允许小漂移，行数/行宽是精确的）。
//
// 封顶语义（镜像渲染端滚动区）：超过 cap 的行只推进 dy 不画——滚动部分不占
// 视觉、但占骨架高度，与测高的 cappedH 同一语义。

import {
  type LayoutLineRange,
  materializeLineRange,
  type PreparedTextWithSegments,
  prepareWithSegments,
  walkLineRanges,
} from '@chenglou/pretext';
import type { SourcedBlock } from './block-model';
import { type InkSource, inkSourcesFor, measureSignature } from './measure';

/** 单根墨条。text = 行原文（空串 = 桩条：折叠/空块画短矩形）。 */
export interface InkBar {
  /** 距块顶的纵向偏移（世界单位） */
  dy: number;
  /** 距块左的横向偏移（世界单位，含文类内缩） */
  x0: number;
  /** 行宽（世界单位） */
  w: number;
  /** 行原文（materializeLineRange 产物——缩微直绘用） */
  text: string;
}

/** 一块的墨迹骨架。size/stack = 主文字源的字号/字体栈（canvas 缩放直绘用；
 *  多源块的次源字号差 ≤1.5px，缩微层共用主源字号——LOD 抽象层）。 */
export interface BlockInk {
  bars: InkBar[];
  /** 主行高（行距） */
  lineH: number;
  /** 主文字源字号（px） */
  size: number;
  /** 主文字源字体栈 */
  stack: string;
}

/* ── LOD 迟滞（防抖）：进入 < 0.55，退出需 > 0.62——阈值间往返不闪烁 ── */
export const LOD_ENTER = 0.55;
export const LOD_EXIT = 0.62;

export function lodActive(zoom: number, prev: boolean): boolean {
  return prev ? zoom < LOD_EXIT : zoom < LOD_ENTER;
}

/* ── 远景三档（2026-09-06 P4c，用户拍板「奔效果最好的方向」）──
 * 前情：P4 v1 行条骨架（14fa755c）实机打回 → v2 真文字缩微（b870ede8）实机
 * 再打回——两个极端各烂一半：真文字在 0.35 以下跌破可读阈成灰噪声（中文
 * 3-6px = 方块噪点，行距坍缩行叠行），行条在可读带又丢掉真实纸面质感。
 * 终案：**分档**——真文字只留在它成立的档位（≥0.36 半可读），以下转
 * 「文字的影子」（真行宽/真行距的墨条，与小地图同语言），极远转卷剪影
 * （块级墨影 + 文类色签边——段落节奏可见，不画逐行噪声）。
 * 每条边界独立迟滞，InkLayer 帧内直读（不进 React 渲染帧）。 */
export type LodTier = 'text' | 'bar' | 'silhouette';

/** 文字档 ↔ 行影档边界：进 < 0.36，出 > 0.39（0.36 档 16px 字 ≈ 5.8px 半可读）。 */
export const LOD_BAR_ENTER = 0.36;
export const LOD_BAR_EXIT = 0.39;
/** 行影档 ↔ 卷剪影档边界：进 < 0.14，出 > 0.16（再远逐行条也开始并线）。 */
export const LOD_SIL_ENTER = 0.14;
export const LOD_SIL_EXIT = 0.16;

export function lodTierOf(zoom: number, prev: LodTier): LodTier {
  if (prev === 'silhouette') {
    return zoom >= LOD_SIL_EXIT ? 'bar' : 'silhouette';
  }
  if (zoom < LOD_SIL_ENTER) return 'silhouette';
  if (prev === 'bar') {
    return zoom >= LOD_BAR_EXIT ? 'text' : 'bar';
  }
  return zoom < LOD_BAR_ENTER ? 'bar' : 'text';
}

/** 远档 React 侧二值旗标（卷首头/边缘手柄等 DOM 退场用，与 InkLayer 内部
 *  tier 同边界同迟滞——DOM 面与 canvas 面永远同档，不出现半 DOM 半 canvas）。 */
export function lodFarActive(zoom: number, prev: boolean): boolean {
  return prev ? zoom < LOD_BAR_EXIT : zoom < LOD_BAR_ENTER;
}

/** 文字档内单块降档阈：主文字源字号 × zoom 低于此值时该块转行影
 *  （13px 程文/脚注族在 0.36 档 ≈ 4.7px——写不如影）。 */
export const LOD_TEXT_MIN_PX = 5.5;

/* ── 墨色板（镜像 tokens.css L17-27——canvas 读不了 CSS 变量，字面量进镜像纪律，
 * tests/paper-ink.test.ts 钉死字面量；改 token 两处同步）──
 * 正文=墨 --ink-1 / 来文=朱砂 --seal / 夹注=石墨 --graphite / 脚注·程文·抄录·
 * 拟策=石青 --indigo / 贴黄=次级 --ink-2 / 资产与未知=三级 --ink-3
 * 2026-08-31 浸墨化 v2：墨色改 ink-1 alpha 稀释（正文 .94 / 次级 .7 / 三级 .48），
 * 镜像是同一瓶墨兑水（rgba）——canvas 叠透明层上再罩纸面，与 DOM 墨同行为。 */
export const INK_COLORS = {
  markdown: 'rgba(38, 34, 28, 0.94)',
  user: '#a63a2e',
  reasoning: '#6f6e68',
  tool: '#3a5b7a',
  code: '#3a5b7a',
  diff: '#3a5b7a',
  plan: '#3a5b7a',
  notice: 'rgba(38, 34, 28, 0.7)',
  _default: 'rgba(38, 34, 28, 0.48)',
  _strip: 'rgba(38, 34, 28, 0.7)',
} as const;

export function inkColorOf(kind: string): string {
  return (INK_COLORS as Record<string, string>)[kind] ?? INK_COLORS._default;
}

/* ── 行影档墨色（2026-09-06 P4c）——同一瓶墨兑水，按「墨条 100% 覆盖 vs
 * 文字约 30% 笔画覆盖」做距离墨量补偿：条面 alpha ≈ 文字色面 × 0.45，读作
 * 「远看文字应有的灰度」而非黑墙。朱砂（来文）是地志 landmark 略提亮。
 * 镜像纪律同上：字面量由 tests/paper-ink.test.ts 钉死。 */
export const INK_BAR_COLORS = {
  markdown: 'rgba(38, 34, 28, 0.42)',
  user: 'rgba(166, 58, 46, 0.58)',
  reasoning: 'rgba(111, 110, 104, 0.38)',
  tool: 'rgba(58, 91, 122, 0.44)',
  code: 'rgba(58, 91, 122, 0.44)',
  diff: 'rgba(58, 91, 122, 0.44)',
  plan: 'rgba(58, 91, 122, 0.44)',
  notice: 'rgba(38, 34, 28, 0.28)',
  _default: 'rgba(38, 34, 28, 0.24)',
  _strip: 'rgba(38, 34, 28, 0.38)',
} as const;

/** 行影档文类色（真文字色兑水后的条面色）。 */
export function inkBarColorOf(kind: string): string {
  return (INK_BAR_COLORS as Record<string, string>)[kind] ?? INK_BAR_COLORS._default;
}

/** 报错墨（tokens.css `--fail` 字面量镜像）。canvas 里取不到 CSS 变量，而语义
 *  状态色必须有 TS 侧真源：报错走语义状态，**朱砂=人不可挪用**（目次带识别层
 *  的「错」短规 + 刻痕 error 族同源）。字面量由 tests/paper-ink.test.ts 钉死。 */
export const INK_FAIL = '#a9443f';

/* ── 卷剪影档（2026-09-06 P4c）：块级墨影 + 文类色签边 ──
 * 墨影 = 块足迹淡墨（远看纸上有字的「灰质」而非内容）；签边 = 块左缘
 * 2-4px 色条（文类签的远景化身——段落节奏与文类结构可见）。
 * 远景卷名 = 地志标签语义：字号有下限（地图标签逻辑），墨色 ink-1
 * （卷首题字同色，朱砂=人铁律不挪用）。 */
export const INK_SIL_MASS_ALPHA = 0.12;
export const INK_SIL_ACCENT_ALPHA = 0.5;
export const INK_LABEL_MIN_PX = 11;
export const INK_LABEL_ALPHA = 0.66;

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

/** 解析 measure 字体串（`${size}px ${stack}`）→ 缩放直绘用的字号/栈。 */
function parseFont(font: string): { size: number; stack: string } {
  const m = /^([\d.]+)px (.*)$/.exec(font);
  return m ? { size: Number.parseFloat(m[1]), stack: m[2] } : { size: 14, stack: font };
}

/** 单源一趟走查：lines = 画出的行（封顶截断，materialize 出行原文），total =
 *  全部行数（含空行与封顶外的行——只占 dy 不画）。 */
function inkForSource(
  src: InkSource,
  width: number,
): { lines: Array<{ x0: number; w: number; text: string }>; total: number } {
  const lines: Array<{ x0: number; w: number; text: string }> = [];
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
      if (lines.length < maxBars) {
        const full = materializeLineRange(prepared, line);
        lines.push({ x0: src.inset, w: full.width, text: full.text });
      }
    });
  }
  return { lines, total };
}

/* ── 块级墨迹缓存（与 BlockMeasureCache 同纪律：块 id + 签名 + 宽 记忆）── */

export interface InkCache {
  byId: Map<string, { key: string; ink: BlockInk }>;
}

export function createInkCache(): InkCache {
  return { byId: new Map() };
}

/** 折叠/空内容块的桩条（无行可画时一根短墨保住「有物」观感）。 */
const STUB_BAR: InkBar = { dy: 0, x0: 0, w: 120, text: '' };
const STUB_INK: BlockInk = { bars: [STUB_BAR], lineH: 14, size: 14, stack: '' };

/** 块墨迹（缓存优先）：文类分派走 inkSourcesFor，几何走 walkLineRanges +
 *  materializeLineRange（行原文缩微直绘）。 */
export function inkForBlock(b: SourcedBlock, folded: boolean, cache: InkCache): BlockInk {
  const key = `${measureSignature(b, folded)}|w=${b.w}`;
  const hit = cache.byId.get(b.id);
  if (hit && hit.key === key) return hit.ink;
  const sources = inkSourcesFor(b, folded);
  const bars: InkBar[] = [];
  let dy = 0;
  let lineH = 14;
  let size = 14;
  let stack = '';
  for (const src of sources) {
    lineH = src.lineHeight;
    const f = parseFont(src.font);
    size = f.size;
    stack = f.stack;
    const { lines, total } = inkForSource(src, b.w - src.inset);
    for (const l of lines) {
      bars.push({ dy, x0: l.x0, w: l.w, text: l.text });
      dy += src.lineHeight;
    }
    dy += (total - lines.length) * src.lineHeight;
  }
  const ink: BlockInk = bars.length === 0 ? STUB_INK : { bars, lineH, size, stack };
  cache.byId.set(b.id, { key, ink });
  return ink;
}
