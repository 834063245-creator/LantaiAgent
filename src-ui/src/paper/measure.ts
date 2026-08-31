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
import {
  measureRichInlineStats,
  type PreparedRichInline,
  prepareRichInline,
  type RichInlineItem,
} from '@chenglou/pretext/rich-inline';
import { assetKinds } from '../agent/asset-kinds';
import { type BlockKind, parsePlanItems, type SourcedBlock } from './block-model';
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

/* ── 纸面字体常量（2026-08-30 token 化：单一真源 = type-tokens.ts）──
 * 兰台四体分工（docs/design/lantai-design-spec.md §2）：宋体正文 / 楷书来文 /
 * 等宽机读；英文思考链走宋体/Garamond，楷书只给人的来文。
 * 栈全具名——pretext 对 system-ui 在 macOS 不建模（PLATFORM_BUGS.md），
 * 且 canvas 测量字体必须与渲染字体一致（FONT_STACKS 与 tokens.css --f-* 同源）。 */

import {
  ASSET_DERIVED,
  CHROME_DERIVED,
  CHROME_TOKENS,
  FOLIO_TOKENS,
  FONT_STACKS,
  LIMIT_TOKENS,
  MD_DERIVED,
  MD_TOKENS,
  PAPER_TYPE,
} from './type-tokens';

const SONG_STACK = FONT_STACKS.song;
const KAI_STACK = FONT_STACKS.kai;
const MONO_STACK = FONT_STACKS.mono;

/** 来文（user）：楷书 16px/1.9 朱砂深（.pp-block.pp-user .pp-body）
 *  B4 环1 拍板 C：字号 18→16 收到正文 17 之下，行高同 C 变体 1.9 */
export const PAPER_USER_FONT = `${PAPER_TYPE.user.size}px ${FONT_STACKS[PAPER_TYPE.user.stack]}`;
export const PAPER_USER_LINE_HEIGHT = PAPER_TYPE.user.size * PAPER_TYPE.user.lh;

/** 正文（markdown）：宋体 17px/2.0（.pp-block.pp-markdown .pp-body） */
export const PAPER_BODY_FONT = `${PAPER_TYPE.body.size}px ${FONT_STACKS[PAPER_TYPE.body.stack]}`;
export const PAPER_BODY_LINE_HEIGHT = PAPER_TYPE.body.size * PAPER_TYPE.body.lh;

/** 夹注（reasoning）：13.5px/1.85 石墨（.pp-block.pp-reasoning .pp-body） */
export const PAPER_REASONING_FONT = `${PAPER_TYPE.reasoning.size}px ${FONT_STACKS[PAPER_TYPE.reasoning.stack]}`;
export const PAPER_REASONING_LINE_HEIGHT = PAPER_TYPE.reasoning.size * PAPER_TYPE.reasoning.lh;

/** 贴黄（notice）：12.5px/1.7（.pp-block.pp-notice .pp-body） */
export const PAPER_NOTICE_FONT = `${PAPER_TYPE.notice.size}px ${FONT_STACKS[PAPER_TYPE.notice.stack]}`;
export const PAPER_NOTICE_LINE_HEIGHT = PAPER_TYPE.notice.size * PAPER_TYPE.notice.lh;

/** 抄录（diff）图版：等宽 12.5px/1.7（.pp-block.pp-diff pre） */
export const PAPER_MONO_FONT = `${PAPER_TYPE.mono.size}px ${FONT_STACKS[PAPER_TYPE.mono.stack]}`;
export const PAPER_MONO_LINE_HEIGHT = PAPER_TYPE.mono.size * PAPER_TYPE.mono.lh;

/** 脚注（tool）args：等宽 11.5px/1.6 石青（.pp-block.pp-tool pre） */
export const PAPER_TOOL_FONT = `${PAPER_TYPE.tool.size}px ${FONT_STACKS[PAPER_TYPE.tool.stack]}`;
export const PAPER_TOOL_LINE_HEIGHT = PAPER_TYPE.tool.size * PAPER_TYPE.tool.lh;

/** 脚注输出/错误（.pp-out）：等宽 11px/1.5 */
export const PAPER_OUT_FONT = `${PAPER_TYPE.out.size}px ${FONT_STACKS[PAPER_TYPE.out.stack]}`;
export const PAPER_OUT_LINE_HEIGHT = PAPER_TYPE.out.size * PAPER_TYPE.out.lh;

/** 拟策条目：13.5px/1.8（.pp-pc li） */
export const PAPER_PLAN_ITEM_FONT = `${PAPER_TYPE.planItem.size}px ${FONT_STACKS[PAPER_TYPE.planItem.stack]}`;
export const PAPER_PLAN_ITEM_LINE_HEIGHT = PAPER_TYPE.planItem.size * PAPER_TYPE.planItem.lh;

/** 正文段距（2026-08-30 markdown 专项改版：17px/行距 2.0 下 10px 段距比行距
 *  还小、段落黏连——提到 14px；.pp-md-p margin-bottom 镜像）。 */
export const MD_P_GAP = MD_TOKENS.pGap;

/** 正文字号（PAPER_BODY_FONT 同源拆出——rich 字体合成用）。 */
const BODY_SIZE = PAPER_TYPE.body.size;

/* ── markdown 子版式常量（2026-08-30 token 化：单一真源 = type-tokens.ts）──
 * 结构：块元素只用「padding 上下面距 + margin-bottom 块间距」两种纵向量，
 * 测高 = Σ(元素高) + Σ(非末元素 margin-bottom)（CSS :last-child margin 归零镜像）；
 * 不用 margin-top（首元素 margin 会逃逸出 .pp-body 破坏测高）。 */
/** 标题四级：字号 / 行高系数 / padding 上下（.pp-md-h1..h4） */
const MD_H = MD_TOKENS.h;
const MD_LIST_GAP = MD_TOKENS.listGap; // .pp-md-list margin-bottom
const MD_LI_GAP = MD_TOKENS.liGap; // .pp-md-li margin-bottom（末项 :last-child 归零）
const MD_LI_INDENT = MD_TOKENS.liIndent; // .pp-md-li padding-left（标记列）
const MD_SUB_INDENT = MD_TOKENS.subIndent; // .pp-md-list--sub padding-left
const MD_SUB_TOP = MD_TOKENS.subTop; // .pp-md-list--sub margin-top
const MD_QUOTE_GAP = MD_TOKENS.quoteGap; // .pp-md-quote margin-bottom
const MD_QUOTE_PAD_V = MD_DERIVED.quotePadV; // .pp-md-quote padding 上下（单侧×2）
const MD_QUOTE_INSET = MD_DERIVED.quoteInset; // padding-left 16 + border-left 2
const MD_CODE_GAP = MD_TOKENS.codeGap; // .pp-md-code margin-bottom
const MD_CODE_PAD_V = MD_DERIVED.codePadV; // .pp-md-code padding 上下（单侧×2）
const MD_CODE_INSET = MD_DERIVED.codeInset; // border-left 3 + padding 左右 12×2
const MD_HR_H = MD_DERIVED.hrH; // margin 18 + 线 1 + margin 18
const MD_HR_LAST_H = MD_DERIVED.hrLastH; // 末元素 margin-bottom 归零
const MD_TABLE_GAP = MD_TOKENS.tableGap; // .pp-md-table margin-bottom
const MD_TABLE_CELL_PAD = MD_TOKENS.tableCellPadH; // th/td 左右 padding 8×2
const MD_TABLE_CELL_PAD_V = MD_DERIVED.tableCellPadV; // th/td 上下 padding 4×2
const MD_TABLE_ROW_BORDER = MD_TOKENS.tableRowBorder; // th 行底规线
/** 表格单元字体：等宽 11.5px/1.5（.pp-md-table） */
const MD_TABLE_SIZE = MD_TOKENS.tableSize;
const MD_TABLE_LINE_HEIGHT = MD_TOKENS.tableSize * MD_TOKENS.tableLh;

/* ── 富行内精确测量（P3 2026-08-30：@chenglou/pretext/rich-inline）──
 * 有富标志（粗/斜/删/行内码/链接）的行内序列走逐片段字体精确测量——旧
 * 「纯文本 ×0.96 偏窄」补偿系数（MD_RICH_BIAS）退役；纯文本序列保持
 * prepare+layout 旧路（pre-wrap 语义与渲染一致，零回归）。
 * 镜像常量（PaperPanel.css，改版式两处同步）：
 *   .pp-md strong → font-weight 600；em → italic（浏览器缺省，CSS 无覆盖）
 *   .pp-md del / .pp-md-a → 仅着色/下划线，无宽度影响
 *   .pp-md-ci → mono 0.82em + 横向 padding 5×2 + border 1×2
 *   .pp-circled → 600 + 横向 padding 4×2 + border 1.5×2 = 11（椭圆原子件） */
const MD_CI_SIZE_RATIO = MD_TOKENS.ciSizeRatio;
const MD_CI_EXTRA = MD_DERIVED.ciExtra;
/** 圈点椭圆横向 chrome（.pp-circled：padding 4×2 + border 1.5×2）。 */
export const CIRCLE_EXTRA = 11;
/** 圈点字体：来文楷体 16px 加 600（.pp-circled font-weight 镜像）。 */
const CIRCLE_FONT = `600 ${PAPER_TYPE.user.size}px ${KAI_STACK}`;

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
export const FOLD_ROW_H = LIMIT_TOKENS.foldRowH;

/** 渲染端滚动上限（PaperPanel.css pre/输出 max-height——超限部分滚动不占高） */
export const PRE_MAX_H = LIMIT_TOKENS.preMaxH;
export const OUT_MAX_H = LIMIT_TOKENS.outMaxH;

/* ── 程文（code）专属镜像常量——.pp-code-src / .pp-code .pp-out 与脚注族不同款 ──
 * 2026-08-30 溢出修复：旧测量按整宽 + PRE_MAX_H 260 + 零内距，而 CSS 实况是
 * 17px 横向内缩 + 20px 纵向内距 + max-height 320 → 展开后 DOM 恒高于测高，
 * 下一块压字（用户报「程文展开后文字溢出」的根因）。 */
/** .pp-code-src 横向内缩 = border-left 3 + padding-left 14。 */
export const CODE_SRC_INSET = CHROME_DERIVED.codeSrcInset;
/** .pp-code-src 纵向内距 = padding 10×2（box-sizing border-box，max-height 内扣）。 */
export const CODE_SRC_PAD_V = CHROME_DERIVED.codeSrcPadV;
/** .pp-code-src max-height（内容预算 = 320 - 20 内距）。 */
export const CODE_SRC_MAX_H = CHROME_DERIVED.codeSrcMaxH;
/** .pp-code .pp-out max-height 200（脚注族是 160）——文本内容预算 = 200 - padding-top 6 - border-top 1。 */
export const CODE_OUT_TEXT_MAX = CHROME_DERIVED.codeOutTextMax;

/* ── per-kind chrome 常量（2026-08-30 token 化：单一真源 = type-tokens.ts）── */
const USER_TEXT_INSET = CHROME_DERIVED.userTextInset; // 标题化后无左批线 = 0
/** 来文题签（2026-08-30 标题化）：题签占高 = 题签行 + 下距（镜像 .pp-user-kind 族）。 */
const USER_KIND_H = CHROME_DERIVED.userKindH;
/** asterism（B1）：来文尾三星高度 = margin-top 30 + 字行 14（line-height 1）。 */
const USER_ASTERISM_H = CHROME_DERIVED.userAsterismH;
/** 来文附件行（C10）：每行 mono 11px / 行高 16 + 上间距 8 + 弱规线 1。 */
const USER_FILE_LINE_H = CHROME_DERIVED.userFileLineH;
const USER_FILES_MARGIN_TOP = CHROME_DERIVED.userFilesMarginTop; // margin-top 8 + 规线 1
const REASONING_TEXT_INSET = CHROME_DERIVED.reasoningTextInset; // padding-left 18 + border-left 2（虚线）
const TOOL_PAD_TOP = CHROME_DERIVED.toolPadTop; // .pp-block.pp-tool padding-top
const OUT_CHROME_H = CHROME_DERIVED.outChromeH; // .pp-out margin-top 6 + padding-top 6 + border-top 1
const DIFF_LANG_H = CHROME_DERIVED.diffLangH; // .pp-lang 10px×lh1 + margin-bottom 6
const DIFF_PRE_CHROME_H = CHROME_DERIVED.diffPreChromeH; // pre padding 14×2 + border 1×2
const DIFF_TEXT_INSET = CHROME_DERIVED.diffTextInset; // border-left 3 + padding-left 20
const PLAN_CHROME_H = CHROME_DERIVED.planChromeH; // .pp-pc border-top 2 + border-bottom 1 + padding 14×2
const PLAN_ITEM_INSET = CHROME_DERIVED.planItemInset; // li padding-left（石青序号列）
const PLAN_ITEM_GAP = CHROME_DERIVED.planItemGap; // li margin-bottom（末项无）
const PLAN_ACTIONS_H = CHROME_DERIVED.planActionsH; // 按钮行
const NOTICE_CHROME_H = CHROME_DERIVED.noticeChromeH; // padding 8×2 + border-bottom 1
const NOTICE_TEXT_INSET = CHROME_DERIVED.noticeTextInset; // padding 12×2

/* ── 资产/开放 kind 镜像常量（2026-08-30 溢出修复：default 固定 80 退役）──
 * 资产块此前测高恒 80、签名不含 payload——媒体图 320 / JSON 兜底 400+ /
 * html 卡 1000 的体格全被按成 80 → 绝对定位流里下一块压字（画图族等资产
 * 卡片溢出、会话流渲染乱成一团的根因）。此处按表现原语逐款镜像
 * asset-renderers.tsx 的结构（改表现组件两处同步）；加载/上报/交互类动态高
 * （图片、iframe、拟策反馈框）由壳层 ResizeObserver 实测回写桥兜底。
 * token 化：数值全归一在 type-tokens.ts ASSET_DERIVED，本区零公式。 */
const JSON_VIEW_PAD_V = ASSET_DERIVED.jsonViewPadV; // .pp-json padding 10 + 2
const JSON_VIEW_HEAD_H = ASSET_DERIVED.jsonViewHeadH; // .pp-json-head + margin 6
const JSON_PRE_PAD_V = ASSET_DERIVED.jsonPrePadV; // .pp-json-pre padding 10×2
const JSON_PRE_INSET = ASSET_DERIVED.jsonPreInset; // border-left 3 + padding 左右 12×2
const JSON_PRE_MAX_H = ASSET_DERIVED.jsonPreMaxH; // box-sizing border-box → 文本预算
const JSON_PRE_FONT = `${ASSET_DERIVED.jsonPreSize}px ${MONO_STACK}`;
const JSON_PRE_LINE_HEIGHT = ASSET_DERIVED.jsonPreSize * ASSET_DERIVED.jsonPreLh;

const MEDIA_PAD_V = ASSET_DERIVED.mediaPadV; // .pp-media padding 2×2
const MEDIA_LABEL_H = ASSET_DERIVED.mediaLabelH; // .pp-media-label + margin-bottom 4
const MEDIA_IMG_MAX_H = ASSET_DERIVED.mediaImgMaxH; // .pp-media-img max-height
const MEDIA_ROW_H = ASSET_DERIVED.mediaRowSize * 1.8; // .pp-media-file 行（行距继承 1.8）

const CHART_PAD_V = ASSET_DERIVED.chartPadV; // .pp-chart padding 4×2
const CHART_TYPE_H = ASSET_DERIVED.chartTypeH; // .pp-chart-type + margin-bottom 4
const CHART_SVG_MAX_H = ASSET_DERIVED.chartSvgMaxH; // .pp-chart-svg max-height
const CHART_PIE_H = ASSET_DERIVED.chartPieH; // .pp-chart-pie height
const CHART_LABEL_GAP = ASSET_DERIVED.chartLabelGap; // .pp-chart-labels margin-top
const CHART_LABEL_LINE = ASSET_DERIVED.chartLabelSize * 1.8;
const CHART_LABEL_FONT = `${ASSET_DERIVED.chartLabelSize}px ${MONO_STACK}`;

const METRIC_PAD_V = ASSET_DERIVED.metricPadV; // .pp-metric padding 2×2
const METRIC_CAPTION_H = ASSET_DERIVED.metricCaptionH; // .pp-metric-caption + margin-bottom 6
const METRIC_CARD_H = ASSET_DERIVED.metricCardH; // border + padding + label + value
const METRIC_GAP = ASSET_DERIVED.metricGap; // .pp-metric-grid gap
const METRIC_MIN_COL = ASSET_DERIVED.metricMinCol; // minmax(120px, 1fr)

const GRID_PAD_V = ASSET_DERIVED.gridPadV; // .pp-grid padding 2×2
const GRID_CAPTION_H = ASSET_DERIVED.gridCaptionH;
const GRID_CELL_PAD_V = ASSET_DERIVED.gridCellPadV; // th/td padding 4×2
const GRID_ROW_LINE = ASSET_DERIVED.gridRowLine; // .pp-grid-table 11px（行距继承 1.8）
const GRID_HEAD_BORDER = ASSET_DERIVED.gridHeadBorder; // th border-bottom
const GRID_ROW_BORDER = ASSET_DERIVED.gridRowBorder; // td border-bottom
const GRID_MEASURE_ROW_CAP = ASSET_DERIVED.gridMeasureRowCap; // 逐行文字测量上限
const GRID_FONT = `${ASSET_DERIVED.gridSize}px ${MONO_STACK}`;

const GRAPH_PAD_V = ASSET_DERIVED.graphPadV; // .pp-graph padding 4×2
const GRAPH_SVG_MAX_H = ASSET_DERIVED.graphSvgMaxH; // .pp-graph-svg max-height
const GRAPH_COL_W = ASSET_DERIVED.graphColW; // 深度列宽
const GRAPH_ROW_H = ASSET_DERIVED.graphRowH;
const GRAPH_ORIGIN = ASSET_DERIVED.graphOrigin;
const GRAPH_MIN_W = ASSET_DERIVED.graphMinW;
const GRAPH_MIN_H = ASSET_DERIVED.graphMinH;

const HTML_BODY_PAD_V = ASSET_DERIVED.htmlPadV; // .pp-html padding 2×2
const HTML_FRAME_DEFAULT_H = ASSET_DERIVED.htmlFrameDefaultH; // .pp-html-frame 初始高

const FORM_PAD_V = ASSET_DERIVED.formPadV; // .pp-form padding 2×2
const FORM_TITLE_H = ASSET_DERIVED.formTitleH; // .pp-form-title + margin-bottom 4
const FORM_BODY_LINE = ASSET_DERIVED.formBodyLine; // .pp-form-body line-height 1.7
const FORM_BODY_GAP = ASSET_DERIVED.formBodyGap; // margin-bottom 8
const FORM_OPT_PAD_V = ASSET_DERIVED.formOptPadV; // .pp-form-option padding 6×2
const FORM_OPT_BORDER = ASSET_DERIVED.formOptBorder;
const FORM_OPT_LABEL_H = ASSET_DERIVED.formOptLabelH;
const FORM_OPT_DESC_LINE = ASSET_DERIVED.formOptDescLine;
const FORM_OPT_DESC_INSET = ASSET_DERIVED.formOptDescInset; // padding 左右 10×2
const FORM_OPT_GAP = ASSET_DERIVED.formOptGap; // .pp-form-options row-gap
const FORM_SECTION_GAP = ASSET_DERIVED.formSectionGap; // body/options margin-bottom
const FORM_ACTIONS_H = ASSET_DERIVED.formActionsH; // .pp-form-confirm 行
const FORM_BODY_FONT = `${ASSET_DERIVED.formBodySize}px ${SONG_STACK}`;
const FORM_DESC_FONT = `${ASSET_DERIVED.formDescSize}px ${SONG_STACK}`;

/* ── 拟策测高镜像（2026-08-30 溢出修复：PLAN_OPTIONS_H 118 / PLAN_HEAD_H 39 退役）──
 * 旧固定预算装不下两枚带描述的方案（实况 ≈163）+ 操作行按钮实高 49.4（旧 40）
 * + 标题换行未计 → 交互拟策块恒比测高高 50~120px，下一块压字。选项描述文本
 * 实测；反馈框展开属动态高（壳层 RO 实测兜底，needsObservedHeight 含 plan）。
 * token 化：数值全归一在 ASSET_DERIVED，本区零公式。 */
const PLAN_TITLE_FONT = `${ASSET_DERIVED.planTitleSize}px ${SONG_STACK}`;
const PLAN_TITLE_LINE_HEIGHT = ASSET_DERIVED.planTitleSize * ASSET_DERIVED.planTitleLh;
const PLAN_HEAD_MARGIN = ASSET_DERIVED.planHeadMargin; // .pp-pc-head margin-bottom
const PLAN_OPTIONS_CHROME_H = ASSET_DERIVED.planOptionsChromeH; // .pp-pc-options
const PLAN_OPTION_PAD_V = ASSET_DERIVED.planOptionPadV; // .pp-pc-option padding 7×2
const PLAN_OPTION_BORDER = ASSET_DERIVED.planOptionBorder;
const PLAN_OPTION_LABEL_H = ASSET_DERIVED.planOptionSize * 1.8; // 行距继承 1.8
const PLAN_OPTION_DESC_GAP = ASSET_DERIVED.planOptionDescGap; // .pp-pc-option-desc margin-top
const PLAN_OPTION_DESC_LINE = ASSET_DERIVED.planOptionDescLine;
const PLAN_OPTION_DESC_INSET = ASSET_DERIVED.planOptionDescInset; // option padding 左右
const PLAN_OPTION_GAP = ASSET_DERIVED.planOptionGap; // .pp-pc-option margin-bottom（每枚，含末枚）

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

/* ── 卷首（folio-head，2026-08-30 原型转录；token 化：单一真源 = type-tokens.ts）──
 * 结构常量逐字镜像 PaperPanel.css .pp-folio-head 族
 * （源规格：prototype/lantai.html .folio-head / .yuwei / .folio-eyebrow / .folio-title / .folio-sub）。
 * 标题随换行实测（measureTextHeight），其余为固定结构高度。 */
export const FOLIO_TITLE_FONT = `600 ${FOLIO_TOKENS.titleSize}px ${SONG_STACK}`;
export const FOLIO_TITLE_LINE_HEIGHT = FOLIO_TOKENS.titleSize * FOLIO_TOKENS.titleLh; // .pp-folio-title line-height

export const FOLIO_EYEBROW_H = FOLIO_TOKENS.eyebrowH; // mono 10px × line-height 1.4
export const FOLIO_SUB_H = FOLIO_TOKENS.subH; // mono 10px × line-height 1.4
export const FOLIO_PAD_TOP = FOLIO_TOKENS.padTop; // .pp-folio-head padding-top
export const FOLIO_PAD_BOTTOM = FOLIO_TOKENS.padBottom; // padding-bottom 22 + rule-hard 2
export const FOLIO_YUWEI_H = FOLIO_TOKENS.yuweiH; // 24px 玉徽 + margin-bottom 12
export const FOLIO_TITLE_MARGIN_TOP = FOLIO_TOKENS.titleMarginTop;
export const FOLIO_SUB_MARGIN_TOP = FOLIO_TOKENS.subMarginTop;
/** 卷头与首块的呼吸距（原型 .folio-head margin-bottom 28） */
export const FOLIO_HEAD_GAP = FOLIO_TOKENS.headGap;
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

/* ── 资产/开放 kind 体高（2026-08-30 溢出修复）──
 * 分派规则镜像 renderer-service.resolveAssetBlock：kind 注册表查 def →
 * presentation 白名单校验回落 default → 已知表现原语逐款计高；def 缺失或
 * 表现名无注册渲染器（'*' 兜底）→ JSON 兜底视图计高。静态镜像只服务
 * 未挂载块的虚拟化窗口估高——挂载后以壳层 RO 实测为准（见下方回写桥）。 */

/** JSON 兜底视图高（JsonBody 逐字镜像：head 行 + pretty pre 封顶）。 */
function jsonViewH(payload: unknown, w: number): number {
  const pretty = (() => {
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  })();
  const textH = cappedH(
    pretty,
    Math.max(80, w - JSON_PRE_INSET),
    JSON_PRE_FONT,
    JSON_PRE_LINE_HEIGHT,
    JSON_PRE_MAX_H - JSON_PRE_PAD_V,
  );
  return JSON_VIEW_PAD_V + JSON_VIEW_HEAD_H + JSON_PRE_PAD_V + textH;
}

/** media 体高：图（保守占满 320 上限——加载后 RO 实测收敛）/ 文件行。 */
function mediaBodyH(p: { ext?: unknown; filePath?: unknown }): number {
  const ext = typeof p.ext === 'string' ? p.ext.toLowerCase() : '';
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext) && typeof p.filePath === 'string';
  return MEDIA_PAD_V + MEDIA_LABEL_H + (isImage ? 2 + MEDIA_IMG_MAX_H : MEDIA_ROW_H);
}

/** chart 体高：type 行 + svg（bar 按数据量加宽，与 ChartBody viewBox 同款公式）+ 标签行。 */
function chartBodyH(p: { type?: unknown; data?: unknown }, w: number): number {
  const type = typeof p.type === 'string' ? p.type : 'bar';
  const values = Array.isArray(p.data) ? p.data : [];
  const n = Math.max(values.length, 1);
  const svgH =
    type === 'pie'
      ? CHART_PIE_H
      : Math.min((w * 220) / Math.max(GRAPH_MIN_W, type === 'bar' ? n * 44 : 400), CHART_SVG_MAX_H);
  const labels = values.map((d) => (d && typeof d === 'object' ? String((d as { label?: unknown }).label ?? '') : ''));
  const hasLabels = labels.length > 0;
  const anyLabelText = labels.some((l) => l.length > 0);
  const labelLines = hasLabels
    ? Math.max(
        1,
        Math.ceil(measureTextHeight(labels.join(' '), w, CHART_LABEL_FONT, CHART_LABEL_LINE) / CHART_LABEL_LINE),
      )
    : 0;
  // 全空标签（纯数值 data）DOM 只剩 margin 空条（空 span 不产生行盒）
  const labelH = !hasLabels ? 0 : anyLabelText ? CHART_LABEL_GAP + labelLines * CHART_LABEL_LINE : CHART_LABEL_GAP;
  return CHART_PAD_V + CHART_TYPE_H + svgH + labelH;
}

/** metric 体高：caption + auto-fill 网格行（列数镜像 minmax(120,1fr)+gap 8）。 */
function metricBodyH(p: { items?: unknown; caption?: unknown }, w: number): number {
  const items = Array.isArray(p.items) ? p.items : [];
  const cols = Math.max(1, Math.floor((w + METRIC_GAP) / (METRIC_MIN_COL + METRIC_GAP)));
  const rows = Math.max(1, Math.ceil(items.length / cols));
  return METRIC_PAD_V + (p.caption ? METRIC_CAPTION_H : 0) + rows * METRIC_CARD_H + (rows - 1) * METRIC_GAP;
}

/** grid 表格体高：caption + 逐行文字测量（前 50 行精测、其余单行估——表格列宽
 *  是浏览器 auto 分配，偶数分列只是近似，挂载后 RO 实测兜底）。 */
function gridBodyH(p: { columns?: unknown; rows?: unknown; caption?: unknown }, w: number): number {
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const first = rows[0];
  const colCount = Array.isArray(p.columns) ? p.columns.length : Array.isArray(first) ? first.length : 0;
  const head = GRID_PAD_V + (p.caption ? GRID_CAPTION_H : 0);
  if (colCount === 0) return head;
  const colW = Math.max(40, w / colCount - 8);
  const rowH = (cells: unknown[], border: number): number => {
    let lines = 1;
    for (const c of cells) {
      const th = measureTextHeight(String(c), colW, GRID_FONT, GRID_ROW_LINE);
      lines = Math.max(lines, Math.ceil(th / GRID_ROW_LINE));
    }
    return lines * GRID_ROW_LINE + GRID_CELL_PAD_V + border;
  };
  let h = head + rowH(Array.isArray(p.columns) ? p.columns : [], GRID_HEAD_BORDER);
  const measured = Math.min(rows.length, GRID_MEASURE_ROW_CAP);
  for (let i = 0; i < measured; i++) h += rowH(Array.isArray(rows[i]) ? rows[i] : [], GRID_ROW_BORDER);
  h += (rows.length - measured) * (GRID_ROW_LINE + GRID_CELL_PAD_V + GRID_ROW_BORDER);
  return h;
}

/** graph/tree 体高：确定性树布局几何镜像（GraphTreeBody 同款深度/规模公式）。 */
function graphBodyH(payload: unknown, w: number): number {
  const p = payload as {
    nodes?: Array<{ id?: unknown; children?: Array<{ id?: unknown }> }>;
    edges?: Array<{ from: unknown; to: unknown }>;
  };
  const nodes = Array.isArray(p.nodes) ? p.nodes : [];
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  if (Array.isArray(p.edges)) {
    for (const e of p.edges) {
      if (typeof e?.from !== 'string' || typeof e?.to !== 'string') continue;
      const list = children.get(e.from);
      if (list) list.push(e.to);
      else children.set(e.from, [e.to]);
      hasParent.add(e.to);
    }
  } else {
    for (const n of nodes) {
      if (typeof n?.id !== 'string') continue;
      for (const c of n.children ?? []) {
        if (typeof c?.id !== 'string') continue;
        const list = children.get(n.id);
        if (list) list.push(c.id);
        else children.set(n.id, [c.id]);
        hasParent.add(c.id);
      }
    }
  }
  let maxDepth = 0;
  const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    maxDepth = Math.max(maxDepth, depth);
    for (const c of children.get(id) ?? []) walk(c, depth + 1);
  };
  const roots = nodes.filter((n) => typeof n?.id === 'string' && !hasParent.has(n.id)).map((n) => n.id as string);
  if (roots.length === 0)
    for (const n of nodes)
      if (typeof n?.id === 'string') walk(n.id, 0);
      else for (const r of roots) walk(r, 0);
  const W = Math.max(GRAPH_MIN_W, (maxDepth + 1) * GRAPH_COL_W + GRAPH_ORIGIN);
  const H = Math.max(GRAPH_MIN_H, nodes.length * GRAPH_ROW_H + 30);
  return GRAPH_PAD_V + Math.min((w * H) / W, GRAPH_SVG_MAX_H);
}

/** form 体高：题/文/选项列（desc 文本实测）/操作行。 */
function formBodyH(p: { title?: unknown; body?: unknown; options?: unknown }, w: number): number {
  const options = Array.isArray(p.options) ? p.options : [];
  let h = FORM_PAD_V + FORM_TITLE_H;
  if (typeof p.body === 'string' && p.body) {
    h += measureTextHeight(p.body, w, FORM_BODY_FONT, FORM_BODY_LINE) + FORM_BODY_GAP;
  }
  if (options.length > 0) {
    const descW = Math.max(80, w - FORM_OPT_DESC_INSET);
    let opts = 0;
    for (const o of options) {
      opts += FORM_OPT_BORDER + FORM_OPT_PAD_V + FORM_OPT_LABEL_H;
      const desc = (o as { description?: unknown } | undefined)?.description;
      if (typeof desc === 'string' && desc) {
        opts += measureTextHeight(desc, descW, FORM_DESC_FONT, FORM_OPT_DESC_LINE);
      }
    }
    h += opts + (options.length - 1) * FORM_OPT_GAP + FORM_SECTION_GAP;
  }
  return h + FORM_ACTIONS_H;
}

/** 表现解析（renderer-service.resolveAssetBlock 同款规则镜像）：
 * def 缺失 → undefined（'*' JSON 兜底）；presentation 越界 → default。 */
function assetPresentationOf(b: SourcedBlock): string | undefined {
  const def = assetKinds.get(b.kind);
  if (!def) return undefined;
  const pres = b.asset?.presentation;
  return pres && def.presentations.includes(pres) ? pres : def.defaultPresentation;
}

/** 资产/开放 kind 块体高（按表现原语分派；无注册表现 → JSON 兜底视图）。 */
function measureAssetBlockHeight(b: SourcedBlock): number {
  const pres = assetPresentationOf(b);
  const p = b.payload;
  switch (pres) {
    case 'media':
      return mediaBodyH(p as { ext?: unknown; filePath?: unknown });
    case 'chart':
      return chartBodyH(p as { type?: unknown; data?: unknown }, b.w);
    case 'metric':
      return metricBodyH(p as { items?: unknown; caption?: unknown }, b.w);
    case 'grid':
      return gridBodyH(p as { columns?: unknown; rows?: unknown; caption?: unknown }, b.w);
    case 'graph':
    case 'tree':
      return graphBodyH(p, b.w);
    case 'html':
      return HTML_BODY_PAD_V + HTML_FRAME_DEFAULT_H;
    case 'form':
      return formBodyH(p as { title?: unknown; body?: unknown; options?: unknown }, b.w);
    default:
      // 未知 kind / 表现名无注册渲染器（'*' 兜底 JsonBody；插件若覆盖 '*' 行，
      // 静态估高失准由挂载后 RO 实测兜底）。
      return jsonViewH(p, b.w);
  }
}

/* ── 实测回写桥（2026-08-30 溢出修复）──
 * 静态镜像对三类动态高结构性失明：媒体图加载、html 卡 iframe 上报、
 * 拟策卡交互态（反馈框展开/审批完成）。这几族（资产 kind + 开放 kind +
 * 拟策）挂载后由壳层 ResizeObserver 实测回写：实测优先于静态镜像。
 * 卸载不清记录——虚拟化挂/卸边界上「实测-镜像」高度差会反复横跳成布局
 * 振荡；payload 变化由重挂载首报登记 + 壳层去抖收敛自愈。
 *
 * 2026-08-31 滚动意图修（与壳层 blockRoRef 配套）：破「首报即重排」脉冲——
 * 首报（无记录）= 静态镜像校准登记，只写入不通知；滚动虚拟化中逐卡挂载
 * 逐卡立即重排 = 全局布局脉冲（实机症状：滚过图表/拟策卡区域整个流抽搐）。
 * 收敛改为壳层去抖一次触发；首报后值再变（媒体图加载等动态高）才即时通知。 */

interface ObservedHeight {
  w: number;
  h: number;
}

const observedHeights = new Map<string, ObservedHeight>();
const observedListeners = new Set<() => void>();

/** RO 实测回写结果：registered=首报校准登记（不触发布局重排）/
 *  changed=挂载后值变（动态高，立即重排）/ unchanged=同值（无变化）。 */
export type ObservedReport = 'registered' | 'changed' | 'unchanged';

/** 壳层 RO 实测回写（世界单位 = CSS px——RO 读布局盒，transform 缩放不影响）。
 *  无记录或宽度变化 = 首报：登记不通知（校准登记——收敛由壳层去抖一次触发，
 *  避免滚动挂载逐卡脉冲式全局重排）；记录已存在且值变 = 动态高（媒体图加载/
 *  iframe 上报/拟策反馈框展开），通知订阅者立即重排。 */
export function reportObservedBlockHeight(blockId: string, w: number, h: number): ObservedReport {
  const rec = Math.ceil(h);
  const prev = observedHeights.get(blockId);
  if (prev && prev.w === w) {
    if (prev.h === rec) return 'unchanged';
    observedHeights.set(blockId, { w, h: rec });
    for (const fn of observedListeners) fn();
    return 'changed';
  }
  observedHeights.set(blockId, { w, h: rec });
  return 'registered';
}

/** 有效实测高（记录宽与块宽一致才有效——钉住改宽后旧实测作废待重报）。 */
export function observedBlockHeightOf(blockId: string, w: number): number | undefined {
  const rec = observedHeights.get(blockId);
  return rec && rec.w === w ? rec.h : undefined;
}

/** 壳层订阅（回报 → measureTick bump → 布局重算）。 */
export function subscribeObservedBlockHeights(fn: () => void): () => void {
  observedListeners.add(fn);
  return () => {
    observedListeners.delete(fn);
  };
}

/** 实测优先的块族：资产 kind（asset 元数据在）+ 开放 kind（非内置）+ 拟策。
 *  工具组头是恒高结构块（一行注线+折叠行），不进观察面。 */
const BUILTIN_MEASURE_KINDS = new Set<string>([
  'user',
  'markdown',
  'reasoning',
  'diff',
  'tool',
  'code',
  'plan',
  'toolgroup',
  'notice',
]);

/** 壳层观察判据（与上方实测优先家族同源——只挂 RO 不回写是白挂）。 */
export function needsObservedHeight(kind: BlockKind, hasAsset: boolean): boolean {
  return hasAsset || kind === 'plan' || !BUILTIN_MEASURE_KINDS.has(kind);
}

/** 测试复位（生产不调用）。 */
export function clearObservedBlockHeights(): void {
  observedHeights.clear();
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

/* ── 来文宽度约束（2026-08-30 标题化：收缩宽退役）──
 * 原 P2a 来文按内容取宽（手迹纸条隐喻）随标题化整体移除；此处仅留最小版心宽
 * 约束供壳层使用（窄流区不压碎版心）。 */
export const USER_SHRINK_MIN_W = 320;

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

/** 纸条墨迹常量（.pp-strip 镜像：12.5px 宋体 / 1.7 行距 / padding 12）。
 *  token 化：单一真源 = CHROME_TOKENS.strip。 */
export const STRIP_INK = {
  font: `${CHROME_TOKENS.strip.size}px ${SONG_STACK}`,
  lineHeight: CHROME_TOKENS.strip.size * CHROME_TOKENS.strip.lh,
  inset: CHROME_TOKENS.strip.padH,
};

/* ── 眉批栏（P5 夹注旁注化）——.pp-marginalia 镜像：块右缘 24px 起、总宽 240，
 * 左规线 2 + padding 10 → 内容宽 228；字体沿用夹注族（13.5px/1.85 石墨）。 ── */
export const MARGINALIA_W = CHROME_DERIVED.marginaliaW;
export const MARGINALIA_INSET = CHROME_DERIVED.marginaliaInset;

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
    case 'turn-error':
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
 *  ——增量路径复用同函数，测量与渲染共用单一解析的纪律不变。
 *  sidecarOut（2026-08-31 移出语义）：`:sc` 快照钉在画布上时眉批栏只剩占位
 *  一行（.pp-marginalia-out，实高 ~18px）——按折叠态同款「一行夹注」计
 *  （安全方向超测，与折叠态测高约定一致）。 */
function measureMarkdownBody(blocks: MdBlock[], b: SourcedBlock, sidecarFolded = false, sidecarOut = false): number {
  const bodyH = measureMdBlocks(blocks, b.w);
  // P5 眉批化：夹注挂侧栏（.pp-marginalia）——复合块高 = max(正文@全宽,
  // 夹注@侧栏内容宽)。眉批恒容于块高内 → 栈几何零变化（方案甲的决定性
  // 优势，见 pretext-typography-plan §三）。折叠态（夹注恒折拍板）只占一行。
  const sidecar = (b.payload as { sidecar?: { text: string } }).sidecar;
  if (!sidecar?.text) return bodyH;
  const noteH =
    sidecarOut || sidecarFolded
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
export function measureBlockHeight(b: SourcedBlock, folded = false, sidecarFolded = false, sidecarOut = false): number {
  const p = b.payload as PayloadLike;
  switch (b.kind) {
    case 'user': {
      // 圈点（C7 + P3）：含【】候选走逐行 rich 精确（圈点 = 原子件 + 椭圆横向
      // chrome，括号被渲染消费不再保守覆盖）；纯文本保持 pre-wrap 整体 layout。
      const textH = p.text ? measureUserTextHeight(p.text, b.w - USER_TEXT_INSET) : 0;
      // 附件行（C10）：每文件一行 mono 小字，高度线性叠加
      const files = (b.payload as { files?: Array<{ path: string; name: string }> }).files;
      const filesH = files?.length ? USER_FILES_MARGIN_TOP + files.length * USER_FILE_LINE_H : 0;
      // 题签（2026-08-30 标题化）+ asterism（B1）恒加：题签置顶、花押收尾
      return USER_KIND_H + textH + filesH + USER_ASTERISM_H;
    }
    case 'markdown': {
      // markdown 专项（2026-08-30）：消费 parseMarkdown 结构模型逐元素计高
      // （与 MarkdownBody 渲染共用同一解析——结构漂移结构性不成立）。
      if (!p.text) return 0;
      return measureMarkdownBody(parseMarkdown(p.text), b, sidecarFolded, sidecarOut);
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
    case 'turn-error':
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
      // 2026-08-30 溢出修复：标题实测（旧固定 39 漏算换行）、方案选择区逐枚
      // 实测（旧 118 装不下两枚带描述的方案）、操作行按钮实高（旧 40 偏小）。
      // 无回调的只读拟策块不增加交互区高度（施工单 #1/#2 语义不变）。
      const plan = b.payload as {
        title?: string;
        _callback?: unknown;
        options?: Array<{ label?: string; description?: string }>;
      };
      const headH =
        measureTextHeight(plan.title || '拟策', b.w, PLAN_TITLE_FONT, PLAN_TITLE_LINE_HEIGHT) + PLAN_HEAD_MARGIN;
      const optionsH = plan._callback && (plan.options?.length ?? 0) >= 2 ? planOptionsH(plan.options ?? [], b.w) : 0;
      const actionsH = plan._callback ? PLAN_ACTIONS_H : 0;
      return PLAN_CHROME_H + headH + itemsH + optionsH + actionsH;
    }
    case 'toolgroup':
      // 工具组头恒一行（2026-08-30 会话流专项）：折叠行即本体，注线顶距同脚注族；
      // 子卡是独立 tool 块，收起由壳层摘出布局栈，头高与子卡数无关。
      return TOOL_PAD_TOP + FOLD_ROW_H;
    default:
      // 资产/开放 kind：按表现原语镜像计高（旧固定 80 是画图族卡片溢出的根因）。
      return measureAssetBlockHeight(b);
  }
}

/** 拟策方案选择区高（.pp-pc-options 逐字镜像；描述文本实测可换行）。 */
function planOptionsH(options: Array<{ label?: string; description?: string }>, w: number): number {
  const textW = Math.max(80, w - PLAN_OPTION_DESC_INSET);
  let h = PLAN_OPTIONS_CHROME_H;
  for (const o of options) {
    h += PLAN_OPTION_PAD_V + PLAN_OPTION_BORDER + PLAN_OPTION_LABEL_H + PLAN_OPTION_GAP;
    if (o.description) {
      h += PLAN_OPTION_DESC_GAP + measureTextHeight(o.description, textW, `12px ${SONG_STACK}`, PLAN_OPTION_DESC_LINE);
    }
  }
  return h;
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
 *  P4：ink 层复用同一签名做墨迹缓存 key（块 id + 签名 + 宽）。
 *  sidecarOut（2026-08-31 移出语义）：眉批已钉出入签——钉/拔钉必重测。 */
export function measureSignature(b: SourcedBlock, folded: boolean, sidecarFolded = false, sidecarOut = false): string {
  const p = b.payload as Record<string, unknown>;
  const f = folded ? 1 : 0;
  const sf = sidecarFolded ? 1 : 0;
  const so = sidecarOut ? 1 : 0;
  switch (b.kind) {
    case 'user':
      return `user|${p.text ?? ''}|${(p.files as Array<{ path: string; name: string }> | undefined)?.length ?? 0}`;
    case 'markdown':
      return `markdown|${p.text ?? ''}|${(p.sidecar as { text?: string } | undefined)?.text ?? ''}|${sf}|${so}`;
    case 'reasoning':
      return `reasoning|${f}|${p.text ?? ''}`;
    case 'notice':
      return `notice|${p.text ?? ''}`;
    case 'turn-error':
      return `turn-error|${p.text ?? ''}|${p.level ?? ''}`;
    case 'diff':
      return `diff|${p.lang ?? ''}|${p.text ?? ''}`;
    case 'tool':
      return `tool|${f}|${p.args ?? ''}|${p.output ?? ''}|${p.err ?? ''}`;
    case 'code':
      return `code|${f}|${p.code ?? ''}|${p.output ?? ''}|${p.err ?? ''}`;
    case 'plan':
      // 标题入签（2026-08-30 起标题实测计高——换行变高度）
      return `plan|${p.title ?? ''}|${p.content ?? ''}|${(p.options as unknown[] | undefined)?.length ?? 0}|${
        p._callback ? 1 : 0
      }`;
    case 'toolgroup':
      // 子卡数入签（流式追加子卡 → 组头重测；头高本身恒定）
      return `toolgroup|${((p.items as unknown[] | undefined) ?? []).length}`;
    default:
      // 资产/开放 kind：表现名入签；payload 变化由 RO 实测驱动（静态镜像
      // 只服务未挂载块的虚拟化窗口估高，不逐 payload 入签省 stringify）。
      return `open|${b.kind}|${b.asset?.presentation ?? ''}`;
  }
}

/** 块高缓存测量：签名命中直接返回记忆高度，否则真测并登记。
 *  folded（折叠机制）：折叠/展开是高度信号——入签名，切换必重测。
 *  w（P2 变宽）：宽度也是高度信号（收缩/resize 改宽必改高）——签名尾缀。
 *  markdown 块走增量解析：流式文本增长时复用稳定前缀块，只重解析最后一个块
 *  （与渲染端 parseMarkdownIncremental 同源，测量与渲染结构一致性不破）。
 *  实测优先（2026-08-30 溢出修复）：动态高家族（资产/开放/拟策）挂载后有
 *  壳层 RO 回写记录 → 直接采用（静态镜像只服务未挂载块的窗口估高）；
 *  实测值入签——记录变化即重算，记录与静态镜像同值时零额外重测。 */
export function measureBlockHeightCached(
  b: SourcedBlock,
  cache: BlockMeasureCache,
  folded = false,
  sidecarFolded = false,
  sidecarOut = false,
): number {
  const obs = needsObservedHeight(b.kind, b.asset != null) ? observedBlockHeightOf(b.id, b.w) : undefined;
  const sig = `${measureSignature(b, folded, sidecarFolded, sidecarOut)}|w=${b.w}|obs=${obs ?? ''}`;
  const hit = cache.byId.get(b.id);
  if (hit && hit.sig === sig) return hit.h;
  let h: number;
  if (obs != null) {
    h = obs;
  } else if (b.kind === 'markdown') {
    const p = b.payload as { text?: string };
    const text = p.text ?? '';
    if (!text) {
      h = 0;
    } else {
      const prev = cache.mdParse.get(b.id) ?? null;
      const res = parseMarkdownIncremental(text, prev);
      cache.mdParse.set(b.id, res.state);
      h = measureMarkdownBody(res.blocks, b, sidecarFolded, sidecarOut);
    }
  } else {
    h = measureBlockHeight(b, folded, sidecarFolded, sidecarOut);
  }
  cache.byId.set(b.id, { sig, h });
  return h;
}

/* ── 缓存管理 ── */

/** 测试复位（生产不调用）。 */
export function clearPaperMeasureCache(): void {
  prepareCache.clear();
  richCache.clear();
  clearPretextCache();
}
