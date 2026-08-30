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
import { type MdBlock, type MdInline, mdHasRichInline, mdPlainText, parseMarkdown } from './markdown';
import { prettyToolArgs } from './tool-text';

/* ── 纸面字体常量（镜像 PaperPanel.css 兰台注疏版式——改样式两处同步）──
 * 兰台四体分工（docs/design/lantai-design-spec.md §2）：宋体正文 / 楷书来文 /
 * 等宽机读；英文思考链走宋体/Garamond，楷书只给人的来文。
 * 栈全具名——pretext 对 system-ui 在 macOS 不建模（PLATFORM_BUGS.md），
 * 且 canvas 测量字体必须与渲染字体一致，具名栈两处可对齐。 */

const SONG_STACK = '"EB Garamond Variable", "EB Garamond", "Noto Serif SC", "Songti SC", serif';
const KAI_STACK = '"Ma Shan Zheng", "EB Garamond Variable", "Kaiti SC", "STKaiti", "KaiTi", "楷体", serif';
const MONO_STACK = '"IBM Plex Mono", "Cascadia Code", "Consolas", monospace';

/** 来文（user）：楷书 16px/1.9 朱砂深（.pp-block.pp-user .pp-body）
 *  B4 环1 拍板 C：字号 18→16 收到正文 17 之下，行高同 C 变体 1.9 */
export const PAPER_USER_FONT = `16px ${KAI_STACK}`;
export const PAPER_USER_LINE_HEIGHT = 16 * 1.9;

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

/** 正文段距（2026-08-30 markdown 专项改版：17px/行距 2.0 下 10px 段距比行距
 *  还小、段落黏连——提到 14px；.pp-md-p margin-bottom 镜像）。 */
export const MD_P_GAP = 14;

/* ── markdown 子版式常量（逐字镜像 PaperPanel.css .pp-md-*——2026-08-30 增）──
 * 结构：块元素只用「padding 上下面距 + margin-bottom 块间距」两种纵向量，
 * 测高 = Σ(元素高) + Σ(非末元素 margin-bottom)（CSS :last-child margin 归零镜像）；
 * 不用 margin-top（首元素 margin 会逃逸出 .pp-body 破坏测高）。 */
/** 标题四级：字号 / 行高系数 / padding 上下（.pp-md-h1..h4） */
const MD_H = [
  { size: 20, lh: 1.5, pt: 22, pb: 10 },
  { size: 18, lh: 1.6, pt: 20, pb: 8 },
  { size: 16.5, lh: 1.7, pt: 16, pb: 6 },
  { size: 15.5, lh: 1.8, pt: 14, pb: 6 },
] as const;
const MD_LIST_GAP = 14; // .pp-md-list margin-bottom
const MD_LI_GAP = 6; // .pp-md-li margin-bottom（末项 :last-child 归零）
const MD_LI_INDENT = 26; // .pp-md-li padding-left（标记列）
const MD_SUB_INDENT = 22; // .pp-md-list--sub padding-left（嵌套列表再缩进）
const MD_SUB_TOP = 4; // 嵌套列表与项文本间距（.pp-md-list--sub margin-top）
const MD_QUOTE_GAP = 14; // .pp-md-quote margin-bottom
const MD_QUOTE_PAD_V = 4; // .pp-md-quote padding 上下（2+2）
const MD_QUOTE_INSET = 18; // .pp-md-quote padding-left 16 + border-left 2
const MD_CODE_GAP = 14; // .pp-md-code margin-bottom
const MD_CODE_PAD_V = 20; // .pp-md-code padding 上下（10+10）
const MD_CODE_INSET = 27; // border-left 3 + padding 左右 12×2
const MD_HR_H = 37; // .pp-md-hr margin 18 + 线 1 + margin 18
const MD_HR_LAST_H = 19; // 末元素 :last-child margin-bottom 归零
const MD_TABLE_GAP = 14; // .pp-md-table margin-bottom
const MD_TABLE_CELL_PAD = 8; // th/td 左右 padding 8×2
const MD_TABLE_CELL_PAD_V = 8; // th/td 上下 padding 4×2
const MD_TABLE_ROW_BORDER = 1; // 行底规线
/** 表格单元字体：等宽 11.5px/1.5（.pp-md-table） */
const MD_TABLE_FONT = `11.5px ${MONO_STACK}`;
const MD_TABLE_LINE_HEIGHT = 11.5 * 1.5;
/** 富行内（行内码/加粗/斜体/删除线/链接）字宽偏移的保守补偿：
 *  可用宽度 ×0.96 → 宁可多计行（偏高=多留空隙），不许偏矮（重叠）。 */
const MD_RICH_BIAS = 0.96;

/* ── 折叠行（2026-08-30 折叠机制；.pp-fold 镜像）── */
/** 折叠行高 = 行 14px（mono 10px）+ margin-bottom 6px。夹注/脚注/程文恒有。 */
export const FOLD_ROW_H = 20;

/** 渲染端滚动上限（PaperPanel.css pre/输出 max-height——超限部分滚动不占高） */
export const PRE_MAX_H = 260;
export const OUT_MAX_H = 160;

/* ── 程文（code）专属镜像常量——.pp-code-src / .pp-code .pp-out 与脚注族不同款 ──
 * 2026-08-30 溢出修复：旧测量按整宽 + PRE_MAX_H 260 + 零内距，而 CSS 实况是
 * 17px 横向内缩 + 20px 纵向内距 + max-height 320 → 展开后 DOM 恒高于测高，
 * 下一块压字（用户报「程文展开后文字溢出」的根因）。 */
/** .pp-code-src 横向内缩 = border-left 3 + padding-left 14。 */
export const CODE_SRC_INSET = 17;
/** .pp-code-src 纵向内距 = padding 10×2（box-sizing border-box，max-height 内扣）。 */
export const CODE_SRC_PAD_V = 20;
/** .pp-code-src max-height（内容预算 = 320 - 20 内距）。 */
export const CODE_SRC_MAX_H = 320;
/** .pp-code .pp-out max-height 200（脚注族是 160）——文本内容预算 = 200 - padding-top 6 - border-top 1。 */
export const CODE_OUT_TEXT_MAX = 193;

/* ── per-kind chrome 常量（逐字镜像 PaperPanel.css 的 padding/border/margin）── */
const USER_TEXT_INSET = 20; // padding-left 18 + border-left 2
/** asterism（B1）：来文尾三星高度 = margin-top 30 + 字行 14（line-height 1）。 */
const USER_ASTERISM_H = 30 + 14;
/** 来文附件行（C10）：每行 mono 11px / 行高 16 + 上间距 8 + 弱规线 1。
 *  逐字镜像 .pp-user-files / .pp-user-file 的 margin/line-height。 */
const USER_FILE_LINE_H = 16;
const USER_FILES_MARGIN_TOP = 9; // margin-top 8 + 规线 1
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
const PLAN_ACTIONS_H = 40; // 审批操作行（按钮行高 + margin-top 14，偏保守）
const PLAN_OPTIONS_H = 118; // 方案选择区（border-top + padding + 3 方案×~36，偏保守）
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
  code?: string;
}

/** 封顶测量：真实行高 × 行数，超 maxH 截断（滚动部分不占高）。 */
function cappedH(text: string, width: number, font: string, lineHeight: number, maxH: number): number {
  if (!text) return 0;
  return Math.min(maxH, measureTextHeight(text, width, font, lineHeight));
}

/** 程文程序体高（.pp-code-src 逐字镜像）：文本宽 = w - 17 内缩；
 * DOM 高 = min(textH, 320 内容预算 300) + 20 纵向内距（overflow:auto 截断部分不占高）。 */
function codeSrcH(text: string, w: number): number {
  if (!text) return 0;
  const contentH = Math.min(
    measureTextHeight(text, Math.max(80, w - CODE_SRC_INSET), PAPER_TOOL_FONT, PAPER_TOOL_LINE_HEIGHT),
    CODE_SRC_MAX_H - CODE_SRC_PAD_V,
  );
  return contentH + CODE_SRC_PAD_V;
}

/* ── markdown 块测量（渲染 MarkdownBody 的逐字镜像——消费同一 parseMarkdown 模型）── */

function songFont(size: number): string {
  return `${size}px ${SONG_STACK}`;
}

/** 富行内偏窄宽度：无富行内原宽；有 → ×0.96（宁高勿矮）。 */
function biasWidth(inl: MdInline[], width: number): number {
  return mdHasRichInline(inl) ? Math.max(80, Math.round(width * MD_RICH_BIAS)) : width;
}

function measureInlineHeight(inl: MdInline[], width: number, font: string, lineHeight: number): number {
  const text = mdPlainText(inl);
  if (!text) return 0;
  return measureTextHeight(text, biasWidth(inl, width), font, lineHeight);
}

function tableRowH(cells: MdInline[][], w: number): number {
  const cols = Math.max(1, ...cells.map((c) => c.length));
  const colW = Math.max(40, w / cols - MD_TABLE_CELL_PAD);
  let linesH = 0;
  for (const cell of cells)
    linesH = Math.max(linesH, measureInlineHeight(cell, colW, MD_TABLE_FONT, MD_TABLE_LINE_HEIGHT));
  return linesH + MD_TABLE_CELL_PAD_V + MD_TABLE_ROW_BORDER;
}

/** 单个 markdown 元素高度（last = 序列末元素：margin-bottom 归零镜像）。 */
function measureMdElement(el: MdBlock, w: number, last: boolean): number {
  switch (el.t) {
    case 'p': {
      const h = measureInlineHeight(el.inl, w, PAPER_BODY_FONT, PAPER_BODY_LINE_HEIGHT);
      if (!el.inl.length || mdPlainText(el.inl).length === 0) return 0;
      return h + (last ? 0 : MD_P_GAP);
    }
    case 'h': {
      const c = MD_H[el.lv - 1];
      return c.pt + measureInlineHeight(el.inl, w, songFont(c.size), c.size * c.lh) + c.pb;
    }
    case 'list': {
      let items = 0;
      for (const it of el.items) {
        let ih = measureInlineHeight(it.inl, w - MD_LI_INDENT, PAPER_BODY_FONT, PAPER_BODY_LINE_HEIGHT);
        if (it.sub) ih += MD_SUB_TOP + measureMdBlocks(it.sub, w - MD_LI_INDENT - MD_SUB_INDENT);
        items += ih + MD_LI_GAP;
      }
      items = Math.max(0, items - MD_LI_GAP); // 末项 li margin-bottom 0（:last-child）
      return items + (last ? 0 : MD_LIST_GAP);
    }
    case 'quote':
      return MD_QUOTE_PAD_V + measureMdBlocks(el.blocks, w - MD_QUOTE_INSET) + (last ? 0 : MD_QUOTE_GAP);
    case 'code': {
      if (!el.text) return 0;
      const h = cappedH(el.text, w - MD_CODE_INSET, PAPER_MONO_FONT, PAPER_MONO_LINE_HEIGHT, PRE_MAX_H);
      return MD_CODE_PAD_V + h + (last ? 0 : MD_CODE_GAP);
    }
    case 'hr':
      return last ? MD_HR_LAST_H : MD_HR_H;
    case 'table': {
      let h = tableRowH(el.head, w);
      for (const row of el.rows) h += tableRowH(row, w);
      return h + (last ? 0 : MD_TABLE_GAP);
    }
  }
}

/** markdown 块序列总高（顶层 .pp-body 直排子元素）。 */
export function measureMdBlocks(blocks: MdBlock[], w: number): number {
  let total = 0;
  for (let k = 0; k < blocks.length; k++) total += measureMdElement(blocks[k], w, k === blocks.length - 1);
  return total;
}

/**
 * 块高真测量（世界单位）：按 kind 分派，注疏版式七类各自计高。
 * 纯函数 + 缓存——同 key 重复调用零成本。
 * folded（2026-08-30 折叠机制）：夹注/脚注/程文的折叠态计高——直接调用缺省
 * 展开（false）；壳层经 measureBlockHeightCached 传有效折叠态（覆盖 ?? 默认规则）。
 */
export function measureBlockHeight(b: SourcedBlock, folded = false): number {
  const p = b.payload as PayloadLike;
  switch (b.kind) {
    case 'user': {
      // 圈点（C7）：测高用原文不去【】括号——括号被渲染消费但宽度预算
      // 保守覆盖了圈的 padding/border（每关键词净差约一个全角字符，方向是
      // 测多不测少 → 只会偏高不会截字），零镜像成本。
      const textH = p.text
        ? measureTextHeight(p.text, b.w - USER_TEXT_INSET, PAPER_USER_FONT, PAPER_USER_LINE_HEIGHT)
        : 0;
      // 附件行（C10）：每文件一行 mono 小字，高度线性叠加
      const files = (b.payload as { files?: Array<{ path: string; name: string }> }).files;
      const filesH = files?.length ? USER_FILES_MARGIN_TOP + files.length * USER_FILE_LINE_H : 0;
      // asterism（B1）：来文恒有尾三星，高度恒加
      return textH + filesH + USER_ASTERISM_H;
    }
    case 'markdown': {
      // markdown 专项（2026-08-30）：消费 parseMarkdown 结构模型逐元素计高
      // （与 MarkdownBody 渲染共用同一解析——结构漂移结构性不成立）。
      if (!p.text) return 0;
      return measureMdBlocks(parseMarkdown(p.text), b.w);
    }
    case 'reasoning': {
      if (!p.text) return FOLD_ROW_H;
      if (folded) return FOLD_ROW_H + PAPER_REASONING_LINE_HEIGHT; // 预览恒一行（.pp-fold-preview 截断）
      return (
        FOLD_ROW_H +
        measureTextHeight(p.text, b.w - REASONING_TEXT_INSET, PAPER_REASONING_FONT, PAPER_REASONING_LINE_HEIGHT)
      );
    }
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
      // 折叠机制（fold.ts 同款规则镜像）：折叠态只留折叠行——参数/输出/错误全收
      const argsH = folded
        ? 0
        : cappedH(prettyToolArgs(p.args ?? ''), b.w, PAPER_TOOL_FONT, PAPER_TOOL_LINE_HEIGHT, PRE_MAX_H);
      const outH = folded
        ? 0
        : p.output
          ? OUT_CHROME_H + cappedH(p.output, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, OUT_MAX_H)
          : 0;
      const errH = folded
        ? 0
        : p.err
          ? OUT_CHROME_H + cappedH(p.err, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, OUT_MAX_H)
          : 0;
      return TOOL_PAD_TOP + FOLD_ROW_H + argsH + outH + errH;
    }
    case 'code': {
      // 与 tool 同构的封顶测量（P2-A）：程序体 + 输出 + 错误三段。
      // 折叠态收程序体、留输出/错误（执行结果一眼可见——与脚注折叠的差异面）。
      // 2026-08-30 溢出修复：程序体走 .pp-code-src 专属镜像（内缩/内距/320 封顶），
      // 输出/错误走 .pp-code .pp-out 的 200 上限（脚注族 160 不同款）。
      const codeH = folded ? 0 : codeSrcH((b.payload as { code?: string }).code ?? p.args ?? '', b.w);
      const outH = p.output
        ? OUT_CHROME_H + cappedH(p.output, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, CODE_OUT_TEXT_MAX)
        : 0;
      const errH = p.err
        ? OUT_CHROME_H + cappedH(p.err, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, CODE_OUT_TEXT_MAX)
        : 0;
      return TOOL_PAD_TOP + FOLD_ROW_H + codeH + outH + errH;
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
      // 审批交互（施工单 #1/#2）：有回调才占操作区高度，无回调的只读拟策块不增加
      const plan = b.payload as { _callback?: unknown; options?: unknown[] };
      const optionsH = plan._callback && (plan.options?.length ?? 0) >= 2 ? PLAN_OPTIONS_H : 0;
      const actionsH = plan._callback ? PLAN_ACTIONS_H : 0;
      return PLAN_CHROME_H + PLAN_HEAD_H + itemsH + optionsH + actionsH;
    }
    default:
      // 资产/开放 kind：WO-4 漂亮 JSON 渲染器落地前给保守占位高，避免 NaN/塌陷。
      return 80;
  }
}

/* ── 块级测量缓存（性能专项第一刀：流式全量重算 → 只真测变更块）──
 * measureBlockHeight 内部的 prepareCache 已按「字体::文本」缓存 canvas 测量，
 * 但每渲染仍会对全量块跑一遍 kind 分派 + 文本拆分 + prepare 命中查询。
 * 块级缓存按 块 id + 内容签名 记忆高度：签名未变（消息未动）→ O(1) 命中，
 * 流式只让最后一条消息的块（签名变化）真测一次，其余块零分派开销。 */

export interface BlockMeasureCache {
  byId: Map<string, { sig: string; h: number }>;
}

export function createBlockMeasureCache(): BlockMeasureCache {
  return { byId: new Map() };
}

/** 内容签名（决定块高的全部 payload 字段 + 折叠态——签名变 = 高度必须重测）。 */
function measureSignature(b: SourcedBlock, folded: boolean): string {
  const p = b.payload as Record<string, unknown>;
  const f = folded ? 1 : 0;
  switch (b.kind) {
    case 'user':
      return `user|${p.text ?? ''}|${(p.files as Array<{ path: string; name: string }> | undefined)?.length ?? 0}`;
    case 'markdown':
      return `markdown|${p.text ?? ''}`;
    case 'reasoning':
      return `reasoning|${f}|${p.text ?? ''}`;
    case 'notice':
      return `notice|${p.text ?? ''}`;
    case 'diff':
      return `diff|${p.lang ?? ''}|${p.text ?? ''}`;
    case 'tool':
      return `tool|${f}|${p.args ?? ''}|${p.output ?? ''}|${p.err ?? ''}`;
    case 'code':
      return `code|${f}|${p.code ?? ''}|${p.output ?? ''}|${p.err ?? ''}`;
    case 'plan':
      return `plan|${p.content ?? ''}|${(p.options as unknown[] | undefined)?.length ?? 0}|${p._callback ? 1 : 0}`;
    default:
      // 资产/开放 kind：占位高度固定，签名只记 kind（WO-6 精确测量时再纳入 payload）。
      return `open|${b.kind}`;
  }
}

/** 块高缓存测量：签名命中直接返回记忆高度，否则真测并登记。
 *  folded（折叠机制）：折叠/展开是高度信号——入签名，切换必重测。 */
export function measureBlockHeightCached(b: SourcedBlock, cache: BlockMeasureCache, folded = false): number {
  const sig = measureSignature(b, folded);
  const hit = cache.byId.get(b.id);
  if (hit && hit.sig === sig) return hit.h;
  const h = measureBlockHeight(b, folded);
  cache.byId.set(b.id, { sig, h });
  return h;
}

/* ── 缓存管理 ── */

/** 测试复位（生产不调用）。 */
export function clearPaperMeasureCache(): void {
  prepareCache.clear();
  clearPretextCache();
}
