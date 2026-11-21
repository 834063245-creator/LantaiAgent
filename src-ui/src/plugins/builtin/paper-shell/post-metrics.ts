// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子代理**帖**的测高（2026-11-20 帖批 · 上帝文件拆刀）。
//
// 为什么单独一件：帖是 2026-11-20 新加的一族块（帖签 + 活体行 + 复命段），它的几何常量
// 与「复命段有多高」这件事都不属于 measure.ts 的通用块高逻辑——而 measure.ts 已经在
// 2200 行档位上（god-file-budget 的 ratchet 门禁），新族整块塞进去 = 跨档 = 一次显式决策。
// 拆出来还顺带把「帖的三个数」放在同一屏：常量、抄测高、签名。
//
// 单一真源不变：所有数值都从 type-tokens.ts 的 CHROME_TOKENS.post 派生，这里不写魔数。

import { CHROME_DERIVED, cssUsedPx, FONT_STACKS, LIMIT_TOKENS } from './type-tokens';

const SONG_STACK = FONT_STACKS.song;

/** 帖签行的顶距（.pp-block.pp-subagent 的 padding-top）。 */
export const POST_PAD_TOP = CHROME_DERIVED.postPadTop;
/** 帖正文可用宽要扣的横向 chrome：虚线聘线 + 左内距（见 CHROME_DERIVED.postTextInset）。 */
export const POST_TEXT_INSET = CHROME_DERIVED.postTextInset;
/** 帖签行高（子印 19 居中于一行的行盒高）。 */
export const POST_HEAD_H = CHROME_DERIVED.postHeadH;
/** 活体行高与上距（仅进行时）。 */
export const POST_LIVE_H = CHROME_DERIVED.postLiveH;
export const POST_LIVE_GAP = CHROME_DERIVED.postLiveGap;
/** 复命段：上距 / 上规线 / 上内距 / 段头与正文之间的上距（2026-11-21 叠字批补齐后两项）。 */
export const POST_REPORT_GAP = CHROME_DERIVED.postReportGap;
export const POST_REPORT_RULE = CHROME_DERIVED.postReportRule;
export const POST_REPORT_PAD = CHROME_DERIVED.postReportPad;
export const POST_REPORT_TEXT_GAP = CHROME_DERIVED.postReportTextGap;
/** 复命正文的字体与行高——行高是 **px 用值**（pretext 的 layout 收像素，
 *  旧实现把系数 1.85 直接递进去 ⇒ 每行只算 1.85px，复命段几乎不占高）。
 *  CSS 的 line-height 系数 1.85 × 12.5px 是同一份 token（post.reportSize/reportLh）。 */
const POST_REPORT_FONT = `${CHROME_DERIVED.postReportSize}px ${SONG_STACK}`;
const POST_REPORT_LINE_HEIGHT = cssUsedPx(CHROME_DERIVED.postReportSize * CHROME_DERIVED.postReportLh);
/** 复命段头行（.pp-post-report-lab：mono 9px × line-height 1.2）。
 *  行盒由 size × lh 派生 ⇒ 过 cssUsedPx（真 Chrome 实测 10.796875，不是字面 10.8——
 *  0.003125px/帖看着无所谓，但帖多时是**确定性**累积偏差，与夹注/正文同一条纪律）。 */
const POST_REPORT_LAB_H = cssUsedPx(CHROME_DERIVED.postReportLabSize * CHROME_DERIVED.postReportLabLh);
/** 内页（2026-11-21）：上距 / 步间距 / 左内距 / 序号列宽 / 左规线宽。 */
export const POST_INNER_GAP = CHROME_DERIVED.postInnerGap;
export const POST_INNER_STEP_GAP = CHROME_DERIVED.postInnerStepGap;
export const POST_INNER_PAD_L = CHROME_DERIVED.postInnerPadL;
export const POST_INNER_NO_W = CHROME_DERIVED.postInnerNoW;
export const POST_INNER_H = CHROME_DERIVED.postInnerH;
export const POST_INNER_BORDER = CHROME_DERIVED.postInnerBorder;

/** 帖首高（帖签 + 顶距）——收起态与展开态的共同底。 */
export const POST_HEAD_TOTAL_H = POST_PAD_TOP + POST_HEAD_H;

/** 活体行在场时额外占的高（不在场 = 0，不留空行）。 */
export const POST_LIVE_TOTAL_H = POST_LIVE_GAP + POST_LIVE_H;

/** 帖的展开/收起几何（measure.ts 的 `subagent` 分支只需调它一次）。
 *
 *  四段相加，每一段都有在场条件：
 *    · 帖签：恒在（收尾态也在——它是帖的身份）；
 *    · 活体行：**仅进行时**（收尾即退场，不留空行）；
 *    · **内页**：仅展开且有内页块时（2026-11-21 帖内页批）——子代理自己的思考/工具/
 *      正文，默认收起；每步 = 序号列 + 体，步高由调用方传入的 stepH 实测（内页各 kind
 *      的体高与父卷同族但不带文类签，只有内页自己的 chrome）；
 *    · **复命段**：帖尾，**收起态也在**（回文是这个人交回来的答案，不是抽屉里的过程）。
 *      2026-11-21 真机叠字事故：旧实现在 folded 分支提前 return，而渲染端照常画复命段
 *      ⇒ 后一块按「没有复命」的坐标排，压在被画出来的复命正文上。
 *  折叠只管**内页**（子代理的思考/工具/正文），不摘复命段。 */
export function measurePostHeight(
  payload: {
    status?: string;
    doing?: string | null;
    report?: string;
    error?: string;
    inner?: ReadonlyArray<unknown>;
  },
  w: number,
  folded: boolean,
  measureText: (text: string, width: number, font: string, lineH: number) => number,
  /** 内页每一步的实测高（调用方按 kind 逐块量；内页是**帖的内容**，不由块栈量）。
   *  缺省 = 不量内页（stub/估高窗口用帖签高兜底，宁可估矮不漏画）。 */
  stepH?: (index: number) => number,
): number {
  const live = payload.status === 'running' && payload.doing ? POST_LIVE_TOTAL_H : 0;
  let h = POST_HEAD_TOTAL_H + live;
  if (!folded) {
    const inner = payload.inner ?? [];
    if (inner.length > 0 && stepH) {
      h += POST_INNER_GAP;
      for (let i = 0; i < inner.length; i++) {
        h += stepH(i);
        if (i > 0) h += POST_INNER_STEP_GAP;
      }
    }
  }
  const text = payload.report || payload.error;
  if (text) h += POST_REPORT_GAP + measurePostReportH(text, w, measureText);
  return h;
}

/** 内页块要扣掉的「父卷块壳」高：内页直接用各 kind 的**体**渲染器（folded=false），
 *  没有父卷那些族标记——顶距（padding-top）与**折叠行**都不在 DOM 里。
 *  表按 kind 列；未列 = 0（正文/来文/拟策的 padTop 本来就在 0 档）。
 *
 *  ⚠ 折叠行是常漏项（2026-11-21 叠字批）：tool/code 的 measureBlockHeight =
 *  padTop + FOLD_ROW_H + 载荷，夹注 = FOLD_ROW_H + 正文；内页只画「载荷/正文」。
 *  旧表只扣 padTop、夹注一分不扣 ⇒ 每一步多算 20px（展开后帖内一片虚高空白）。
 *  ⚠ 与 paper-inline.css 的 `.pp-block.pp-*` padding-top 一一对应——改 CSS 必改这里。 */
export function postInnerShellH(kind: string): number {
  switch (kind) {
    case 'tool':
    case 'toolgroup':
    case 'code':
      // .pp-block.pp-tool/.pp-toolgroup/.pp-code：padding-top + .pp-fold（14 + 6）
      return CHROME_DERIVED.toolPadTop + LIMIT_TOKENS.foldRowH;
    case 'reasoning':
      // .pp-block.pp-reasoning：折叠行 + 正文（内页只画正文）
      return LIMIT_TOKENS.foldRowH;
    default:
      return 0;
  }
}

/** 内页一步的体高：同 kind 的块高 − 该 kind 的块壳；内页宽度是**帖内容宽**再扣
 *  内页自己的横向 chrome（左规线 + 左内距 + 序号列 + 列距）。
 *
 *  ⚠ 宽度必须扣齐：帖块是 border-box，内容宽 = 块宽 − 聘线 − 帖左内距；
 *  内页再是 border-box，里面才是序号列 + 体。旧式子只扣内页内距与序号列
 *  （漏了帖块那 16px），长内页会少折一行——展开态与折叠态同一条纪律：
 *  测宽和 DOM 的实际行盒宽必须是同一个数。
 *
 *  ⚠ 为什么必须逐块量：内页块**不在父卷块栈里**（use-paper-regions 的单一分界点已滤掉），
 *  它们的宽度/折行也没有别处会算——不量就会「帖展开了、下方块还叠在原来位置」。 */
export function measurePostInnerStepH(
  innerBlock: { kind: string; w: number },
  postW: number,
  measureBlock: (b: { kind: string; w: number }) => number,
): number {
  const stepW = Math.max(
    80,
    postW - POST_TEXT_INSET - POST_INNER_BORDER - POST_INNER_PAD_L - POST_INNER_NO_W - POST_INNER_STEP_GAP,
  );
  return Math.max(0, measureBlock({ ...innerBlock, w: stepW }) - postInnerShellH(innerBlock.kind));
}

/** 复命段高：上规线 + 上内距 + 段头行（mono 9px / 1.2）+ 正文上距
 *  + 正文（宋体 12.5 / 1.85，按宽实测）。
 *
 *  正文高度由调用方传入的 `measureText` 算——**不在本文件 import 测量器**：文本测量是
 *  measure.ts 的单一入口（pretext 缓存纪律 + 字体常量都住那边），本件若自己 import 一份，
 *  就成了第二条测量路径。字串（font）与行高是本族的**版式事实**，留在这里。
 *  ⚠ 行高传入措辞是 **px**（12.5 × 1.85），不是系数——见 POST_REPORT_LINE_HEIGHT 注。 */
export function measurePostReportH(
  text: string,
  w: number,
  measureText: (text: string, width: number, font: string, lineH: number) => number,
): number {
  const bodyW = Math.max(80, w - POST_TEXT_INSET);
  return (
    POST_REPORT_RULE +
    POST_REPORT_PAD +
    POST_REPORT_LAB_H +
    POST_REPORT_TEXT_GAP +
    measureText(text, bodyW, POST_REPORT_FONT, POST_REPORT_LINE_HEIGHT)
  );
}
