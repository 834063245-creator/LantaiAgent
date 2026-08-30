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

import {
  clearCache as clearPretextCache,
  layout,
  measureNaturalWidth,
  type PreparedText,
  type PreparedTextWithSegments,
  prepare,
  prepareWithSegments,
} from '@chenglou/pretext';
import {
  measureRichInlineStats,
  type PreparedRichInline,
  prepareRichInline,
  type RichInlineItem,
} from '@chenglou/pretext/rich-inline';
import { parsePlanItems, type SourcedBlock } from './block-model';
import {
  type MdBlock,
  type MdInline,
  type MdParseState,
  mdHasRichInline,
  mdPlainText,
  parseMarkdown,
  parseMarkdownIncremental,
} from './markdown';
import { parseCircledSegments } from './marks';
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

/** 正文字号（PAPER_BODY_FONT 同源拆出——rich 字体合成用）。 */
const BODY_SIZE = 17;

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
const MD_TABLE_SIZE = 11.5;
const MD_TABLE_LINE_HEIGHT = 11.5 * 1.5;

/* ── 富行内精确测量（P3 2026-08-30：@chenglou/pretext/rich-inline）──
 * 有富标志（粗/斜/删/行内码/链接）的行内序列走逐片段字体精确测量——旧
 * 「纯文本 ×0.96 偏窄」补偿系数（MD_RICH_BIAS）退役；纯文本序列保持
 * prepare+layout 旧路（pre-wrap 语义与渲染一致，零回归）。
 * 镜像常量（PaperPanel.css，改版式两处同步）：
 *   .pp-md strong → font-weight 600；em → italic（浏览器缺省，CSS 无覆盖）
 *   .pp-md del / .pp-md-a → 仅着色/下划线，无宽度影响
 *   .pp-md-ci → mono 0.82em + 横向 padding 5×2 + border 1×2
 *   .pp-circled → 600 + 横向 padding 4×2 + border 1.5×2 = 11（椭圆原子件） */
const MD_CI_SIZE_RATIO = 0.82;
const MD_CI_EXTRA = 12;
/** 圈点椭圆横向 chrome（.pp-circled：padding 4×2 + border 1.5×2）。 */
export const CIRCLE_EXTRA = 11;
/** 圈点字体：来文楷体 16px 加 600（.pp-circled font-weight 镜像）。 */
const CIRCLE_FONT = `600 16px ${KAI_STACK}`;

const RICH_CACHE_MAX = 500;
const richCache = new Map<string, PreparedRichInline>();

function richCacheKey(items: RichInlineItem[]): string {
  return items
    .map((it) => `${it.font}\u0002${it.extraWidth ?? ''}\u0002${it.break ?? ''}\u0002${it.text}`)
    .join('\u0003');
}

function getRichPrepared(items: RichInlineItem[]): PreparedRichInline {
  const key = richCacheKey(items);
  let p = richCache.get(key);
  if (p === undefined) {
    p = prepareRichInline(items);
    richCache.set(key, p);
    if (richCache.size > RICH_CACHE_MAX) {
      const first = richCache.keys().next().value;
      if (first !== undefined) richCache.delete(first);
    }
  }
  return p;
}

/** 富行内序列高度：lineCount × lineHeight（与 layout() 行盒语义一致）。
 *  空序列/全空文本返回 0。 */
function measureRichItemsHeight(items: RichInlineItem[], maxWidth: number, lineHeight: number): number {
  if (items.length === 0 || items.every((it) => it.text.length === 0)) return 0;
  const prepared = getRichPrepared(items);
  return measureRichInlineStats(prepared, maxWidth).lineCount * lineHeight;
}

/** md 行内序列 → rich items（标志位 → 字体映射，镜像规则见上节注释）。 */
function mdRichItems(inl: MdInline[], size: number, stack: string): RichInlineItem[] {
  return inl.map((seg) => {
    const weight = seg.b ? '600 ' : '';
    const style = seg.i ? 'italic ' : '';
    if (seg.c) {
      return {
        text: seg.text,
        font: `${weight}${style}${size * MD_CI_SIZE_RATIO}px ${MONO_STACK}`,
        extraWidth: MD_CI_EXTRA,
      };
    }
    return { text: seg.text, font: `${weight}${style}${size}px ${stack}` };
  });
}

function measureInlineHeight(inl: MdInline[], width: number, size: number, stack: string, lineHeight: number): number {
  const text = mdPlainText(inl);
  if (!text) return 0;
  if (mdHasRichInline(inl)) {
    // P3：富行内逐片段精确——width 原样（不打折）
    return measureRichItemsHeight(mdRichItems(inl, size, stack), Math.max(80, width), lineHeight);
  }
  return measureTextHeight(text, width, `${size}px ${stack}`, lineHeight);
}

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

/* ── 卷首（folio-head，2026-08-30 原型转录）──
 * 结构常量逐字镜像 PaperPanel.css .pp-folio-head 族
 * （源规格：prototype/lantai.html .folio-head / .yuwei / .folio-eyebrow / .folio-title / .folio-sub）。
 * 标题随换行实测（measureTextHeight），其余为固定结构高度。 */
export const FOLIO_TITLE_FONT = `600 32px ${SONG_STACK}`;
export const FOLIO_TITLE_LINE_HEIGHT = 32 * 1.2; // .pp-folio-title line-height 1.2
export const FOLIO_EYEBROW_H = 14; // mono 10px × line-height 1.4
export const FOLIO_SUB_H = 14; // mono 10px × line-height 1.4
export const FOLIO_PAD_TOP = 24; // .pp-folio-head padding-top
export const FOLIO_PAD_BOTTOM = 24; // padding-bottom 22 + rule-hard 2
export const FOLIO_YUWEI_H = 36; // 24px 玉徽 + margin-bottom 12
export const FOLIO_TITLE_MARGIN_TOP = 12;
export const FOLIO_SUB_MARGIN_TOP = 14;
/** 卷头与首块的呼吸距（原型 .folio-head margin-bottom 28） */
export const FOLIO_HEAD_GAP = 28;
/** 卷首头整体高度（世界单位）：标题按可用宽实测行数，其余固定。 */
export function measureFolioHeadHeight(title: string, availWidth: number): number {
  const titleH = measureTextHeight(title, availWidth, FOLIO_TITLE_FONT, FOLIO_TITLE_LINE_HEIGHT);
  return (
    FOLIO_PAD_TOP +
    FOLIO_YUWEI_H +
    FOLIO_EYEBROW_H +
    FOLIO_TITLE_MARGIN_TOP +
    titleH +
    FOLIO_SUB_MARGIN_TOP +
    FOLIO_SUB_H +
    FOLIO_PAD_BOTTOM +
    FOLIO_HEAD_GAP
  );
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

/** 来文测高（P3 2026-08-30）：含圈点候选（【】）的文本按行拆解（pre-wrap 硬
 *  换行语义），逐行走 rich 精确——圈点段 = 原子件 + CIRCLE_EXTRA 横向 chrome，
 *  其余段 = 来文楷体；空行仍占一行。纯文本（无【】）保持旧路整体 layout。 */
function measureUserTextHeight(text: string, maxWidth: number): number {
  if (!text.includes('【')) {
    return measureTextHeight(text, maxWidth, PAPER_USER_FONT, PAPER_USER_LINE_HEIGHT);
  }
  let h = 0;
  for (const line of text.split('\n')) {
    if (line === '') {
      h += PAPER_USER_LINE_HEIGHT;
      continue;
    }
    const items: RichInlineItem[] = parseCircledSegments(line).map((seg) =>
      seg.circled
        ? { text: seg.text, font: CIRCLE_FONT, break: 'never' as const, extraWidth: CIRCLE_EXTRA }
        : { text: seg.text, font: PAPER_USER_FONT },
    );
    h += measureRichItemsHeight(items, maxWidth, PAPER_USER_LINE_HEIGHT);
  }
  return h;
}

/* ── 来文收缩宽（P2a 变宽纸条 2026-08-30）──
 * 用户来文按内容取宽（手迹纸条隐喻）：内容自然宽 = 最长行宽 + 左内缩。
 * 有【】走逐行 rich 的 maxLineWidth（精确）；纯文本走 prepareWithSegments +
 * measureNaturalWidth（最宽强制行——pre-wrap 硬换行）；附件行（mono）同法参与。
 * 任一内容在预算宽下折行（rich lineCount>1 / natural 超预算）→ 不收缩（全宽）。
 * prepare 与宽度无关：宽度变化只重 layout（prepare 缓存全命中）——resize 零重排。 */
export const USER_SHRINK_MIN_W = 320;

const SEG_CACHE_MAX = 300;
const segCache = new Map<string, PreparedTextWithSegments>();

function getPreparedWithSegments(text: string, font: string): PreparedTextWithSegments {
  const key = `${font}::${text}`;
  let p = segCache.get(key);
  if (p === undefined) {
    p = prepareWithSegments(text, font, { whiteSpace: 'pre-wrap' });
    segCache.set(key, p);
    if (segCache.size > SEG_CACHE_MAX) {
      const first = segCache.keys().next().value;
      if (first !== undefined) segCache.delete(first);
    }
  }
  return p;
}

/** 来文内容自然宽（世界单位）；null = 内容超预算宽（收缩无意义，保持全宽）。 */
function userNaturalWidth(
  text: string | undefined,
  files: Array<{ name: string }> | undefined,
  maxContentW: number,
): number | null {
  let natural = 0;
  if (text) {
    if (text.includes('【')) {
      for (const line of text.split('\n')) {
        if (line === '') continue;
        const items: RichInlineItem[] = parseCircledSegments(line).map((seg) =>
          seg.circled
            ? { text: seg.text, font: CIRCLE_FONT, break: 'never' as const, extraWidth: CIRCLE_EXTRA }
            : { text: seg.text, font: PAPER_USER_FONT },
        );
        if (items.every((it) => it.text.length === 0)) continue;
        const stats = measureRichInlineStats(getRichPrepared(items), maxContentW);
        if (stats.lineCount > 1) return null;
        natural = Math.max(natural, stats.maxLineWidth);
      }
    } else {
      const w = measureNaturalWidth(getPreparedWithSegments(text, PAPER_USER_FONT));
      if (w > maxContentW) return null;
      natural = Math.max(natural, w);
    }
  }
  for (const f of files ?? []) {
    // 附件行渲染 = 「附 · 」前缀 + 文件名（mono 11px）
    const w = measureNaturalWidth(getPreparedWithSegments(`附 · ${f.name}`, PAPER_OUT_FONT));
    if (w > maxContentW) return null;
    natural = Math.max(natural, w);
  }
  return natural > 0 ? natural : null;
}

/** 来文收缩宽（P2a）：内容自然宽 + 左内缩，clamp [USER_SHRINK_MIN_W, 全宽]；
 *  超宽/触顶返回 null（调用方保持原宽不动）。 */
export function shrinkWrapUserWidth(
  payload: { text?: string; files?: Array<{ name: string }> },
  blockWidth: number,
): number | null {
  const maxContentW = blockWidth - USER_TEXT_INSET;
  const natural = userNaturalWidth(payload.text, payload.files, maxContentW);
  if (natural === null) return null;
  const w = Math.ceil(natural) + USER_TEXT_INSET;
  if (w >= blockWidth) return null;
  return Math.max(USER_SHRINK_MIN_W, w);
}

/* ── 缩远墨迹（P4 LOD）──
 * InkLayer 在远缩档用 canvas 画「真墨」行条骨架（每行真实行宽），替代整棵
 * DOM 块树——远看是真卷轴全景，近看回 DOM 正文。inkSourcesFor 是墨迹的文类
 * 分派单一真源（与 measureBlockHeight 消费同一份 payload 语义与镜像常量）：
 * 产出每类块的「文本源」清单，行条几何由 paper/ink 的 walkLineRanges 消费。
 * 改块内容语义/版式常量时两处同改。 */

/** 单个文本源 → 墨条几何输入。cap = 行条数上限（镜像测量端的封顶高度）。 */
export interface InkSource {
  text: string;
  font: string;
  lineHeight: number;
  /** 横向内缩（世界单位——墨条起点 = 块左缘 + inset） */
  inset: number;
  /** 行条上限（pre/output 族按 PRE_MAX_H/OUT 族镜像，缺省不封顶） */
  cap?: number;
}

/** 纸条墨迹常量（.pp-strip 镜像：12.5px 宋体 / 1.7 行距 / padding 12）。 */
export const STRIP_INK = { font: `12.5px ${SONG_STACK}`, lineHeight: 12.5 * 1.7, inset: 12 };

/* ── 眉批栏（P5 夹注旁注化）——.pp-marginalia 镜像：块右缘 24px 起、总宽 240，
 * 左规线 2 + padding 10 → 内容宽 228；字体沿用夹注族（13.5px/1.85 石墨）。 ── */
export const MARGINALIA_W = 240;
export const MARGINALIA_INSET = 12;

export function inkSourcesFor(b: SourcedBlock, folded: boolean): InkSource[] {
  const p = b.payload as PayloadLike;
  switch (b.kind) {
    case 'user':
      // 圈点行宽差 ≤ 椭圆 chrome 量级——远缩墨条按纯文本即可（LOD 抽象层）
      return p.text && !folded
        ? [{ text: p.text, font: PAPER_USER_FONT, lineHeight: PAPER_USER_LINE_HEIGHT, inset: USER_TEXT_INSET }]
        : [];
    case 'markdown':
      return p.text ? markdownInkSources(p.text) : [];
    case 'reasoning':
      return p.text && !folded
        ? [
            {
              text: p.text,
              font: PAPER_REASONING_FONT,
              lineHeight: PAPER_REASONING_LINE_HEIGHT,
              inset: REASONING_TEXT_INSET,
            },
          ]
        : [];
    case 'notice':
      return p.text
        ? [{ text: p.text, font: PAPER_NOTICE_FONT, lineHeight: PAPER_NOTICE_LINE_HEIGHT, inset: NOTICE_TEXT_INSET }]
        : [];
    case 'diff':
      return p.text
        ? [
            {
              text: p.text,
              font: PAPER_MONO_FONT,
              lineHeight: PAPER_MONO_LINE_HEIGHT,
              inset: DIFF_TEXT_INSET,
              cap: Math.floor(PRE_MAX_H / PAPER_MONO_LINE_HEIGHT),
            },
          ]
        : [];
    case 'tool': {
      if (folded) return [];
      const out: InkSource[] = [];
      if (p.args)
        out.push({
          text: prettyToolArgs(p.args),
          font: PAPER_TOOL_FONT,
          lineHeight: PAPER_TOOL_LINE_HEIGHT,
          inset: 0,
          cap: Math.floor(PRE_MAX_H / PAPER_TOOL_LINE_HEIGHT),
        });
      if (p.output)
        out.push({
          text: p.output,
          font: PAPER_OUT_FONT,
          lineHeight: PAPER_OUT_LINE_HEIGHT,
          inset: 0,
          cap: Math.floor(OUT_MAX_H / PAPER_OUT_LINE_HEIGHT),
        });
      if (p.err)
        out.push({
          text: p.err,
          font: PAPER_OUT_FONT,
          lineHeight: PAPER_OUT_LINE_HEIGHT,
          inset: 0,
          cap: Math.floor(OUT_MAX_H / PAPER_OUT_LINE_HEIGHT),
        });
      return out;
    }
    case 'code': {
      if (folded) return [];
      const out: InkSource[] = [];
      const src = (b.payload as { code?: string }).code ?? p.args ?? '';
      if (src)
        out.push({
          text: src,
          font: PAPER_TOOL_FONT,
          lineHeight: PAPER_TOOL_LINE_HEIGHT,
          inset: CODE_SRC_INSET,
          cap: Math.floor((CODE_SRC_MAX_H - CODE_SRC_PAD_V) / PAPER_TOOL_LINE_HEIGHT),
        });
      if (p.output)
        out.push({
          text: p.output,
          font: PAPER_OUT_FONT,
          lineHeight: PAPER_OUT_LINE_HEIGHT,
          inset: 0,
          cap: Math.floor(CODE_OUT_TEXT_MAX / PAPER_OUT_LINE_HEIGHT),
        });
      if (p.err)
        out.push({
          text: p.err,
          font: PAPER_OUT_FONT,
          lineHeight: PAPER_OUT_LINE_HEIGHT,
          inset: 0,
          cap: Math.floor(CODE_OUT_TEXT_MAX / PAPER_OUT_LINE_HEIGHT),
        });
      return out;
    }
    case 'plan': {
      const items = parsePlanItems(p.content ?? '');
      return items.length === 0
        ? []
        : [
            {
              text: items.join('\n'),
              font: PAPER_PLAN_ITEM_FONT,
              lineHeight: PAPER_PLAN_ITEM_LINE_HEIGHT,
              inset: PLAN_ITEM_INSET,
            },
          ];
    }
    default:
      return []; // 资产/开放 kind：远缩画外框即可（无行条）
  }
}

/** markdown 元素 → 墨迹源（parseMarkdown 同源走查：p/h/列表项走正文族字号，
 *  围栏码走 mono 封顶，引用递归，hr 跳过，表格按行退化）。 */
function markdownInkSources(text: string): InkSource[] {
  const out: InkSource[] = [];
  const push = (t: string, size: number, lh: number): void => {
    if (t) out.push({ text: t, font: `${size}px ${SONG_STACK}`, lineHeight: lh, inset: 0 });
  };
  const walk = (blocks: MdBlock[]): void => {
    for (const el of blocks) {
      switch (el.t) {
        case 'p':
          push(mdPlainText(el.inl), BODY_SIZE, PAPER_BODY_LINE_HEIGHT);
          break;
        case 'h': {
          const c = MD_H[el.lv - 1];
          push(mdPlainText(el.inl), c.size, c.size * c.lh);
          break;
        }
        case 'list':
          for (const it of el.items) {
            push(mdPlainText(it.inl), BODY_SIZE, PAPER_BODY_LINE_HEIGHT);
            if (it.sub) walk(it.sub);
          }
          break;
        case 'quote':
          walk(el.blocks);
          break;
        case 'code':
          if (el.text)
            out.push({
              text: el.text,
              font: PAPER_MONO_FONT,
              lineHeight: PAPER_MONO_LINE_HEIGHT,
              inset: MD_CODE_INSET,
              cap: Math.floor(PRE_MAX_H / PAPER_MONO_LINE_HEIGHT),
            });
          break;
        case 'table':
          for (const row of [el.head, ...el.rows])
            push(row.map((c) => mdPlainText(c)).join(' '), MD_TABLE_SIZE, MD_TABLE_LINE_HEIGHT);
          break;
        case 'hr':
          break;
      }
    }
  };
  walk(parseMarkdown(text));
  return out;
}

/* ── markdown 块测量（渲染 MarkdownBody 的逐字镜像——消费同一 parseMarkdown 模型）── */

function tableRowH(cells: MdInline[][], w: number): number {
  const cols = Math.max(1, ...cells.map((c) => c.length));
  const colW = Math.max(40, w / cols - MD_TABLE_CELL_PAD);
  let linesH = 0;
  for (const cell of cells)
    linesH = Math.max(linesH, measureInlineHeight(cell, colW, MD_TABLE_SIZE, MONO_STACK, MD_TABLE_LINE_HEIGHT));
  return linesH + MD_TABLE_CELL_PAD_V + MD_TABLE_ROW_BORDER;
}

/** 单个 markdown 元素高度（last = 序列末元素：margin-bottom 归零镜像）。 */
function measureMdElement(el: MdBlock, w: number, last: boolean): number {
  switch (el.t) {
    case 'p': {
      const h = measureInlineHeight(el.inl, w, BODY_SIZE, SONG_STACK, PAPER_BODY_LINE_HEIGHT);
      if (!el.inl.length || mdPlainText(el.inl).length === 0) return 0;
      return h + (last ? 0 : MD_P_GAP);
    }
    case 'h': {
      const c = MD_H[el.lv - 1];
      return c.pt + measureInlineHeight(el.inl, w, c.size, SONG_STACK, c.size * c.lh) + c.pb;
    }
    case 'list': {
      let items = 0;
      for (const it of el.items) {
        let ih = measureInlineHeight(it.inl, w - MD_LI_INDENT, BODY_SIZE, SONG_STACK, PAPER_BODY_LINE_HEIGHT);
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

/** markdown 块体高（渲染 MarkdownBody 的逐字镜像——消费同一结构模型）。
 *  blocks 由调用方解析（全量 parseMarkdown 或增量 parseMarkdownIncremental）
 *  ——增量路径复用同函数，测量与渲染共用单一解析的纪律不变。 */
function measureMarkdownBody(blocks: MdBlock[], b: SourcedBlock, sidecarFolded = false): number {
  const bodyH = measureMdBlocks(blocks, b.w);
  // P5 眉批化：夹注挂侧栏（.pp-marginalia）——复合块高 = max(正文@全宽,
  // 夹注@侧栏内容宽)。眉批恒容于块高内 → 栈几何零变化（方案甲的决定性
  // 优势，见 pretext-typography-plan §三）。折叠态（夹注恒折拍板）只占一行。
  const sidecar = (b.payload as { sidecar?: { text: string } }).sidecar;
  if (!sidecar?.text) return bodyH;
  const noteH = sidecarFolded
    ? PAPER_REASONING_LINE_HEIGHT
    : measureTextHeight(
        sidecar.text,
        MARGINALIA_W - MARGINALIA_INSET,
        PAPER_REASONING_FONT,
        PAPER_REASONING_LINE_HEIGHT,
      );
  return Math.max(bodyH, noteH);
}

/**
 * 块高真测量（世界单位）：按 kind 分派，注疏版式七类各自计高。
 * 纯函数 + 缓存——同 key 重复调用零成本。
 * folded（2026-08-30 折叠机制）：夹注/脚注/程文的折叠态计高——直接调用缺省
 * 展开（false）；壳层经 measureBlockHeightCached 传有效折叠态（覆盖 ?? 默认规则）。
 */
export function measureBlockHeight(b: SourcedBlock, folded = false, sidecarFolded = false): number {
  const p = b.payload as PayloadLike;
  switch (b.kind) {
    case 'user': {
      // 圈点（C7 + P3）：含【】候选走逐行 rich 精确（圈点 = 原子件 + 椭圆横向
      // chrome，括号被渲染消费不再保守覆盖）；纯文本保持 pre-wrap 整体 layout。
      const textH = p.text ? measureUserTextHeight(p.text, b.w - USER_TEXT_INSET) : 0;
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
      return measureMarkdownBody(parseMarkdown(p.text), b, sidecarFolded);
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
  /** markdown 块增量解析状态（按块 id）——流式文本增长时复用稳定前缀解析，
   *  避免每个 token 对整段文本重新 parseMarkdown（measure 与渲染共用增量入口）。 */
  mdParse: Map<string, MdParseState>;
}

export function createBlockMeasureCache(): BlockMeasureCache {
  return { byId: new Map(), mdParse: new Map() };
}

/** 内容签名（决定块高的全部 payload 字段 + 折叠态——签名变 = 高度必须重测）。
 *  P4：ink 层复用同一签名做墨迹缓存 key（块 id + 签名 + 宽）。 */
export function measureSignature(b: SourcedBlock, folded: boolean, sidecarFolded = false): string {
  const p = b.payload as Record<string, unknown>;
  const f = folded ? 1 : 0;
  const sf = sidecarFolded ? 1 : 0;
  switch (b.kind) {
    case 'user':
      return `user|${p.text ?? ''}|${(p.files as Array<{ path: string; name: string }> | undefined)?.length ?? 0}`;
    case 'markdown':
      return `markdown|${p.text ?? ''}|${(p.sidecar as { text?: string } | undefined)?.text ?? ''}|${sf}`;
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
 *  folded（折叠机制）：折叠/展开是高度信号——入签名，切换必重测。
 *  w（P2 变宽）：宽度也是高度信号（收缩/resize 改宽必改高）——签名尾缀。
 *  markdown 块走增量解析：流式文本增长时复用稳定前缀块，只重解析最后一个块
 *  （与渲染端 parseMarkdownIncremental 同源，测量与渲染结构一致性不破）。 */
export function measureBlockHeightCached(
  b: SourcedBlock,
  cache: BlockMeasureCache,
  folded = false,
  sidecarFolded = false,
): number {
  const sig = `${measureSignature(b, folded, sidecarFolded)}|w=${b.w}`;
  const hit = cache.byId.get(b.id);
  if (hit && hit.sig === sig) return hit.h;
  let h: number;
  if (b.kind === 'markdown') {
    const p = b.payload as { text?: string };
    const text = p.text ?? '';
    if (!text) {
      h = 0;
    } else {
      const prev = cache.mdParse.get(b.id) ?? null;
      const res = parseMarkdownIncremental(text, prev);
      cache.mdParse.set(b.id, res.state);
      h = measureMarkdownBody(res.blocks, b, sidecarFolded);
    }
  } else {
    h = measureBlockHeight(b, folded, sidecarFolded);
  }
  cache.byId.set(b.id, { sig, h });
  return h;
}

/* ── 缓存管理 ── */

/** 测试复位（生产不调用）。 */
export function clearPaperMeasureCache(): void {
  prepareCache.clear();
  richCache.clear();
  segCache.clear();
  clearPretextCache();
}
