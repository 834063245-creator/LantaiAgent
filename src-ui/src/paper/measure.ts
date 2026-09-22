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
import type { BlockKind, SourcedBlock } from './block-model';
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
import { codeDisplay, hasArgsToShow, hasPayloadToShow, toolDisplay } from './tool-text';

/* ── 纸面字体常量（2026-08-30 token 化：单一真源 = type-tokens.ts）──
 * 2026-09-10 三体换代：宋/楷/等宽退役，三栈统一 MiSans（文类语义键 song/kai/mono
 * 保留——FONT_STACKS 与 tokens.css --f-* 同源，canvas 测量字体必须与渲染字体一致）。 */

import {
  ASSET_DERIVED,
  ASSET_TOKENS,
  CHROME_DERIVED,
  CHROME_TOKENS,
  cssUsedPx,
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

/** 来文（user）：手迹位 16px/1.9 朱砂深（.pp-block.pp-user .pp-body；三体换代后同 MiSans）
 *  B4 环1 拍板 C：字号 18→16 收到正文 17 之下，行高同 C 变体 1.9
 *  （2026-09-19：行高一律过 cssUsedPx——测高须用 CSS **用值**，见 type-tokens 头注） */
export const PAPER_USER_FONT = `${PAPER_TYPE.user.size}px ${FONT_STACKS[PAPER_TYPE.user.stack]}`;
export const PAPER_USER_LINE_HEIGHT = cssUsedPx(PAPER_TYPE.user.size * PAPER_TYPE.user.lh);

/** 正文（markdown）：宋体 17px/2.0（.pp-block.pp-markdown .pp-body） */
export const PAPER_BODY_FONT = `${PAPER_TYPE.body.size}px ${FONT_STACKS[PAPER_TYPE.body.stack]}`;
export const PAPER_BODY_LINE_HEIGHT = cssUsedPx(PAPER_TYPE.body.size * PAPER_TYPE.body.lh);

/** 夹注（reasoning）：13.5px/1.85 石墨（.pp-block.pp-reasoning .pp-body） */
export const PAPER_REASONING_FONT = `${PAPER_TYPE.reasoning.size}px ${FONT_STACKS[PAPER_TYPE.reasoning.stack]}`;
export const PAPER_REASONING_LINE_HEIGHT = cssUsedPx(PAPER_TYPE.reasoning.size * PAPER_TYPE.reasoning.lh);

/** 贴黄（notice）：12.5px/1.7（.pp-block.pp-notice .pp-body） */
export const PAPER_NOTICE_FONT = `${PAPER_TYPE.notice.size}px ${FONT_STACKS[PAPER_TYPE.notice.stack]}`;
export const PAPER_NOTICE_LINE_HEIGHT = cssUsedPx(PAPER_TYPE.notice.size * PAPER_TYPE.notice.lh);

/** 抄录（diff）图版：等宽 12.5px/1.7（.pp-block.pp-diff pre） */
export const PAPER_MONO_FONT = `${PAPER_TYPE.mono.size}px ${FONT_STACKS[PAPER_TYPE.mono.stack]}`;
export const PAPER_MONO_LINE_HEIGHT = cssUsedPx(PAPER_TYPE.mono.size * PAPER_TYPE.mono.lh);

/** 脚注（tool）args：等宽 11.5px/1.6 石青（.pp-block.pp-tool pre） */
export const PAPER_TOOL_FONT = `${PAPER_TYPE.tool.size}px ${FONT_STACKS[PAPER_TYPE.tool.stack]}`;
export const PAPER_TOOL_LINE_HEIGHT = cssUsedPx(PAPER_TYPE.tool.size * PAPER_TYPE.tool.lh);

/** 脚注输出/错误（.pp-out）：等宽 11px/1.5 */
export const PAPER_OUT_FONT = `${PAPER_TYPE.out.size}px ${FONT_STACKS[PAPER_TYPE.out.stack]}`;
export const PAPER_OUT_LINE_HEIGHT = cssUsedPx(PAPER_TYPE.out.size * PAPER_TYPE.out.lh);

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
const MD_TABLE_CELL_PAD = MD_TOKENS.tableCellPadH * 2; // th/td 左右 padding 8×2（单侧 8——旧值只扣 8，测宽偏宽→行数偏少→叠字方向）
const MD_TABLE_CELL_PAD_V = MD_DERIVED.tableCellPadV; // th/td 上下 padding 4×2
const MD_TABLE_ROW_BORDER = MD_TOKENS.tableRowBorder; // th 行底规线
/** 表格单元字体：等宽 11.5px/1.5（.pp-md-table） */
const MD_TABLE_SIZE = MD_TOKENS.tableSize;
/** 数学块版式（科研 LaTeX；CSS 侧 .pp-md-math / .pp-md-math-inline 镜像）。
 *  静态预算只服务虚拟化未挂载窗口——含公式 markdown 挂载后由 RO 实测回写
 *  优先（needsObservedHeight 内容感知，见下）。预算宁可略高不叠字（风险 1）。 */
const MD_MATH_GAP = MD_TOKENS.mathGap; // .pp-md-math margin-bottom
const MD_MATH_DISPLAY_LINE_H = MD_TOKENS.mathDisplayLineH; // display 公式预算行高系数
const MD_MATH_DISPLAY_MAX_LINES = MD_TOKENS.mathDisplayMaxLines; // 预算行数上限
const MD_TABLE_LINE_HEIGHT = MD_TOKENS.tableSize * MD_TOKENS.tableLh;
/** 远端图固定盒（B4 D-9；chem boxH 先例）：.pp-md-imgbox 高度恒定——
 *  加载/失败态不改版面，静态镜像即精确（不触发 RO）。border 计入盒高
 *  （全局 box-sizing: border-box）。 */
const MD_IMG_BOX_H = MD_TOKENS.imgBoxH; // .pp-md-imgbox 固定盒高
const MD_IMG_GAP = MD_TOKENS.imgGap; // .pp-md-imgbox margin-bottom

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
/** 圈点字体：来文手迹位 16px 加 600（.pp-circled font-weight 镜像）。 */
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

/** md 行内序列 → rich items（标志位 → 字体映射，镜像规则见上节注释）。
 *  行内公式 = 不可折行原子（break:'never'）：KaTeX 原子在行内整体移动不腰斩。
 *  宽度按公式源码近似（KaTeX 渲染宽 ≠ 源码宽，但短公式同一量级；溢出风险
 *  由「宁可高估行数」吸收——富行内已触发精确测量路径）。 */
function mdRichItems(inl: MdInline[], size: number, stack: string): RichInlineItem[] {
  return inl.map((seg) => {
    const weight = seg.b ? '600 ' : '';
    const style = seg.i ? 'italic ' : '';
    if (seg.math !== undefined) {
      // 公式：正文字号（KaTeX 内联 ≈ body），不可折行；文本 = 源码近似宽
      return {
        text: seg.math,
        font: `${size}px ${stack}`,
        break: 'never',
      };
    }
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
/** 来文附图缩略行（B4 D-9）：tile 64 / 行距 8 / 上距 10（--pp-ch-userImages-* 镜像）。 */
const USER_IMAGE_THUMB = CHROME_DERIVED.userImageThumb;
const USER_IMAGE_GAP = CHROME_DERIVED.userImageGap;
const USER_IMAGES_MARGIN_TOP = CHROME_DERIVED.userImagesMarginTop;
const REASONING_TEXT_INSET = CHROME_DERIVED.reasoningTextInset; // padding-left 18 + border-left 2（虚线）
const TOOL_PAD_TOP = CHROME_DERIVED.toolPadTop; // .pp-block.pp-tool padding-top
/** 载荷段头（.pp-sec-head，2026-09-14）：恒一行（mono 10px × 1.4 = 14），
 *  首段不留上距——参数段紧跟折叠行（渲染端 gap 条件同判据）。 */
export const SEC_HEAD_H = CHROME_DERIVED.secHeadH;
export const SEC_HEAD_GAP = CHROME_DERIVED.secHeadGap;
const DIFF_LANG_H = CHROME_DERIVED.diffLangH; // .pp-lang 10px×lh1 + margin-bottom 6
const DIFF_PRE_CHROME_H = CHROME_DERIVED.diffPreChromeH; // pre padding 14×2 + border 1×2
const DIFF_TEXT_INSET = CHROME_DERIVED.diffTextInset; // border-left 3 + padding-left 20
const PLAN_CHROME_H = CHROME_DERIVED.planChromeH; // .pp-pc border-top 2 + border-bottom 1 + padding 14×2
const PLAN_TEXT_INSET = CHROME_DERIVED.planTextInset; // 策面横向内缩：石青左线 3 + 内距 16×2（.pp-pc-body 测宽）
const PLAN_ACTIONS_H = CHROME_DERIVED.planActionsH; // 按钮行
const NOTICE_CHROME_H = CHROME_DERIVED.noticeChromeH; // padding 8×2 + border-bottom 1
const NOTICE_TEXT_INSET = CHROME_DERIVED.noticeTextInset; // padding 12×2
/** 贴黄正文上距 = padding-top（chrome 的另一半是 border-bottom 1）——墨迹纵向用。 */
const NOTICE_TEXT_PAD_V = CHROME_TOKENS.notice.padV;
/** diff 文本上距 = pre padding-top（DIFF_PRE_CHROME_H 是上下内距 + 上下 border 之和）。 */
const DIFF_PRE_PAD_V = CHROME_TOKENS.diff.prePadV;

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
const CHART_LABEL_GAP = ASSET_DERIVED.chartLabelGap; // .pp-chart-labels margin-top
const CHART_LABEL_LINE = ASSET_DERIVED.chartLabelSize * 1.8;
const CHART_LABEL_FONT = `${ASSET_DERIVED.chartLabelSize}px ${MONO_STACK}`;
const CHART_INTERACTIVE_BOX_H = ASSET_DERIVED.chartInteractiveBoxH; // .pp-chart-interactive-box 固定盒高（#16）
// D4-D9（2026-09-16）：静态图几何——与 components.tsx CHART_GEO 同值（一致性由
// tests/chart-geometry.test.ts 钉住；token 真源 = ASSET_TOKENS.chart）
const CHART_TITLE_H = ASSET_DERIVED.chartTitleH;
const CHART_AXIS_NAMES_H = ASSET_DERIVED.chartAxisNamesH;

const METRIC_PAD_V = ASSET_DERIVED.metricPadV; // .pp-metric padding 2×2
const METRIC_CARD_H = ASSET_DERIVED.metricCardH; // border + padding + label + value
const METRIC_GAP = ASSET_DERIVED.metricGap; // .pp-metric-grid gap
const METRIC_MIN_COL = ASSET_DERIVED.metricMinCol; // minmax(120px, 1fr)

const GRID_PAD_V = ASSET_DERIVED.gridPadV; // .pp-grid padding 2×2
const PLATE_HEAD_H = ASSET_DERIVED.plateHeadH; // 图版题签行总高（恒在）
const GRID_CELL_PAD_V = ASSET_DERIVED.gridCellPadV; // th/td padding 4×2
const GRID_ROW_LINE = ASSET_DERIVED.gridRowLine; // .pp-grid-table 11px（行距继承 1.8）
const GRID_HEAD_BORDER = ASSET_DERIVED.gridHeadBorder; // th border-bottom
const GRID_ROW_BORDER = ASSET_DERIVED.gridRowBorder; // td border-bottom
const GRID_MEASURE_ROW_CAP = ASSET_DERIVED.gridMeasureRowCap; // 逐行文字测量上限
const GRID_VIRTUAL_VIEWPORT_H = ASSET_DERIVED.gridVirtualViewportH; // .pp-grid-virtual-scroll 可视区高（#11）
const GRID_FONT = `${ASSET_DERIVED.gridSize}px ${MONO_STACK}`;

const GRAPH_PAD_V = ASSET_DERIVED.graphPadV; // .pp-graph padding 4×2
const _GRAPH_ROW_H = ASSET_DERIVED.graphRowH;

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
const FORM_ACTIONS_H = ASSET_DERIVED.formActionsH; // 操作行（.pp-pc-actions + 钤印钮面）
const FORM_BODY_FONT = `${ASSET_DERIVED.formBodySize}px ${SONG_STACK}`;
const FORM_DESC_FONT = `${ASSET_DERIVED.formDescSize}px ${SONG_STACK}`;

const BOARD_PAD_V = ASSET_DERIVED.boardPadV; // .pp-board padding 2×2
const BOARD_COL_RULE = ASSET_DERIVED.boardColRule; // 列顶规线 + padding-top 6（结构计入列高）
const BOARD_COL_TITLE_H = ASSET_DERIVED.boardColTitleH; // .pp-board-col-title + margin-bottom
const BOARD_CARD_BORDER = ASSET_DERIVED.boardCardBorder;
const BOARD_CARD_PAD_V = ASSET_DERIVED.boardCardPadV; // 卡 padding 6×2
const BOARD_CARD_GAP = ASSET_DERIVED.boardCardGap;
const BOARD_CARD_LABEL_H = ASSET_DERIVED.boardCardLabelH;
const BOARD_CARD_BODY_H = ASSET_DERIVED.boardCardBodyH;
const BOARD_CARD_FONT = `${ASSET_TOKENS.board.cardBodySize}px ${SONG_STACK}`;

const TIMELINE_PAD_V = ASSET_DERIVED.timelinePadV; // .pp-timeline padding 2×2
const TIMELINE_INSET = ASSET_DERIVED.timelineInset; // 节点轨 + 时标列 + 两道列距（正文宽 = w - inset）
const TIMELINE_ITEM_GAP = ASSET_DERIVED.timelineItemGap; // 行距（轨线接续用同一值）
const TIMELINE_NODE_H = ASSET_DERIVED.timelineNodeH; // 节点方块（含边框）
const TIMELINE_TS_LINE = ASSET_DERIVED.timelineTsLine;
const TIMELINE_TS_W = ASSET_DERIVED.timelineTsW;
const TIMELINE_TS_FONT = ASSET_DERIVED.timelineTsFont;
const TIMELINE_TITLE_LINE = ASSET_DERIVED.timelineTitleLine;
const TIMELINE_BODY_LINE = ASSET_DERIVED.timelineBodyLine;
const TIMELINE_TITLE_FONT = ASSET_DERIVED.timelineTitleFont;
const TIMELINE_BODY_FONT = ASSET_DERIVED.timelineBodyFont;

const CITATION_PAD_V = ASSET_DERIVED.citationPadV; // .pp-citation padding 2×2
const CITATION_TITLE_FONT = ASSET_DERIVED.citationTitleFont;
const CITATION_TITLE_LINE = ASSET_DERIVED.citationTitleLine;
const CITATION_AUTHOR_FONT = ASSET_DERIVED.citationAuthorFont;
const CITATION_AUTHOR_LINE = ASSET_DERIVED.citationAuthorLine;
const CITATION_AUTHOR_GAP = ASSET_DERIVED.citationAuthorGap;
const CITATION_VENUE_FONT = ASSET_DERIVED.citationVenueFont;
const CITATION_VENUE_LINE = ASSET_DERIVED.citationVenueLine;
const CITATION_VENUE_GAP = ASSET_DERIVED.citationVenueGap;
const CITATION_IDS_FONT = ASSET_DERIVED.citationIdsFont;
const CITATION_IDS_LINE = ASSET_DERIVED.citationIdsLine;
const CITATION_IDS_MARGIN_TOP = ASSET_DERIVED.citationIdsMarginTop;
const CITATION_SUMMARY_LINE = ASSET_DERIVED.citationSummaryLine; // BibTeX summary 恒单行（字号不入测高）
const CITATION_BIB_MARGIN_TOP = ASSET_DERIVED.citationBibMarginTop;
const CITATION_BIB_TOP_CHROME = ASSET_DERIVED.citationBibTopChrome; // border-top 1 + padding-top 4

const CHEM_PAD_V = ASSET_DERIVED.chemPadV; // .pp-chem padding 2×2
const CHEM_NAME_FONT = ASSET_DERIVED.chemNameFont;
const CHEM_NAME_LINE = ASSET_DERIVED.chemNameLine;
const CHEM_NAME_MARGIN_B = ASSET_DERIVED.chemNameMarginB; // .pp-chem-name margin-bottom
const CHEM_BOX_H = ASSET_DERIVED.chemBoxH; // .pp-chem-box 固定盒高（含 border）
const CHEM_BOX_MARGIN_B = ASSET_DERIVED.chemBoxMarginB; // .pp-chem-box margin-bottom
const CHEM_META_FONT = ASSET_DERIVED.chemMetaFont;
const CHEM_META_LINE = ASSET_DERIVED.chemMetaLine;

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
 * 结构常量逐字镜像 PaperPanel.css 卷首族规则
 * （源规格：prototype/lantai.html .folio-head / .yuwei / .folio-eyebrow / .folio-title / .folio-sub）。
 * 标题随换行实测（measureTextHeight），其余为固定结构高度。
 * 2026-09-16「版心天头」重排：卷首收进 colW 版心居中，题字可用宽由
 * folioHeadWidthFor 单点派生（别再在调用点手算 −32）。 */
export const FOLIO_TITLE_FONT = `700 ${FOLIO_TOKENS.titleSize}px ${SONG_STACK}`;
export const FOLIO_TITLE_LINE_HEIGHT = FOLIO_TOKENS.titleSize * FOLIO_TOKENS.titleLh; // 题字 line-height

export const FOLIO_EYEBROW_H = FOLIO_TOKENS.eyebrowH; // 眉行 11px × line-height 15px
export const FOLIO_SUB_H = FOLIO_TOKENS.subH; // 档行 11px × line-height 15px
export const FOLIO_PAD_TOP = FOLIO_TOKENS.padTop; // 卷首 padding-top
export const FOLIO_PAD_BOTTOM = FOLIO_TOKENS.padBottom; // inner padding-bottom 22 + rule-hard 2
export const FOLIO_YUWEI_H = FOLIO_TOKENS.yuweiH; // 26px 玉徽 + margin-bottom 14
export const FOLIO_TITLE_MARGIN_TOP = FOLIO_TOKENS.titleMarginTop;
export const FOLIO_SUB_MARGIN_TOP = FOLIO_TOKENS.subMarginTop;
/** 卷头与首块的呼吸距（原型 .folio-head margin-bottom 28） */
export const FOLIO_HEAD_GAP = FOLIO_TOKENS.headGap;
/** 卷首版心宽（**唯一真源** = FOLIO_TOKENS.colW）。CSS 端有两条镜像：
 *  内层盒 `width: min(720px, 100%)` 与卷首左右内距 16×2——改一处必改三处。 */
export const FOLIO_COL_W = FOLIO_TOKENS.colW;
/** 卷首**版心宽**（= 题字/规线可用宽）：内层盒 `width: min(720px, 100%)` 落在左右
 *  内距 16×2 之内，两条都在本式一次算清。**单一真源**——调用点禁手写 `width − 32`
 *  （2026-09-16 前正是那么散的：宽流区下漏掉版心封顶，长题字永不换行）。
 *  CSS 端两条镜像 = `PaperPanel.css` 的 `.pp-folio-head` `padding: 24px 16px 0` 与
 *  `.pp-folio-inner` `width: min(720px, 100%)`（改一处必改三处）。
 *  消费面：卷首测高（本文件）+ **版口引线的卷侧锚点**（卷首规线左端那枚版口钮的起端
 *  = 版心左缘，见 paper-shell/dock-tether.ts）。 */
export function folioHeadWidthFor(regionWidth: number): number {
  return Math.min(FOLIO_COL_W, regionWidth - 32);
}

/** 卷首头整体高度（世界单位）：题字按可用宽实测行数，其余固定。
 *  入参 = **流区宽**（不是题字可用宽）：左右内距 16×2 与版心封顶 720 都在本函数内
 *  一次算清。2026-09-16 前由调用点手写 `regionWidth - 32`，宽流区下漏掉版心封顶
 *  ——默认 1440 宽流区实得「可用宽 1408」，长题字永不换行、卷首高度恒等于一行
 *  （题字实际按 720 版心换行 → 实测值与渲染值不符，卷级几何偏矮）。本次收口。 */
export function measureFolioHeadHeight(title: string, regionWidth: number): number {
  const availWidth = folioHeadWidthFor(regionWidth);
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
  // 题签恒在（2026-09-17）：媒体块也带题签行（签「图」）
  return MEDIA_PAD_V + PLATE_HEAD_H + MEDIA_LABEL_H + (isImage ? 2 + MEDIA_IMG_MAX_H : MEDIA_ROW_H);
}

/** chart 体高（D9，2026-09-16 重写）：type 行 +（可选）title 行 + svg +（可选）标签行/轴名行。
 *
 *  两处修复（旧实现的两宗罪）：
 *   ① 只认 Array.isArray(p.data)——对象形状 {labels,values} 会算错块高（渲染按
 *      归一语义画了标签，测高却当无标签 → 差一整行）。
 *   ② 未计 config.title / 轴名（渲染新增了这两行，测高必须跟随）。
 *
 *  数据语义与渲染组件 normalizeChartData 同源（三形状：对象/带标签数组/纯数值数组）。 */
function chartBodyH(p: { type?: unknown; data?: unknown; config?: unknown }, w: number): number {
  const type = typeof p.type === 'string' ? p.type : 'bar';
  // 归一：与 components.tsx normalizeChartData 同判据（此处只关心 labels/数量）
  const raw = Array.isArray(p.data)
    ? p.data
    : p.data && typeof p.data === 'object' && Array.isArray((p.data as { values?: unknown }).values)
      ? ((p.data as { values: unknown[] }).values as unknown[]).map((v, i) => ({
          value: v,
          label: Array.isArray((p.data as { labels?: unknown[] }).labels)
            ? ((p.data as { labels: unknown[] }).labels[i] ?? '')
            : '',
        }))
      : [];
  const n = Math.max(raw.length, 1);
  const labels = raw.map((d) => (d && typeof d === 'object' ? String((d as { label?: unknown }).label ?? '') : ''));
  const anyLabelText = labels.some((l) => l.length > 0);

  // 盒定比例（2026-09-17 P1）：SVG 高按类目数分档，与坐标系宽度解耦——
  // 旧模型 min(w·vbH/viewBoxW, maxH) 会把「条数少」翻译成「图更小」，实测 3 根柱
  // 只占 213px 居中、两侧各空 253px；现模型见 ASSET_DERIVED.chartSvgH。
  const svgH = ASSET_DERIVED.chartSvgH(type, n);

  // 分类标签（D8 起进 SVG，占 SVG 高度的一部分，不再单独占盒外行）；饼图仍走盒外图例行
  const pieLegendH =
    type === 'pie' && anyLabelText
      ? (() => {
          const text = labels.filter((l) => l.length > 0).join(' ');
          const lines = Math.max(
            1,
            Math.ceil(measureTextHeight(text, w, CHART_LABEL_FONT, CHART_LABEL_LINE) / CHART_LABEL_LINE),
          );
          return CHART_LABEL_GAP + lines * CHART_LABEL_LINE;
        })()
      : 0;

  const cfg = (p.config ?? {}) as { title?: unknown; xName?: unknown; yName?: unknown };
  const titleH = typeof cfg.title === 'string' && cfg.title.length > 0 ? CHART_TITLE_H : 0;
  const hasAxisNames =
    (typeof cfg.xName === 'string' && cfg.xName.length > 0) || (typeof cfg.yName === 'string' && cfg.yName.length > 0);
  const axisNamesH = hasAxisNames ? CHART_AXIS_NAMES_H : 0;

  return CHART_PAD_V + CHART_TYPE_H + titleH + svgH + pieLegendH + axisNamesH;
}

/** metric 体高：caption + auto-fill 网格行（列数镜像 minmax(120,1fr)+gap 8）。 */
function metricBodyH(p: { items?: unknown; caption?: unknown }, w: number): number {
  const items = Array.isArray(p.items) ? p.items : [];
  const cols = Math.max(1, Math.floor((w + METRIC_GAP) / (METRIC_MIN_COL + METRIC_GAP)));
  const rows = Math.max(1, Math.ceil(items.length / cols));
  // 题签恒在同上
  return METRIC_PAD_V + PLATE_HEAD_H + rows * METRIC_CARD_H + (rows - 1) * METRIC_GAP;
}

/** grid 表格体高：caption + 逐行文字测量（前 50 行精测、其余单行估——表格列宽
 *  是浏览器 auto 分配，偶数分列只是近似，挂载后 RO 实测兜底）。 */
/** grid 体高（GridBody 逐字镜像）：pad + caption + 表头行 + 数据行。
 *  数据行：前 GRID_MEASURE_ROW_CAP 行按单元格文本实测折行，其余按单行高估
 *  （GRID_ROW_LINE + padV + border）延伸——全量平铺语义。
 *  大表（>1000 行，镜像组件 GRID_VIRTUAL_THRESHOLD）转虚拟滚动镜像：pad +
 *  caption + 表头行 + 可视区固定高（不再全高延伸——滚动浏览，行数不增高）。 */
const GRID_VIRTUAL_THRESHOLD_MEASURE = 1000;

function gridBodyH(p: { columns?: unknown; rows?: unknown; caption?: unknown }, w: number): number {
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const first = rows[0];
  const colCount = Array.isArray(p.columns) ? p.columns.length : Array.isArray(first) ? first.length : 0;
  // 题签恒在（2026-09-17）：题签行总高恒计入（有题名/无题名同高）
  const head = GRID_PAD_V + PLATE_HEAD_H;
  if (colCount === 0) return head;
  // 大表虚拟滚动（>1000 行）：表头行（th padding 上下合计 + 行高 1.8）+ 固定可视区
  if (rows.length > GRID_VIRTUAL_THRESHOLD_MEASURE) {
    const headH = GRID_CELL_PAD_V + GRID_ROW_LINE + GRID_HEAD_BORDER;
    return head + headH + GRID_VIRTUAL_VIEWPORT_H;
  }
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

/** tree 体高：确定性树布局几何镜像（GraphTreeBody 同款深度/规模公式）。 */
function graphBodyH(payload: unknown, _w: number): number {
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
  // 盒定比例（2026-09-17）：图高由行数定（与列数解耦）——旧模型 min(w·H/W, maxH) 同 chart 病灶
  return GRAPH_PAD_V + ASSET_DERIVED.graphViewH(nodes.length);
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

/** graph 分层布局体高（GraphLayeredBody 同款几何镜像）：最长路径分层，
 *  行高 = 最宽层的节点数。空 nodes（查询式/空数据）= 「数据不可用」单行占位。 */
function graphLayeredBodyH(payload: unknown, _w: number): number {
  const p = payload as { nodes?: Array<{ id?: unknown }>; edges?: Array<{ from?: unknown; to?: unknown }> };
  const nodes = Array.isArray(p.nodes) ? p.nodes.filter((n) => typeof n?.id === 'string') : [];
  if (nodes.length === 0) return GRAPH_PAD_V + 30;
  const edges = Array.isArray(p.edges)
    ? p.edges.filter((e) => typeof e?.from === 'string' && typeof e?.to === 'string')
    : [];
  const layer = new Map<string, number>();
  for (const n of nodes) layer.set(n.id as string, 0);
  const maxPasses = edges.length + 2;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const e of edges) {
      const from = layer.get(e.from as string);
      const to = layer.get(e.to as string);
      if (from === undefined || to === undefined) continue;
      if (from + 1 > to) {
        layer.set(e.to as string, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rowsInLayer = new Map<number, number>();
  for (const l of layer.values()) rowsInLayer.set(l, (rowsInLayer.get(l) ?? 0) + 1);
  const maxRows = Math.max(...rowsInLayer.values());
  // 盒定比例（2026-09-17）：图高由行数定（与列数解耦）——旧模型 min(w·H/W, maxH) 会把
  // 「层数少」翻译成「图更小并居中缩放」（同 chart 病灶；文字被 viewBox 缩放）。
  return GRAPH_PAD_V + ASSET_DERIVED.graphViewH(maxRows);
}

/** board 体高：横排等高列（flex 行）——列高 = 列题 + Σ 卡高，取最大列。 */
function boardBodyH(p: { columns?: unknown }, w: number): number {
  const columns = Array.isArray(p.columns)
    ? p.columns.filter((c): c is Record<string, unknown> => c != null && typeof c === 'object')
    : [];
  if (columns.length === 0) return BOARD_PAD_V + PLATE_HEAD_H + 30;
  const colGapTotal = (columns.length - 1) * ASSET_TOKENS.board.colGap;
  const cardW = Math.max(60, (w - colGapTotal) / columns.length - 20); // -20 = 卡内 padding 10×2
  let maxColH = 0;
  for (const col of columns) {
    let h = BOARD_COL_RULE + 6 + BOARD_COL_TITLE_H; // 顶规线 + padding-top + 列题
    const cards = Array.isArray(col.cards)
      ? (col.cards as Array<Record<string, unknown>>).filter((c) => c != null && typeof c === 'object')
      : [];
    for (const card of cards) {
      h += BOARD_CARD_BORDER + BOARD_CARD_PAD_V + BOARD_CARD_LABEL_H + BOARD_CARD_GAP;
      const body = card.body;
      if (typeof body === 'string' && body) {
        h += measureTextHeight(body, cardW, BOARD_CARD_FONT, BOARD_CARD_BODY_H) + 2;
      }
    }
    maxColH = Math.max(maxColH, h);
  }
  // 题签恒在（2026-09-17）：看板体高含题签行（签「板」）
  return BOARD_PAD_V + PLATE_HEAD_H + maxColH;
}

/** timeline 体高：逐项时标/标题/正文实测行数 + 行距（正文宽 = w - 轨/时标 inset）。 */
function timelineBodyH(p: { items?: unknown }, w: number): number {
  const items = Array.isArray(p.items)
    ? p.items.filter((c): c is Record<string, unknown> => c != null && typeof c === 'object')
    : [];
  if (items.length === 0) return TIMELINE_PAD_V + PLATE_HEAD_H + 30;
  const mainW = Math.max(80, w - TIMELINE_INSET);
  // 题签恒在（2026-09-17）：时间轴体高含题签行
  let h = TIMELINE_PAD_V + PLATE_HEAD_H;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const ts = typeof it.ts === 'string' ? it.ts : '';
    const title = typeof it.title === 'string' ? it.title : '';
    const body = typeof it.body === 'string' ? it.body : '';
    // 行高 = max(标题行, 时标列行)；时标按其列宽换行实测
    let lineH = TIMELINE_TITLE_LINE;
    if (ts) {
      const tsLines = Math.max(
        1,
        Math.ceil(
          measureTextHeight(ts, Math.max(40, TIMELINE_TS_W), TIMELINE_TS_FONT, TIMELINE_TS_LINE) / TIMELINE_TS_LINE,
        ),
      );
      lineH = Math.max(lineH, tsLines * TIMELINE_TS_LINE);
    }
    let itemH = Math.max(lineH, TIMELINE_NODE_H);
    if (title) {
      const titleLines = Math.max(
        1,
        Math.ceil(measureTextHeight(title, mainW, TIMELINE_TITLE_FONT, TIMELINE_TITLE_LINE) / TIMELINE_TITLE_LINE),
      );
      itemH = Math.max(itemH, titleLines * TIMELINE_TITLE_LINE);
    }
    if (body) itemH += measureTextHeight(body, mainW, TIMELINE_BODY_FONT, TIMELINE_BODY_LINE) + 2;
    h += itemH + (i < items.length - 1 ? TIMELINE_ITEM_GAP : 0);
  }
  return h;
}

/** citation 体高（CitationBody 逐字镜像）：
 *  - 标题一行实测（可换行——宽标题按正文宽折行）→ 实高 = 行数 × titleLine；
 *  - 作者区：joined 文本一行（或按数组折行）实测——authors 逐条以 ", " 拼为
 *    一段（渲染端 span 流内联，折行由浏览器 auto 完成）→ 按整段实测；
 *  - venue 行：单行固定高；
 *  - ids 行：flex-wrap 自动折行——标识少时单行；多时按可用宽折行实测
 *    （按 w - 零 inset，列间距 14 由 flex column-gap 消耗——预算略高，
 *    挂载后 RO 实测兜底）；
 *  - BibTeX：summary 恒一行；展开后的 <pre> 按 bibMaxH 封顶 + bibInset。
 *  BibTeX 默认折叠（details 收起态）→ 只计 summary 行；折叠交互态由壳层
 *  RO 实测回写兜底（citation 属资产族，needsObservedHeight 恒 true）。 */
function citationBodyH(p: Record<string, unknown>, w: number): number {
  const title = typeof p.title === 'string' ? p.title : '';
  const authorsRaw = p.authors;
  const authors = Array.isArray(authorsRaw)
    ? authorsRaw.filter((a): a is string => typeof a === 'string')
    : typeof authorsRaw === 'string'
      ? [authorsRaw]
      : [];
  const venue = typeof p.venue === 'string' ? p.venue : '';
  const year = p.year != null ? String(p.year) : '';
  const hasIds = ['doi', 'pmid', 'arxiv', 'url'].some((k) => typeof p[k] === 'string' && !!p[k]);
  const bibtex = typeof p.bibtex === 'string' ? p.bibtex : '';
  const empty = !title && authors.length === 0 && !hasIds && !bibtex;
  if (empty) return CITATION_PAD_V + PLATE_HEAD_H + 30; // 「数据不可用」占位单行（题签恒在）

  let h = CITATION_PAD_V + PLATE_HEAD_H; // 题签恒在（2026-09-17）
  if (title)
    h +=
      Math.max(
        1,
        Math.ceil(measureTextHeight(title, w, CITATION_TITLE_FONT, CITATION_TITLE_LINE) / CITATION_TITLE_LINE),
      ) * CITATION_TITLE_LINE;
  if (authors.length > 0) {
    h += CITATION_AUTHOR_GAP;
    const authorText = authors.join(', ');
    h +=
      Math.max(
        1,
        Math.ceil(measureTextHeight(authorText, w, CITATION_AUTHOR_FONT, CITATION_AUTHOR_LINE) / CITATION_AUTHOR_LINE),
      ) * CITATION_AUTHOR_LINE;
  }
  if (venue || year) {
    h += CITATION_VENUE_GAP;
    h +=
      Math.max(
        1,
        Math.ceil(
          measureTextHeight(
            `${venue}${venue && year ? ' · ' : ''}${year}`,
            w,
            CITATION_VENUE_FONT,
            CITATION_VENUE_LINE,
          ) / CITATION_VENUE_LINE,
        ),
      ) * CITATION_VENUE_LINE;
  }
  if (hasIds) {
    h += CITATION_IDS_MARGIN_TOP;
    // 标识行（.pp-citation-ids flex-wrap + column-gap 14）：各标识是内联原子，
    // 折行只能发生在标识之间。静态镜像按「可宽 = w − (n−1)×14 列距」测整段
    // （宁略高不叠字；真实折行由挂载后 RO 实测回写兜底——资产族恒挂 RO）。
    const idParts: string[] = [];
    for (const k of ['doi', 'pmid', 'arxiv', 'url'] as const) {
      const v = p[k];
      if (typeof v === 'string' && v) idParts.push(v);
    }
    const idsW = Math.max(80, w - Math.max(0, idParts.length - 1) * 14);
    h +=
      Math.max(
        1,
        Math.ceil(measureTextHeight(idParts.join(' '), idsW, CITATION_IDS_FONT, CITATION_IDS_LINE) / CITATION_IDS_LINE),
      ) * CITATION_IDS_LINE;
  }
  if (bibtex) {
    // BibTeX 默认折叠：只计 summary 行 + 折叠区上规线 chrome（展开后 <pre>
    // 高度由 RO 实测兜底——citation 属资产族恒挂 RO）。
    h += CITATION_BIB_MARGIN_TOP + CITATION_BIB_TOP_CHROME + CITATION_SUMMARY_LINE;
  }
  return h;
}

/** chem 体高（ChemBody 逐字镜像）：
 *  - name 行：宋体实测（可换行——长名按正文宽折行）→ 实高 = 行数 × nameLine；
 *  - 结构区（.pp-chem-box）：**固定盒高**（boxH 含 border，CSS box-sizing:
 *    border-box）——smiles-drawer SVG 只写 viewBox，盒内 100%×100% meet 居中，
 *    盒高与分子形状无关恒为 boxH → 静态镜像精确（非媒体图那类动态高）；
 *  - meta（formula）：mono 实测（可换行）；err 静态未知（smiles 解析失败只在
 *    渲染期出现）→ 由挂载后 RO 实测兜底（chem 属资产族恒挂 RO）。 */
function chemBodyH(p: Record<string, unknown>, w: number): number {
  const name = typeof p.name === 'string' ? p.name : '';
  const formula = typeof p.formula === 'string' ? p.formula : '';
  const smiles = typeof p.smiles === 'string' ? p.smiles : '';
  const empty = !name && !formula && !smiles;
  if (empty) return CHEM_PAD_V + PLATE_HEAD_H + 30; // 「数据不可用」占位单行（题签恒在）

  let h = CHEM_PAD_V + PLATE_HEAD_H; // 题签恒在（2026-09-17）
  const hasName = name.length > 0;
  const hasBox = smiles.length > 0;
  const hasFormula = formula.length > 0;
  if (hasName) {
    h +=
      Math.max(1, Math.ceil(measureTextHeight(name, w, CHEM_NAME_FONT, CHEM_NAME_LINE) / CHEM_NAME_LINE)) *
      CHEM_NAME_LINE;
    if (hasBox || hasFormula) h += CHEM_NAME_MARGIN_B;
  }
  if (hasBox) {
    h += CHEM_BOX_H;
    if (hasFormula) h += CHEM_BOX_MARGIN_B;
  }
  if (hasFormula) {
    h +=
      Math.max(1, Math.ceil(measureTextHeight(formula, w, CHEM_META_FONT, CHEM_META_LINE) / CHEM_META_LINE)) *
      CHEM_META_LINE;
  }
  return h;
}

/** 资产/开放 kind 块体高（按表现原语分派；无注册表现 → JSON 兜底视图）。 */
function measureAssetBlockHeight(b: SourcedBlock): number {
  const pres = assetPresentationOf(b);
  const p = b.payload;
  switch (pres) {
    case 'media':
      return mediaBodyH(p as { ext?: unknown; filePath?: unknown });
    case 'chart':
      // D9：传完整 payload（含 config）——title/轴名会改变块高，旧签名丢 config 会算错
      return chartBodyH(p as { type?: unknown; data?: unknown; config?: unknown }, b.w);
    case 'interactive':
      // ECharts 交互图（科研渲染 #16）：type 行 + 固定盒高（ECharts 图在盒内
      // canvas 自绘，图例/轴都在盒内不占盒外行）——盒高恒定镜像精确；
      // canvas 实际绘制若有差异由挂载后 RO 实测兜底（资产族恒挂 RO）。
      return CHART_PAD_V + CHART_TYPE_H + CHART_INTERACTIVE_BOX_H;
    case 'metric':
      return metricBodyH(p as { items?: unknown; caption?: unknown }, b.w);
    case 'grid':
      return gridBodyH(p as { columns?: unknown; rows?: unknown; caption?: unknown }, b.w);
    case 'graph':
      return graphLayeredBodyH(p, b.w);
    case 'tree':
      return graphBodyH(p, b.w);
    case 'board':
      return boardBodyH(p as { columns?: unknown }, b.w);
    case 'timeline':
      return timelineBodyH(p as { items?: unknown }, b.w);
    case 'html':
      return HTML_BODY_PAD_V + PLATE_HEAD_H + HTML_FRAME_DEFAULT_H; // 题签恒在（2026-09-17）
    case 'form':
      return formBodyH(p as { title?: unknown; body?: unknown; options?: unknown }, b.w);
    case 'citation':
      return citationBodyH(p as Record<string, unknown>, b.w);
    case 'chem':
      return chemBodyH(p as Record<string, unknown>, b.w);
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
 * 收敛改为壳层去抖一次触发；首报后值再变（媒体图加载等动态高）才即时通知。
 *
 * 2026-09-19 渲染态签名（夹注叠字批）：记录带**渲染态键**（见 renderStateKey）——
 * 同一块 id 在不同渲染态（折叠/展开、眉批折/展、流/钉）下是两个不同的盒子，
 * 而 RO 只报「当前那个盒子的尺寸」。旧实现只按 (id, w) 认记录 ⇒ 折叠态翻转后
 * 的第一帧吃到另一态的读数（44.97 的折叠高喂给展开态 = 整块高度差一个量级、
 * 下一块直接压在正文上）。带签名后旧读数自然作废，走静态镜像兜一帧。 */

interface ObservedHeight {
  w: number;
  h: number;
  /** 渲染态键（renderStateKey 产出）——同键才算同一种盒子。 */
  key: string;
  /** 眉批栏 extent（块顶起算，含 top 与折叠钮行）——**出流子件**的实测高，
   *  由壳层对 `.pp-marginalia` 的 RO 单独上报（见 reportObservedSidecarExtent）。 */
  sc?: number;
}

const observedHeights = new Map<string, ObservedHeight>();
const observedListeners = new Set<() => void>();

/** RO 实测回写结果：registered=首报/换宽校准登记（不触发布局重排）/
 *  changed=挂载后值变（动态高，立即重排）/ restated=渲染态翻转（立即重排）/
 *  unchanged=同值（无变化）。 */
export type ObservedReport = 'registered' | 'changed' | 'restated' | 'unchanged';

/** 渲染态键：同 id 的块在**哪一种盒子**里被量（决定高度的渲染态维度）。
 *  只有三件：钉住态（纸内白边 + 报头是钉住独有）、折叠态（夹注/脚注/程文的
 *  展开与收起是两个高度）、眉批态（`:sc` 移出后眉批栏只剩一行占位）。
 *  形状 `{state}|f{0/1}s{0/1}o{0/1}`——**自描述**（同键才算同一种盒子）。
 *  文本增长不在键里——那是 `changed` 的路（值变即立即重排），入键会让每次
 *  流式加行都变成「新记录」，实测表无界增长且首报去抖把即时性也吞掉。
 *  两侧必须同源：壳层写进 data-block-observed 的是本函数与 id 的复合串。 */
export function renderStateKey(b: SourcedBlock, folded: boolean, sidecarFolded: boolean, sidecarOut: boolean): string {
  return `${b.state}|f${folded ? 1 : 0}s${sidecarFolded ? 1 : 0}o${sidecarOut ? 1 : 0}`;
}

/** 块实测观测键（壳层 data-block-observed 的值 = 本函数产出）。格式
 *  `{块 id}|{渲染态}`——**格式只此一处**（拆解见 splitObservedKey，壳层不解析）。 */
export function observedKeyOf(b: SourcedBlock, folded: boolean, sidecarFolded: boolean, sidecarOut: boolean): string {
  return `${b.id}|${renderStateKey(b, folded, sidecarFolded, sidecarOut)}`;
}

/** 观测键拆解（块 id / 渲染态）。块 id 不含 `|`（pb:msg:idx 形状），取**首个**
 *  分隔符即 id 边界（渲染态自身含 `|`，见 renderStateKey）；无分隔符（裸 id）
 *  按无态处理。 */
export function splitObservedKey(key: string): [string, string] {
  const i = key.indexOf('|');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
}

/** 壳层 RO 实测回写（世界单位 = CSS px——RO 读布局盒，transform 缩放不影响）。
 *  observedKey（observedKeyOf 产出）里的渲染态必须与记录时一致才认账——见文件头
 *  2026-09-19 条。
 *  无记录或宽度变化 = 首报：登记不通知（校准登记——收敛由壳层去抖一次触发，
 *  避免滚动挂载逐卡脉冲式全局重排）；同宽换态 = 用户手势刚落（折叠翻转），
 *  立即通知重排（等去抖会看见块错位一瞬）；同态值变 = 动态高（媒体图加载/
 *  iframe 上报/拟策反馈框展开/流式长高），立即通知。 */
export function reportObservedBlockHeight(observedKey: string, w: number, h: number): ObservedReport {
  const rec = Math.ceil(h);
  const [blockId, key] = splitObservedKey(observedKey);
  const prev = observedHeights.get(blockId);
  if (prev && prev.w === w && prev.key === key) {
    if (prev.h === rec) return 'unchanged';
    observedHeights.set(blockId, { w, h: rec, key });
    notifyObserved();
    return 'changed';
  }
  observedHeights.set(blockId, { w, h: rec, key });
  if (prev && prev.w === w) {
    notifyObserved();
    return 'restated';
  }
  return 'registered';
}

/** 有效实测高（记录宽与块宽一致**且渲染态同键**才有效——钉住改宽/折叠翻转后
 *  旧实测作废待重报，见 renderStateKey 头注）。 */
export function observedBlockHeightOf(observedKey: string, w: number): number | undefined {
  const [blockId, key] = splitObservedKey(observedKey);
  const rec = observedHeights.get(blockId);
  return rec && rec.w === w && rec.key === key ? rec.h : undefined;
}

/** 眉批栏 extent 实测回写（壳层对 `.pp-marginalia` 的 RO 单独上报）。
 *  眉批栏是**绝对定位的出流件**——块的边框盒装不下它，块级 RO 报不出这份高；
 *  而块高按设计 = max(正文, 眉批 extent)（眉批恒容于块高，见 measureMarkdownBody）。
 *  真机实测（真会话 40 组配对 × 四态）：静态镜像的 228px 窄列折行估计比 DOM 短
 *  最多 218.75px，眉批尾巴整段越出块高。此上报与块级记录同键同宽（渲染态翻转
 *  一并作废），消费端取 max（见 measureBlockHeightCached）。 */
export function reportObservedSidecarExtent(observedKey: string, extent: number): void {
  const [blockId, key] = splitObservedKey(observedKey);
  const rec = observedHeights.get(blockId);
  const sc = Math.ceil(extent);
  if (!rec || rec.key !== key) {
    // 块级记录未到（同帧内先后不定）：先登记半条（w=0 ⇒ 块级查询不认，安全）
    observedHeights.set(blockId, { w: 0, h: 0, key, sc });
    return;
  }
  if (rec.sc === sc) return;
  observedHeights.set(blockId, { ...rec, sc });
  notifyObserved();
}

/** 眉批栏 extent 实测（同键才有效；未上报过 = undefined，消费端回落静态镜像）。 */
export function observedSidecarExtentOf(observedKey: string): number | undefined {
  const [blockId, key] = splitObservedKey(observedKey);
  const rec = observedHeights.get(blockId);
  return rec && rec.key === key ? rec.sc : undefined;
}

function notifyObserved(): void {
  for (const fn of observedListeners) fn();
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
  'subagent',
  'notice',
]);

/** 壳层观察判据（与上方实测优先家族同源——只挂 RO 不回写是白挂）。
 *  text（2026-09 科研数学）：含公式的 markdown 块也挂 RO——公式高取决于
 *  KaTeX 结构（分式/矩阵/求和堆叠）无法从源码可靠静态镜像，挂载后实测回写。
 *  表格（2026-09 表格叠字修复）：auto 布局列宽分布取决于字形度量——均分
 *  假设只能近似（偏高方向安全），挂载后 RO 实测回写精确化（同公式先例）。
 *
 *  夹注 reasoning（2026-09-19 夹注叠字批，真机报「夹注展开常与脚注叠字」）：
 *  **唯一无封顶的自由散文**文类——canvas 折行（pretext）与 DOM 折行在
 *  「半角标点 + 拉丁/汉字」处每行可差 0.1~1.2px（真 Chrome 逐字对拍实证：`,C`
 *  一步 DOM 比 canvas 宽 0.518px、`,X` 窄 0.115px；`text-autospace` 已钉死
 *  no-autospace，残余是引擎内部度量差，CSS 侧无可关的开关——text-rendering/
 *  font-kerning/ligatures/font-feature-settings/text-spacing-trim 逐条试过皆无效）。
 *  长夹注（本仓真会话实测 1000~1700 行）逐行累积 ⇒ 折行点翻转 ⇒ DOM 行数与
 *  测高行数差 ±1~6 行。936 条真夹注实测：253 条（27%）块高有差，其中 14 条 DOM
 *  更高（最大 +49px > 单元内间距 32px ⇒ 末行压到下一块脚注上 = 叠字 17.94px），
 *  239 条 DOM 更矮（最大 −153px = 幻影空档）。对拍另证脚注侧 468 次零偏差
 *  （工具卡载荷段全部封顶，误差无处累积）——这就是「为什么总是夹注压脚注」。
 *  静态镜像对这一族结构性失明 ⇒ 挂 RO 实测（补丁后同语料复算：叠字 0 块）。
 *
 *  正文 markdown / 抄录 diff（2026-09-19 第二批实测）：同一把失明的尺子。
 *  真会话对拍——正文 163 条里 27 条（17%）块高有差（正方向最大 +34px = 整一行；
 *  负方向最大 −85px = 2.5 行幻影空档）；抄录 36 条里 4 条（11%，全为负方向
 *  ≤−30px）。⇒ 一并入族。
 *  **不入族**者亦有实测依据：来文 user 60/60 零偏差（题签/花押是定值 chrome，
 *  正文短）；工具 tool / 程文 code 载荷段全部封顶（468/468 零偏差）；工具组/
 *  子代理头是恒高结构块（一行注线 + 折叠行）。省下的 RO 目标是虚拟化窗口里
 *  数量最多的一批。 */
export function needsObservedHeight(kind: BlockKind, hasAsset: boolean): boolean {
  if (hasAsset || kind === 'plan' || !BUILTIN_MEASURE_KINDS.has(kind)) return true;
  return kind === 'reasoning' || kind === 'markdown' || kind === 'diff';
}

/** 测试复位（生产不调用）。 */
export function clearObservedBlockHeights(): void {
  observedHeights.clear();
}

/** 会话销毁/工作区重置时清理实测残留（2026-09-03 撞号污染修复）：
 *  实测表是模块级、跨会话存活——会话 store 拆除后旧实测记录若不清，
 *  后续块 id 复用（合卷重摊开/跨工作区撞号）会无条件吃旧实测高
 *  （实测优先无签名守卫），导致布局错乱（块消失/压扁/打碎）。
 *  与 disposeSessionMessagesStore/disposeMessagesStores 同步调用。 */
export function clearObservedHeightsForSession(): void {
  observedHeights.clear();
}

/** 来文附图缩略行高（B4 D-9）：wrap 行几何的纯函数镜像——渲染侧
 *  .pp-user-images flex-wrap 同一公式（perRow tile + (perRow-1) gap ≤ 宽），
 *  rows × thumb + (rows-1) gap + 上距。宽不足一 tile 时至少单列（钉住窄块防零除）。 */
export function userImagesRowHeight(count: number, width: number): number {
  if (count <= 0) return 0;
  const perRow = Math.max(1, Math.floor((width + USER_IMAGE_GAP) / (USER_IMAGE_THUMB + USER_IMAGE_GAP)));
  const rows = Math.ceil(count / perRow);
  return USER_IMAGES_MARGIN_TOP + rows * USER_IMAGE_THUMB + (rows - 1) * USER_IMAGE_GAP;
}

/** 来文测高（P3 2026-08-30）：含圈点候选（【】）的文本按行拆解（pre-wrap 硬
 *  换行语义），逐行走 rich 精确——圈点段 = 原子件 + CIRCLE_EXTRA 横向 chrome，
 *  其余段 = 来文手迹位；空行仍占一行。纯文本（无【】）保持旧路整体 layout。 */
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

/** 单个文本源 → 墨条几何输入。cap = 行条数上限（镜像测量端的封顶高度）。
 *
 *  y（2026-09-20 墨迹几何重做）：**源顶距块顶的纵向偏移（世界单位）**——必填，
 *  由测高走查在算高的同时产出（见 measureMdBlocks/markdownInkSources）。
 *  旧实现让 ink.ts 自己「逐源累加行高、源间零间距」重建纵向几何，于是段落
 *  margin(14)/列表项 liGap(6)/标题 pt·pb/引用·代码内距全部丢失——误差逐元素
 *  累加，实测一个 478px 的 markdown 块在越 LOD 阈时正文整体上移 68px（用户报
 *  「文字位置跳变」的直接病灶）。纵向位置现在只有**一个**产出者：测高走查。 */
export interface InkSource {
  text: string;
  font: string;
  lineHeight: number;
  /** 横向内缩（世界单位——墨条起点 = 块左缘 + inset） */
  inset: number;
  /** 纵向偏移（世界单位——源顶距块顶，含块级 chrome 与元素间间距） */
  y: number;
  /** 行条上限（pre/output 族按 PRE_MAX_H/OUT 族镜像，缺省不封顶） */
  cap?: number;
  /** 富行内片段（2026-09-20 富行内折行批）：**仅当测高走查走的是富行内路径**
   *  （`mdHasRichInline(inl)`）时在场——加粗/斜体/行内码/行内公式的字体与字宽
   *  与纯文本不同，按 text 走查会得到与 DOM 不同的折行点。在场时墨迹改走
   *  `walkRichInlineLineRanges` 逐片段落墨（片段各自字体直绘），折行点与
   *  测高（measureRichItemsHeight）**同一把尺子**。 */
  rich?: RichInlineItem[];
}

/** 把一组墨源整体下移 dy（块级 chrome：题签/花押/折叠行/段头/语言行）。 */
function inkShifted(sources: InkSource[], dy: number): InkSource[] {
  return dy === 0 ? sources : sources.map((s) => ({ ...s, y: s.y + dy }));
}

/* ── 眉批栏（P5 夹注旁注化）——.pp-marginalia 镜像：块右缘 24px 起、总宽 240，
 * 左规线 2 + padding 10 → 内容宽 228；字体沿用夹注族（13.5px/1.85 石墨）。
 * 纵向 chrome（top / 折叠钮行 / 占位行）同源 CHROME_DERIVED（2026-09-19 补）。 ── */
export const MARGINALIA_W = CHROME_DERIVED.marginaliaW;
export const MARGINALIA_INSET = CHROME_DERIVED.marginaliaInset;
export const MARGINALIA_TOP = CHROME_DERIVED.marginaliaTop;
export const MARGINALIA_TOGGLE_H = CHROME_DERIVED.marginaliaToggleH;
export const MARGINALIA_OUT_H = CHROME_DERIVED.marginaliaOutH;

export function inkSourcesFor(b: SourcedBlock, folded: boolean): InkSource[] {
  const p = b.payload as PayloadLike;
  switch (b.kind) {
    case 'user':
      // 圈点行宽差 ≤ 椭圆 chrome 量级——远缩墨条按纯文本即可（LOD 抽象层）
      // 纵向：正文在题签区之下（USER_KIND_H——来文块顶到正文顶）。
      return p.text && !folded
        ? [
            {
              text: p.text,
              font: PAPER_USER_FONT,
              lineHeight: PAPER_USER_LINE_HEIGHT,
              inset: USER_TEXT_INSET,
              y: USER_KIND_H,
            },
          ]
        : [];
    case 'markdown':
      return p.text ? markdownInkSources(p.text, b.w) : [];
    case 'reasoning':
      // 折叠行（「▸ 思考 N 字」）恒在正文之上：展开 = FOLD_ROW_H，折叠预览 = 同高一行。
      return p.text && !folded
        ? [
            {
              text: p.text,
              font: PAPER_REASONING_FONT,
              lineHeight: PAPER_REASONING_LINE_HEIGHT,
              inset: REASONING_TEXT_INSET,
              y: FOLD_ROW_H,
            },
          ]
        : [];
    case 'notice':
      return p.text
        ? [
            {
              text: p.text,
              font: PAPER_NOTICE_FONT,
              lineHeight: PAPER_NOTICE_LINE_HEIGHT,
              inset: NOTICE_TEXT_INSET,
              y: NOTICE_TEXT_PAD_V,
            },
          ]
        : [];
    case 'turn-error':
      return p.text
        ? [
            {
              text: p.text,
              font: PAPER_NOTICE_FONT,
              lineHeight: PAPER_NOTICE_LINE_HEIGHT,
              inset: NOTICE_TEXT_INSET,
              y: NOTICE_TEXT_PAD_V,
            },
          ]
        : [];
    case 'diff':
      // 语言行（.pp-lang）在 pre 之上；pre 自带上下内距。
      return p.text
        ? inkShifted(
            [
              {
                text: p.text,
                font: PAPER_MONO_FONT,
                lineHeight: PAPER_MONO_LINE_HEIGHT,
                inset: DIFF_TEXT_INSET,
                y: 0,
                cap: Math.floor(PRE_MAX_H / PAPER_MONO_LINE_HEIGHT),
              },
            ],
            ((b.payload as { lang?: string }).lang ? DIFF_LANG_H : 0) + DIFF_PRE_PAD_V,
          )
        : [];
    case 'tool': {
      if (folded) return [];
      // 段头（.pp-sec-head 恒一行）在每段之上；首段紧跟折叠行（无上距）。
      // 逐段推进游标：段高 = 段头 + 内容高（+ 非首段的段头上距）——与
      // measureBlockHeight 的 argsH/outH/errH 同款累加，两处逐字对齐。
      const out: InkSource[] = [];
      let y = TOOL_PAD_TOP + FOLD_ROW_H;
      const showArgs = hasArgsToShow(p.args);
      const showOut = hasPayloadToShow(p.output);
      const showErr = hasPayloadToShow(p.err);
      if (showArgs) {
        const text = toolDisplay(p.args).text;
        out.push({
          text,
          font: PAPER_TOOL_FONT,
          lineHeight: PAPER_TOOL_LINE_HEIGHT,
          inset: 0,
          y: y + SEC_HEAD_H,
          cap: Math.floor(PRE_MAX_H / PAPER_TOOL_LINE_HEIGHT),
        });
        y += SEC_HEAD_H + cappedH(text, b.w, PAPER_TOOL_FONT, PAPER_TOOL_LINE_HEIGHT, PRE_MAX_H);
      }
      if (showOut) {
        const text = toolDisplay(p.output).text;
        out.push({
          text,
          font: PAPER_OUT_FONT,
          lineHeight: PAPER_OUT_LINE_HEIGHT,
          inset: 0,
          y: y + SEC_HEAD_H + (showArgs ? SEC_HEAD_GAP : 0),
          cap: Math.floor(OUT_MAX_H / PAPER_OUT_LINE_HEIGHT),
        });
        y +=
          SEC_HEAD_H +
          (showArgs ? SEC_HEAD_GAP : 0) +
          cappedH(text, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, OUT_MAX_H);
      }
      if (showErr) {
        out.push({
          text: toolDisplay(p.err).text,
          font: PAPER_OUT_FONT,
          lineHeight: PAPER_OUT_LINE_HEIGHT,
          inset: 0,
          y: y + SEC_HEAD_H + (showArgs || showOut ? SEC_HEAD_GAP : 0),
          cap: Math.floor(OUT_MAX_H / PAPER_OUT_LINE_HEIGHT),
        });
      }
      return out;
    }
    case 'code': {
      if (folded) return [];
      const out: InkSource[] = [];
      let y = TOOL_PAD_TOP + FOLD_ROW_H;
      const src = (b.payload as { code?: string }).code ?? p.args ?? '';
      const secs = codeOutSections(p);
      if (src) {
        out.push({
          text: src,
          font: PAPER_TOOL_FONT,
          lineHeight: PAPER_TOOL_LINE_HEIGHT,
          inset: CODE_SRC_INSET,
          y: y + SEC_HEAD_H + CODE_SRC_PAD_V,
          cap: Math.floor((CODE_SRC_MAX_H - CODE_SRC_PAD_V) / PAPER_TOOL_LINE_HEIGHT),
        });
        y += SEC_HEAD_H + codeSrcH(src, b.w);
      }
      secs.forEach((sec, i) => {
        const gap = src || i > 0 ? SEC_HEAD_GAP : 0;
        out.push({
          text: sec.text,
          font: PAPER_OUT_FONT,
          lineHeight: PAPER_OUT_LINE_HEIGHT,
          inset: 0,
          y: y + SEC_HEAD_H + gap,
          cap: Math.floor(CODE_OUT_TEXT_MAX / PAPER_OUT_LINE_HEIGHT),
        });
        y += SEC_HEAD_H + gap + cappedH(sec.text, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, CODE_OUT_TEXT_MAX);
      });
      return out;
    }
    case 'plan': {
      // 拟策内容 = markdown 体（2026-09-10 渲染专项）：墨迹走 markdown 同一
      // 走查（p/h/列表项/围栏码逐款），内缩 = 策面横向 chrome、纵向下移
      // 策面内距 + 标题行（.pp-pc-head 恒在正文之上）。
      const content = p.content ?? '';
      if (!content) return [];
      const plan = b.payload as { title?: string };
      const headH =
        measureTextHeight(plan.title || '拟策', b.w - PLAN_TEXT_INSET, PLAN_TITLE_FONT, PLAN_TITLE_LINE_HEIGHT) +
        PLAN_HEAD_MARGIN;
      return markdownInkSources(content, b.w - PLAN_TEXT_INSET, PLAN_TEXT_INSET, PLAN_CHROME_H + headH);
    }
    default:
      return []; // 资产/开放 kind：远缩画外框即可（无行条）
  }
}

/** markdown 文本 → 墨迹源（**走测高走查**，不再另起一套平行走查）。
 *
 *  墨迹几何重做（2026-09-20）：旧实现是 parseMarkdown 的第二趟走查，只推
 *  行宽与行距、源间零间距——与测高走查各自演化，纵向 chrome 全丢（病灶见
 *  InkSource.y 注）。现在直接消费 measureMdBlocks 的产出：墨迹 y 与块高同源。
 *
 *  w 必须是**该 markdown 体的实际测宽**（正文块 b.w；拟策体 b.w - 策面内缩）
 *  ——走查要按它算行数，行数决定每个元素的占高、进而决定后续元素的 y。
 *  inset0 = 该体的横向内缩（正文块 0；拟策体策面内缩），进每个墨源的 x 起点。 */
function markdownInkSources(text: string, w: number, inset0 = 0, y0 = 0): InkSource[] {
  return measureMdBlocks(parseMarkdown(text), w, y0, inset0).ink;
}

/** 程文（code）块的分段输出（2026-09-19 换代）：信封段（日志/完成值/错误）
 *  + executor 级错误段。段序 = 信封出现序；段数决定段头与 gap 的累加。
 *  **单一入口**：inkSourcesFor（墨迹 y）与 measureBlockHeight（块高）两处镜像
 *  共用——渲染端 CodeBody 消费同一 codeDisplay（三段逐字对齐）。 */
function codeOutSections(p: { output?: string; err?: string }): Array<{ kind: string; text: string }> {
  const secs = codeDisplay(p.output).map((s) => ({ kind: s.kind, text: s.display.text }));
  if (hasPayloadToShow(p.err)) secs.push({ kind: 'error', text: toolDisplay(p.err).text });
  return secs;
}

/* ── markdown 块测量（渲染 MarkdownBody 的逐字镜像——消费同一 parseMarkdown 模型）── */

function tableRowH(cells: MdInline[][], cols: number, w: number): number {
  const colW = Math.max(40, w / cols - MD_TABLE_CELL_PAD);
  let linesH = 0;
  for (const cell of cells)
    linesH = Math.max(linesH, measureInlineHeight(cell, colW, MD_TABLE_SIZE, MONO_STACK, MD_TABLE_LINE_HEIGHT));
  return linesH + MD_TABLE_CELL_PAD_V + MD_TABLE_ROW_BORDER;
}

/** 单个 markdown 元素的高度 + 其墨源（**同一趟走查产出**）。
 *
 *  墨迹几何重做（2026-09-20）：旧实现让 paper/ink 自己「逐源累加行高、源间零
 *  间距」重建纵向几何，于是本函数里所有的纵向 chrome——p 的 margin(14)、li 的
 *  liGap(6)、标题 pt·pb、quote/code 上下内距——在墨迹里全部丢失，误差逐元素
 *  累加（实测 478px 的块越 LOD 阈时正文上移 68px）。现在纵向位置与高度出自同
 *  一趟走查：墨迹 y 与 DOM 几何**结构上不可能漂**（同一个 token、同一次累加）。
 *
 *  y0 = 本元素顶距块顶的纵向偏移；inset0 = 本元素的横向内缩（父级累积）。
 *  子块宽度 = w（调用方已按父级内缩扣过），子块 inset = inset0 + 本级内缩。 */
function measureMdElement(
  el: MdBlock,
  w: number,
  last: boolean,
  y0: number,
  inset0: number,
): { h: number; ink: InkSource[] } {
  const none = { h: 0, ink: [] as InkSource[] };
  /** 纯文本墨源（正文族/标题族共用：走查产出的 y 即元素顶 + 元素内上距）。
   *  富行内（加粗/斜体/行内码/行内公式）随源带出 rich 片段——墨迹逐片段直绘，
   *  折行点与 measureInlineHeight 的富行内路径同源（mdRichItems 同一构造）。 */
  const piece = (inl: MdInline[], size: number, lh: number, y: number, inset: number): InkSource[] => {
    const text = mdPlainText(inl);
    if (text.length === 0) return [];
    const rich = mdHasRichInline(inl) ? mdRichItems(inl, size, SONG_STACK) : undefined;
    return [{ text, font: `${size}px ${SONG_STACK}`, lineHeight: lh, inset, y, rich }];
  };
  switch (el.t) {
    case 'p': {
      const h = measureInlineHeight(el.inl, w, BODY_SIZE, SONG_STACK, PAPER_BODY_LINE_HEIGHT);
      if (!el.inl.length || mdPlainText(el.inl).length === 0) return none;
      return { h: h + (last ? 0 : MD_P_GAP), ink: piece(el.inl, BODY_SIZE, PAPER_BODY_LINE_HEIGHT, y0, inset0) };
    }
    case 'h': {
      const c = MD_H[el.lv - 1];
      const lh = cssUsedPx(c.size * c.lh);
      // 标题：padding-top 把文字压低（DOM 同款——pt 在文字之上、pb 之下）。
      return {
        h: c.pt + measureInlineHeight(el.inl, w, c.size, SONG_STACK, lh) + c.pb,
        ink: piece(el.inl, c.size, lh, y0 + c.pt, inset0),
      };
    }
    case 'list': {
      let items = 0;
      let iy = y0;
      const ink: InkSource[] = [];
      for (const it of el.items) {
        let ih = measureInlineHeight(it.inl, w - MD_LI_INDENT, BODY_SIZE, SONG_STACK, PAPER_BODY_LINE_HEIGHT);
        // 纯复选框项（- [ ] 无尾文）：li 仍占一行正文高（框是 absolute 不占行盒——
        // 无文字时给最小行高，否则零高压叠下一块）
        if (ih === 0 && it.check !== undefined) ih = PAPER_BODY_LINE_HEIGHT;
        // 项文字左缘 = li 内容左缘 = 列表左缘 + liIndent（DOM .pp-md-li padding-left）。
        ink.push(...piece(it.inl, BODY_SIZE, PAPER_BODY_LINE_HEIGHT, iy, inset0 + MD_LI_INDENT));
        let subY = iy + ih;
        if (it.sub) {
          const sub = measureMdBlocks(
            it.sub,
            w - MD_LI_INDENT - MD_SUB_INDENT,
            subY + MD_SUB_TOP,
            inset0 + MD_LI_INDENT + MD_SUB_INDENT,
          );
          ih += MD_SUB_TOP + sub.h;
          ink.push(...sub.ink);
        }
        subY = iy + ih + MD_LI_GAP;
        items += ih + MD_LI_GAP;
        iy = subY;
      }
      items = Math.max(0, items - MD_LI_GAP); // 末项 li margin-bottom 0（:last-child）
      return { h: items + (last ? 0 : MD_LIST_GAP), ink };
    }
    case 'quote': {
      // 引用：上下内距把内容压低、左内距缩进（DOM .pp-md-quote padding/border）。
      const sub = measureMdBlocks(el.blocks, w - MD_QUOTE_INSET, y0 + MD_QUOTE_PAD_V, inset0 + MD_QUOTE_INSET);
      return { h: MD_QUOTE_PAD_V + sub.h + (last ? 0 : MD_QUOTE_GAP), ink: sub.ink };
    }
    case 'code': {
      if (!el.text) return none;
      const h = cappedH(el.text, w - MD_CODE_INSET, PAPER_MONO_FONT, PAPER_MONO_LINE_HEIGHT, PRE_MAX_H);
      return {
        h: MD_CODE_PAD_V + h + (last ? 0 : MD_CODE_GAP),
        ink: [
          {
            text: el.text,
            font: PAPER_MONO_FONT,
            lineHeight: PAPER_MONO_LINE_HEIGHT,
            inset: inset0 + MD_CODE_INSET,
            y: y0 + MD_CODE_PAD_V,
            cap: Math.floor(PRE_MAX_H / PAPER_MONO_LINE_HEIGHT),
          },
        ],
      };
    }
    case 'math': {
      // 块级公式静态预算（虚拟化未挂载窗口估高；挂载后 RO 实测优先）。
      // 预算 = 源码显式行数（截 maxLines 防长公式无限膨胀）× 正文行高 ×
      // display 行高系数。单行短公式（无换行）= 1 × 34 × 2.2 ≈ 75px，
      // 覆盖 KaTeX display margin（上下 1em）+ glyph 区，安全方向高估。
      if (!el.text) return none;
      const explicitLines = el.text.split('\n').length;
      const lines = Math.min(explicitLines, MD_MATH_DISPLAY_MAX_LINES);
      const h = lines * PAPER_BODY_LINE_HEIGHT * MD_MATH_DISPLAY_LINE_H;
      // 公式墨迹：源文本当正文行条（远缩只求「这里有内容」的痕迹）——行高按预算。
      return {
        h: h + (last ? 0 : MD_MATH_GAP),
        ink: [
          {
            text: el.text.slice(0, 160),
            font: `${BODY_SIZE}px ${SONG_STACK}`,
            lineHeight: PAPER_BODY_LINE_HEIGHT * MD_MATH_DISPLAY_LINE_H,
            inset: inset0,
            y: y0,
          },
        ],
      };
    }
    case 'hr':
      return { h: last ? MD_HR_LAST_H : MD_HR_H, ink: [] };
    case 'img':
      // 固定盒（B4 D-9）：高度与加载态解耦——静态镜像即精确，无 RO 面需求
      return { h: MD_IMG_BOX_H + (last ? 0 : MD_IMG_GAP), ink: [] };
    case 'table': {
      // 列数 = 表头格数（GFM 列真源）；行格数异常（多于/少于表头）取 max 防呆。
      // 2026-09 表格叠字修复：旧 cols 取「单元格内联段数 max」——单段格行退化
      // 为 cols=1，每格按全宽测高，实际按 w/cols 渲染 → 测高严重偏矮 → 后续
      // 块 transform 绝对定位压进表格区（纸面表格字体重叠的直接根因）。列宽
      // 均分仍是浏览器 auto 布局的近似——偏高方向安全（phantom gap 不叠字），
      // 含表格的 markdown 挂载后 RO 实测回写精确化（needsObservedHeight，
      // 同公式先例）。
      const cols = Math.max(1, el.head.length, ...el.rows.map((r) => r.length));
      // 墨迹逐行落位（旧实现把整表当一串行、行距用单元格行高——表格是多行结构，
      // 行位必须逐行给）：行高 = 该行最高单元格行盒 + 上下内距 + 行底规线。
      // 行高**只算一次**（测高与墨迹 y 共用同一份读数——重算会让每格多跑一次
      // layout，既是性能浪费也让「测高 = 墨迹」的同源关系变松）。
      const ink: InkSource[] = [];
      const allRows = [el.head, ...el.rows];
      const rowHs = allRows.map((r) => tableRowH(r, cols, w));
      let ry = y0;
      let h = 0;
      for (let i = 0; i < allRows.length; i++) {
        ink.push({
          text: allRows[i].map((c) => mdPlainText(c)).join(' '),
          font: `${MD_TABLE_SIZE}px ${MONO_STACK}`,
          lineHeight: MD_TABLE_LINE_HEIGHT,
          inset: inset0,
          y: ry + MD_TABLE_CELL_PAD_V / 2,
        });
        h += rowHs[i];
        ry += rowHs[i];
      }
      return { h: h + (last ? 0 : MD_TABLE_GAP), ink };
    }
  }
}

/** markdown 块序列：总高 + 各元素墨源（同一趟走查——纵向几何单一产出者）。
 *  y0/inset0 = 本序列起点的纵向偏移 / 横向内缩（父级累积，顶层均 0）。
 *  高度语义与旧版逐字一致（墨迹重做不动测高：只多带出一份 y）。 */
export function measureMdBlocks(blocks: MdBlock[], w: number, y0 = 0, inset0 = 0): { h: number; ink: InkSource[] } {
  let total = 0;
  let y = y0;
  const ink: InkSource[] = [];
  for (let k = 0; k < blocks.length; k++) {
    const r = measureMdElement(blocks[k], w, k === blocks.length - 1, y, inset0);
    total += r.h;
    y += r.h;
    ink.push(...r.ink);
  }
  return { h: total, ink };
}

/** markdown 块体高（渲染 MarkdownBody 的逐字镜像——消费同一结构模型）。
 *  blocks 由调用方解析（全量 parseMarkdown 或增量 parseMarkdownIncremental）
 *  ——增量路径复用同函数，测量与渲染共用单一解析的纪律不变。
 *  sidecarOut（2026-08-31 移出语义）：`:sc` 快照钉在画布上时眉批栏只剩占位
 *  一行（.pp-marginalia-out）——按占位行实高计（真机实测 19px = 上下内距 2×2
 *  + 上下规线 1×2 + 行盒 13）。
 *  2026-09-19（夹注叠字批）：眉批栏纵向 chrome 补齐——extent = top + 栏高，
 *  栏高 = 文字高 + 折叠钮行（16px）/ 或只剩钮行 / 或占位行。旧实现只算文字高，
 *  真机实测越出块高最多 218.75px（长夹注在 228px 窄列里折行分歧被放大；其中
 *  约 15px 是这段 chrome 的确定项）。挂载后另有实测 extent 兜底（observedSidecarExtentOf）。 */
function measureMarkdownBody(blocks: MdBlock[], b: SourcedBlock, sidecarFolded = false, sidecarOut = false): number {
  const bodyH = measureMdBlocks(blocks, b.w).h;
  // P5 眉批化：夹注挂侧栏（.pp-marginalia）——复合块高 = max(正文@全宽,
  // 眉批@侧栏内容宽+纵向 chrome)。眉批恒容于块高内 → 栈几何零变化（方案甲的决定性
  // 优势，见 pretext-typography-plan §三）。折叠态（夹注恒折拍板）只占一行。
  const sidecar = (b.payload as { sidecar?: { text: string } }).sidecar;
  if (!sidecar?.text) return bodyH;
  const noteH =
    sidecarOut || sidecarFolded
      ? MARGINALIA_TOP + (sidecarOut ? MARGINALIA_OUT_H : MARGINALIA_TOGGLE_H)
      : MARGINALIA_TOP +
        measureTextHeight(
          sidecar.text,
          MARGINALIA_W - MARGINALIA_INSET,
          PAPER_REASONING_FONT,
          PAPER_REASONING_LINE_HEIGHT,
        ) +
        MARGINALIA_TOGGLE_H;
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
      // 附图缩略行（B4 D-9）：64px 方界 tile + wrap——rows 由块宽整除推得
      // （渲染 .pp-user-images flex-wrap 同几何；两处共用 token）
      const images = (b.payload as { images?: unknown[] }).images;
      const imagesH = images?.length ? userImagesRowHeight(images.length, b.w - USER_TEXT_INSET) : 0;
      // 题签（2026-08-30 标题化）+ asterism（B1）恒加：题签置顶、花押收尾
      return USER_KIND_H + textH + filesH + imagesH + USER_ASTERISM_H;
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
      // 折叠机制（fold.ts 同款规则镜像）：折叠态只留折叠行——参数/输出/错误全收。
      // F1（2026-09-01 三轴审计）：空/无意义参数（`{}` 骨架）渲染端不画 → 测高镜像同判据。
      // 2026-09-14 工具卡可读性专项：载荷走展示变换（toolDisplay）——测量消费
      // 展示文本（而非原始串），与渲染行数逐字一致；段头恒一行（SEC_HEAD_H），
      // 首段不留上距（渲染端同样按「上方有无内容」决定 gap）。
      const showArgs = !folded && hasArgsToShow(p.args);
      const showOut = !folded && hasPayloadToShow(p.output);
      const showErr = !folded && hasPayloadToShow(p.err);
      const argsH = showArgs
        ? SEC_HEAD_H + cappedH(toolDisplay(p.args).text, b.w, PAPER_TOOL_FONT, PAPER_TOOL_LINE_HEIGHT, PRE_MAX_H)
        : 0;
      const outH = showOut
        ? SEC_HEAD_H +
          (showArgs ? SEC_HEAD_GAP : 0) +
          cappedH(toolDisplay(p.output).text, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, OUT_MAX_H)
        : 0;
      const errH = showErr
        ? SEC_HEAD_H +
          (showArgs || showOut ? SEC_HEAD_GAP : 0) +
          cappedH(toolDisplay(p.err).text, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, OUT_MAX_H)
        : 0;
      return TOOL_PAD_TOP + FOLD_ROW_H + argsH + outH + errH;
    }
    case 'code': {
      // 与 tool 同构的封顶测量（P2-A）：程序体 + 输出段 + 错误段。
      // 折叠态收程序体、留输出/错误（执行结果一眼可见——与脚注折叠的差异面）。
      // 2026-08-30 溢出修复：程序体走 .pp-code-src 专属镜像（内缩/内距/320 封顶），
      // 输出/错误走 .pp-code .pp-out 的 200 上限（脚注族 160 不同款）。
      // 2026-09-14：段头 + 展示变换同 tool 族（codeOutTextMax 内距归段头后 = 200）。
      // 2026-09-19：输出段数由信封决定（日志/完成值/错误）——段序与 gap 判据走
      // codeOutSections 单一入口，与渲染端 CodeBody 逐段对齐。
      const showSrc = !folded && !!(b.payload as { code?: string }).code;
      const secs = codeOutSections(p);
      const codeH = showSrc ? codeSrcH((b.payload as { code?: string }).code ?? p.args ?? '', b.w) : 0;
      let outH = 0;
      secs.forEach((sec, i) => {
        outH +=
          SEC_HEAD_H +
          (showSrc || i > 0 ? SEC_HEAD_GAP : 0) +
          cappedH(sec.text, b.w, PAPER_OUT_FONT, PAPER_OUT_LINE_HEIGHT, CODE_OUT_TEXT_MAX);
      });
      return TOOL_PAD_TOP + FOLD_ROW_H + codeH + outH;
    }
    case 'plan': {
      // 拟策内容 = 完整 markdown 体（2026-09-10 拟策卡渲染专项）：与正文块同一
      // 结构模型（parseMarkdown → measureMdBlocks——渲染 .pp-pc-body 消费同一
      // 解析，结构漂移结构性不成立），宽度扣策面横向 chrome（石青左线+内距）。
      // 拟策块恒挂壳层 RO 实测（needsObservedHeight），公式/图等动态高兜底。
      const content = p.content ?? '';
      const mdH = content ? measureMdBlocks(parseMarkdown(content), b.w - PLAN_TEXT_INSET).h : 0;
      // 2026-08-30 溢出修复：标题实测（旧固定 39 漏算换行）、方案选择区逐枚
      // 实测（旧 118 装不下两枚带描述的方案）、操作行按钮实高（旧 40 偏小）。
      // 无回调的只读拟策块不增加交互区高度（施工单 #1/#2 语义不变）。
      const plan = b.payload as {
        title?: string;
        _callback?: unknown;
        options?: Array<{ label?: string; description?: string }>;
      };
      const headH =
        measureTextHeight(plan.title || '拟策', b.w - PLAN_TEXT_INSET, PLAN_TITLE_FONT, PLAN_TITLE_LINE_HEIGHT) +
        PLAN_HEAD_MARGIN;
      const optionsH =
        plan._callback && (plan.options?.length ?? 0) >= 2
          ? planOptionsH(plan.options ?? [], b.w - PLAN_TEXT_INSET)
          : 0;
      const actionsH = plan._callback ? PLAN_ACTIONS_H : 0;
      return PLAN_CHROME_H + headH + mdH + optionsH + actionsH;
    }
    case 'toolgroup':
      // 工具组头恒一行（2026-08-30 会话流专项）：折叠行即本体，注线顶距同脚注族；
      // 子卡是独立 tool 块，收起由壳层摘出布局栈，头高与子卡数无关。
      return TOOL_PAD_TOP + FOLD_ROW_H;
    case 'subagent':
      // 子代理组头（F4 2026-09-01）：与工具组头同构恒一行（文类签+折叠行，体空）。
      return TOOL_PAD_TOP + FOLD_ROW_H;
    default:
      // 资产/开放 kind：按表现原语镜像计高（旧固定 80 是画图族卡片溢出的根因）。
      return measureAssetBlockHeight(b);
  }
}

/** 拟策方案选择区高（.pp-pc-options 逐字镜像；w = 策面内容宽——调用方已扣
 *  .pp-pc 横向 chrome；描述文本实测可换行）。 */
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
    case 'subagent':
      // 描述/状态/子段数入签（组头折叠行文案随状态与子块生长变化）
      return `subagent|${p.description ?? ''}|${p.status ?? ''}|${((p.items as unknown[] | undefined) ?? []).length}`;
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
  /* 钉住态 = 另一种纸面（便条批 2026-09-19）：纸内白边 + 纸内报头都是**钉住态
   * 独有**的竖直增量，签名里必须带 state——否则同一块在流/钉两态之间共用一条
   * 缓存，拔钉/钉住后高度照旧（虚拟化剔除矩形错、洞位错）。 */
  if (b.state === 'pinned') return pinnedBlockHeightCached(b, cache, folded, sidecarFolded, sidecarOut);
  const obsKey = needsObservedHeight(b.kind, b.asset != null)
    ? observedKeyOf(b, folded, sidecarFolded, sidecarOut)
    : null;
  const obs = obsKey ? observedBlockHeightOf(obsKey, b.w) : undefined;
  /* 眉批栏是绝对定位的出流件：块的边框盒装不下它，而块高按设计 = max(正文,
   * 眉批 extent)——故实测路径要把两个实测取 max（静态镜像同款见 measureMarkdownBody）。 */
  const sc = obsKey ? observedSidecarExtentOf(obsKey) : undefined;
  const sig = `${measureSignature(b, folded, sidecarFolded, sidecarOut)}|w=${b.w}|obs=${obs ?? ''}|sc=${sc ?? ''}`;
  const hit = cache.byId.get(b.id);
  if (hit && hit.sig === sig) return hit.h;
  let h: number;
  if (obs != null) {
    h = sc != null ? Math.max(obs, sc) : obs;
  } else if (b.kind === 'markdown') {
    const p = b.payload as { text?: string };
    const text = p.text ?? '';
    if (!text) {
      h = sc ?? 0;
    } else {
      const prev = cache.mdParse.get(b.id) ?? null;
      const res = parseMarkdownIncremental(text, prev);
      cache.mdParse.set(b.id, res.state);
      h = measureMarkdownBody(res.blocks, b, sidecarFolded, sidecarOut);
      if (sc != null) h = Math.max(h, sc);
    }
  } else {
    h = measureBlockHeight(b, folded, sidecarFolded, sidecarOut);
  }
  cache.byId.set(b.id, { sig, h });
  return h;
}

/** 钉住块（便条）几何高：纸内白边 + 纸内报头 + 正文（按收窄后的测宽）。
 *
 *  2026-09-19「便条批」：钉住块不再是流内块的透明重绘——纸面加了纸内白边
 *  （.pp-block.pp-pinned 的 padding）与纸内报头（.pp-kind 从纸外页边注 -128px
 *  收进纸内成单行）。两者都由本函数镜像：否则 virtualize 的剔除矩形
 *  （PinnedGeom.h）比真身矮，块尾滑到视口边会被整块卸掉，小地图框也偏小。
 *
 *  实测优先（同主函数纪律）：资产/开放/拟策族挂 RO 实测，而实测读的是**钉住
 *  DOM 的 border-box**——白边与报头已含在内，直接采用。静态镜像族
 *  （markdown/工具/程文…）按收窄测宽重算：cache 键加 `#pin` 后缀与流内条目
 *  分家（同块在流/钉两态各持一份，互不冲刷；主函数的签名也带 state）。 */
function pinnedBlockHeightCached(
  b: SourcedBlock,
  cache: BlockMeasureCache,
  folded = false,
  sidecarFolded = false,
  sidecarOut = false,
): number {
  const obsKey = needsObservedHeight(b.kind, b.asset != null)
    ? observedKeyOf(b, folded, sidecarFolded, sidecarOut)
    : null;
  const obs = obsKey ? observedBlockHeightOf(obsKey, b.w) : undefined;
  const sc = obsKey ? observedSidecarExtentOf(obsKey) : undefined;
  if (obs != null) return sc != null ? Math.max(obs, sc) : obs;
  const inner: SourcedBlock = {
    ...b,
    id: `${b.id}#pin`,
    w: Math.max(PIN_MIN_TEXT_W, b.w - CHROME_DERIVED.pinTextInset),
    state: 'flow',
  };
  return (
    CHROME_DERIVED.pinChromeH +
    CHROME_DERIVED.pinHeadH +
    measureBlockHeightCached(inner, cache, folded, sidecarFolded, sidecarOut)
  );
}

/** 便条正文最小测宽（窄钉极端：纸内白边吃掉整宽时的兜底，防负宽测量）。 */
const PIN_MIN_TEXT_W = 80;

/* ── 缓存管理 ── */

/** 测试复位（生产不调用）。 */
export function clearPaperMeasureCache(): void {
  prepareCache.clear();
  richCache.clear();
  clearPretextCache();
}
