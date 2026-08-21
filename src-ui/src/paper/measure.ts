// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/measure — V3a 块高真测量（@chenglou/pretext 封装）。
//
// 走查弹的「估算 + 实测反馈环」（PaperPanel estimateBlockHeight + offsetHeight
// 回写）在此替换为正式测量：块高由 Canvas measureText 算出，不触发 DOM 重排。
// 拍板/选型：paper-shell 待定 #8——上游 @chenglou/pretext 取代内部 lib/pretext
// 快照（同源同思想；内部版随 V3a 退役）。
//
// 缓存纪律（沿用 ui/pretext-cache.ts 既有模式）：
//   - prepare() 开销大（分段 + canvas 测量）→ 按 `${font}::${text}` 缓存
//     PreparedText，FIFO 淘汰；layout() 本身廉价（~0.0002ms）不缓存。
//   - 块高缓存 key 含内容 hash + 宽度 + 字体——流式文本增长自然产生新条目。
//
// 纸面字体常量自持（纸是独立壳，不随观测台 --font-scale 缩放）：
// 与 PaperPanel.css 灰框纪律一致——结构对即可，视觉是 V2 契约的事。

import { clearCache as clearPretextCache, layout, type PreparedText, prepare } from '@chenglou/pretext';
import type { SourcedBlock } from './block-model';

/* ── 纸面字体常量（镜像 PaperPanel.css——改样式两处同步）──
 * 待定 #8 拍板：纸壳字体栈全具名（Fraunces / Noto Serif SC / JetBrains Mono），
 * 不用 system-ui——pretext 对 system-ui 在 macOS 不建模（PLATFORM_BUGS.md），
 * 且 canvas 测量字体必须与渲染字体一致，具名栈两处可对齐。 */

/** 块正文（markdown/user/notice）：.pp-root 13px/1.6 具名衬线栈 */
export const PAPER_BODY_FONT = '13px "Fraunces Variable", "Noto Serif SC", serif';
export const PAPER_BODY_LINE_HEIGHT = 13 * 1.6;

/** 推理段（.pp-reasoning 字号覆盖 12px） */
export const PAPER_REASONING_FONT = '12px "Fraunces Variable", "Noto Serif SC", serif';
export const PAPER_REASONING_LINE_HEIGHT = 12 * 1.6;

/** 块内等宽（diff/tool/plan 内容）：.pp-block pre 11px/1.5 具名等宽栈 */
export const PAPER_MONO_FONT = '11px "JetBrains Mono", "Cascadia Code", monospace';
export const PAPER_MONO_LINE_HEIGHT = 11 * 1.5;

/** 渲染端滚动上限（PaperPanel.css pre/输出 max-height——超限部分滚动不占高） */
export const PRE_MAX_H = 260;
export const OUT_MAX_H = 160;

/** 块头部/内边距固定高度（.pp-kind 行 + .pp-block padding 上下 10px） */
const BLOCK_HEAD_H = 22;
const BLOCK_PAD_H = 20;

/* ── prepare 缓存（pretext-cache.ts 同款纪律）── */

const PREPARE_CACHE_MAX = 500;
const prepareCache = new Map<string, PreparedText>();

function getPrepared(text: string, font: string): PreparedText {
  const key = `${font}::${text}`;
  let p = prepareCache.get(key);
  if (p === undefined) {
    // whiteSpace 镜像 DOM：.pp-block 的文本节点是 pre-wrap 语义（换行符是硬换行）
    p = prepare(text, font, { whiteSpace: 'pre-wrap' });
    prepareCache.set(key, p);
    if (prepareCache.size > PREPARE_CACHE_MAX) {
      const firstKey = prepareCache.keys().next().value;
      if (firstKey !== undefined) prepareCache.delete(firstKey);
    }
  }
  return p;
}

/* ── 文本测量原语 ── */

/** 纯文本块高度（body 字体，pre-wrap）。空文本返回 0。 */
export function measureTextHeight(
  text: string,
  maxWidth: number,
  font = PAPER_BODY_FONT,
  lineHeight = PAPER_BODY_LINE_HEIGHT,
): number {
  if (!text) return 0;
  const prepared = getPrepared(text, font);
  return layout(prepared, maxWidth, lineHeight).height;
}

/* ── 块级测量 ── */

interface PayloadLike {
  text?: string;
  content?: string;
  args?: string;
  output?: string;
  err?: string;
}

/** mono 内容高度：真实行高 × 行数，封顶 maxH（超限滚动不占高）。 */
function monoBlockH(text: string, width: number, maxH: number): number {
  if (!text) return 0;
  const raw = measureTextHeight(text, width, PAPER_MONO_FONT, PAPER_MONO_LINE_HEIGHT);
  return Math.min(maxH, raw);
}

/**
 * 块高真测量（世界单位）：按 kind 分派，替代走查弹的 estimateBlockHeight。
 * 纯函数 + 缓存——同 key 重复调用零成本。
 */
export function measureBlockHeight(b: SourcedBlock): number {
  const p = b.payload as PayloadLike;
  const bodyW = b.w - 24; // .pp-block 左右 padding 各 12px
  const monoW = b.w - 24;
  switch (b.kind) {
    case 'reasoning': {
      const textH = p.text ? measureTextHeight(p.text, bodyW, PAPER_REASONING_FONT, PAPER_REASONING_LINE_HEIGHT) : 0;
      return BLOCK_HEAD_H + BLOCK_PAD_H + textH;
    }
    case 'user':
    case 'markdown':
    case 'notice': {
      const textH = p.text ? measureTextHeight(p.text, bodyW) : 0;
      return BLOCK_HEAD_H + BLOCK_PAD_H + textH;
    }
    case 'diff': {
      const preH = p.text ? monoBlockH(p.text, monoW, PRE_MAX_H) + 8 : 0;
      const langH = (b.payload as { lang?: string }).lang ? 14 : 0;
      return BLOCK_HEAD_H + BLOCK_PAD_H + langH + preH;
    }
    case 'tool': {
      const argsH = p.args ? monoBlockH(p.args, monoW, PRE_MAX_H) + 8 : 0;
      const outH = p.output ? monoBlockH(p.output, monoW, OUT_MAX_H) + 12 : 0;
      const errH = p.err ? monoBlockH(p.err, monoW, OUT_MAX_H) + 12 : 0;
      return BLOCK_HEAD_H + BLOCK_PAD_H + argsH + outH + errH;
    }
    case 'plan': {
      const planH = p.content ? monoBlockH(p.content, monoW, PRE_MAX_H) + 8 : 0;
      return BLOCK_HEAD_H + BLOCK_PAD_H + planH;
    }
  }
}

/* ── 缓存管理 ── */

/** 测试复位（生产不调用）。 */
export function clearPaperMeasureCache(): void {
  prepareCache.clear();
  clearPretextCache();
}
