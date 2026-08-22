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
// 纸面字体常量自持（纸是独立壳，不随观测台 --font-scale 缩放）。

import { clearCache as clearPretextCache, layout, type PreparedText, prepare } from '@chenglou/pretext';
import { parsePlanItems, type SourcedBlock } from './block-model';

/* ── 纸面字体常量（镜像 PaperPanel.css 兰台注疏版式——改样式两处同步）──
 * 兰台四体分工（docs/design/lantai-design-spec.md §2）：宋体正文 / 楷书来文 /
 * 等宽机读；英文思考链走宋体/Garamond，楷书只给人的来文。
 * 栈全具名——pretext 对 system-ui 在 macOS 不建模（PLATFORM_BUGS.md），
 * 且 canvas 测量字体必须与渲染字体一致，具名栈两处可对齐。 */

const SONG_STACK = '"EB Garamond Variable", "EB Garamond", "Noto Serif SC", "Songti SC", serif';
const KAI_STACK = '"Ma Shan Zheng", "EB Garamond Variable", "Kaiti SC", "STKaiti", serif';
const MONO_STACK = '"IBM Plex Mono", "Cascadia Code", "Consolas", monospace';

/** 来文（user）：楷书 18px/2.0 朱砂深（.pp-block.pp-user .pp-body） */
export const PAPER_USER_FONT = `18px ${KAI_STACK}`;
export const PAPER_USER_LINE_HEIGHT = 18 * 2;

/** 正文（markdown）：宋体 17px/2.0（.pp-block.pp-markdown .pp-body） */
export const PAPER_BODY_FONT = `17px ${SONG_STACK}`;
export const PAPER_BODY_LINE_HEIGHT = 17 * 2;

/** 夹注（reasoning）：13.5px/1.85 石墨（.pp-block.pp-reasoning .pp-body） */
export const PAPER_REASONING_FONT = `13.5px ${SONG_STACK}`;
export const PAPER_REASONING_LINE_HEIGHT = 13.5 * 1.85;

/** 贴黄（notice）：12.5px/1.7（.pp-block.pp-notice .pp-body） */
export const PAPER_NOTICE_FONT = `12.5px ${SONG_STACK}`;
export const PAPER_NOTICE_LINE_HEIGHT = 12.5 * 1.7;

/** 抄录（diff）图版：等宽 12.5px/1.7（.pp-block.pp-diff pre） */
export const PAPER_MONO_FONT = `12.5px ${MONO_STACK}`;
export const PAPER_MONO_LINE_HEIGHT = 12.5 * 1.7;

/** 脚注（tool）args：等宽 11.5px/1.6 石青（.pp-block.pp-tool pre） */
export const PAPER_TOOL_FONT = `11.5px ${MONO_STACK}`;
export const PAPER_TOOL_LINE_HEIGHT = 11.5 * 1.6;

/** 脚注输出/错误（.pp-out）：等宽 11px/1.5 */
export const PAPER_OUT_FONT = `11px ${MONO_STACK}`;
export const PAPER_OUT_LINE_HEIGHT = 11 * 1.5;

/** 拟策条目：13.5px/1.8（.pp-pc li） */
export const PAPER_PLAN_ITEM_FONT = `13.5px ${SONG_STACK}`;
export const PAPER_PLAN_ITEM_LINE_HEIGHT = 13.5 * 1.8;

/** 渲染端滚动上限（PaperPanel.css pre/输出 max-height——超限部分滚动不占高） */
export const PRE_MAX_H = 260;
export const OUT_MAX_H = 160;

/* ── per-kind chrome 常量（逐字镜像 PaperPanel.css 的 padding/border/margin）── */
const USER_TEXT_INSET = 20; // padding-left 18 + border-left 2
const REASONING_TEXT_INSET = 20; // padding-left 18 + border-left 2（虚线）
const TOOL_PAD_TOP = 10; // .pp-block.pp-tool padding-top（注线 ::before 不占高）
const OUT_CHROME_H = 13; // .pp-out margin-top 6 + padding-top 6 + border-top 1
const DIFF_LANG_H = 16; // .pp-lang 10px×lh1 + margin-bottom 6
const DIFF_PRE_CHROME_H = 30; // pre padding 14×2 + border-top/bottom 1×2
const DIFF_TEXT_INSET = 23; // border-left 3 + padding-left 20
const PLAN_CHROME_H = 31; // .pp-pc border-top 2 + border-bottom 1 + padding 14×2
const PLAN_HEAD_H = 39; // 标题 15×1.8=27 + head margin-bottom 12
const PLAN_ITEM_INSET = 36; // li padding-left（石青序号列）
const PLAN_ITEM_GAP = 7; // li margin-bottom（末项无）
const NOTICE_CHROME_H = 17; // padding 8×2 + border-bottom 1
const NOTICE_TEXT_INSET = 24; // padding 12×2

/* ── prepare 缓存（pretext-cache.ts 同款纪律）── */

const PREPARE_CACHE_MAX = 500;
const prepareCache = new Map<string, PreparedText>();

function getPrepared(text: string, font: string): PreparedText {
  const key = `${font}::${text}`;
  let p = prepareCache.get(key);
  if (p === undefined) {
    // whiteSpace 镜像 DOM：块文本是 pre-wrap 语义（换行符是硬换行）
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

/** 封顶测量：真实行高 × 行数，超 maxH 截断（滚动部分不占高）。 */
function cappedH(text: string, width: number, font: string, lineHeight: number, maxH: number): number {
  if (!text) return 0;
  return Math.min(maxH, measureTextHeight(text, width, font, lineHeight));
}

/**
 * 块高真测量（世界单位）：按 kind 分派，注疏版式七类各自计高。
 * 纯函数 + 缓存——同 key 重复调用零成本。
 */
export function measureBlockHeight(b: SourcedBlock): number {
  const p = b.payload as PayloadLike;
  switch (b.kind) {
    case 'user':
      // 圈点（C7）：测高用原文不去【】括号——括号被渲染消费但宽度预算
      // 保守覆盖了圈 padding/border（每关键词净差约一个全角字符，方向是
      // 测多不测少 → 只会偏高不会截字），零镜像成本。
      return p.text ? measureTextHeight(p.text, b.w - USER_TEXT_INSET, PAPER_USER_FONT, PAPER_USER_LINE_HEIGHT) : 0;
    case 'markdown':
      return p.text ? measureTextHeight(p.text, b.w, PAPER_BODY_FONT, PAPER_BODY_LINE_HEIGHT) : 0;
    case 'reasoning':
      return p.text
        ? measureTextHeight(p.text, b.w - REASONING_TEXT_INSET, PAPER_REASONING_FONT, PAPER_REASONING_LINE_HEIGHT)
        : 0;
    case 'notice':
      return p.text
        ? NOTICE_CHROME_H +
            measureTextHeight(p.text, b.w - NOTICE_TEXT_INSET, PAPER_NOTICE_FONT, PAPER_NOTICE_LINE_HEIGHT)
        : 0;
    case 'diff': {
      const langH = (b.payload as { lang?: string }).lang ? DIFF_LANG_H : 0;
      const preH = p.text
        ? DIFF_PRE_CHROME_H + cappedH(p.text, b.w - DIFF_TEXT_INSET, PAPER_MONO_FONT, PAPER_MONO_LINE_HEIGHT, PRE_MAX_H)
        : 0;
      return langH + preH;
    }
    case 'tool': {
      const argsH = cappedH(p.args ?? '', b.w, PAPER_TOOL_FONT, PAPER_TOOL_LINE_HEIGHT, PRE_MAX_H);
      const outH = p.output
        ? OUT_CHROME_H + cappedH(p.output, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, OUT_MAX_H)
        : 0;
      const errH = p.err ? OUT_CHROME_H + cappedH(p.err, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, OUT_MAX_H) : 0;
      return TOOL_PAD_TOP + argsH + outH + errH;
    }
    case 'plan': {
      const items = parsePlanItems(p.content ?? '');
      const itemsH =
        items.length === 0
          ? 0
          : items.reduce(
              (sum, it) =>
                sum +
                measureTextHeight(it, b.w - PLAN_ITEM_INSET, PAPER_PLAN_ITEM_FONT, PAPER_PLAN_ITEM_LINE_HEIGHT) +
                PLAN_ITEM_GAP,
              0,
            ) - PLAN_ITEM_GAP;
      return PLAN_CHROME_H + PLAN_HEAD_H + itemsH;
    }
  }
}

/* ── 缓存管理 ── */

/** 测试复位（生产不调用）。 */
export function clearPaperMeasureCache(): void {
  prepareCache.clear();
  clearPretextCache();
}
