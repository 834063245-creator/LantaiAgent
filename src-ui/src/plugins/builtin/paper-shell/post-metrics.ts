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

import { CHROME_DERIVED, FONT_STACKS } from './type-tokens';

const SONG_STACK = FONT_STACKS.song;

/** 帖签行的顶距（.pp-block.pp-subagent 的 padding-top）。 */
export const POST_PAD_TOP = CHROME_DERIVED.postPadTop;
/** 帖内容左内距（虚线聘线里侧）。 */
export const POST_PAD_L = CHROME_DERIVED.postPadL;
/** 帖签行高（子印 19 居中于一行的行盒高）。 */
export const POST_HEAD_H = CHROME_DERIVED.postHeadH;
/** 活体行高与上距（仅进行时）。 */
export const POST_LIVE_H = CHROME_DERIVED.postLiveH;
export const POST_LIVE_GAP = CHROME_DERIVED.postLiveGap;
/** 复命段上距与上内距（段头上方那条弱规线两侧）。 */
export const POST_REPORT_GAP = CHROME_DERIVED.postReportGap;
export const POST_REPORT_PAD = CHROME_DERIVED.postReportPad;
/** 内页（2026-11-21）：上距 / 步间距。左内距与序号列宽只影响测宽，由调用方传给 stepH。 */
export const POST_INNER_GAP = CHROME_DERIVED.postInnerGap;
export const POST_INNER_STEP_GAP = CHROME_DERIVED.postInnerStepGap;
export const POST_INNER_PAD_L = CHROME_DERIVED.postInnerPadL;
export const POST_INNER_NO_W = CHROME_DERIVED.postInnerNoW;
export const POST_INNER_H = CHROME_DERIVED.postInnerH;

/** 帖首高（帖签 + 顶距）——收起态与展开态的共同底。 */
export const POST_HEAD_TOTAL_H = POST_PAD_TOP + POST_HEAD_H;

/** 活体行在场时额外占的高（不在场 = 0，不留空行）。 */
export const POST_LIVE_TOTAL_H = POST_LIVE_GAP + POST_LIVE_H;

/** 帖首的展开/收起几何（measure.ts 的 `subagent` 分支只需调它一次）。
 *
 *  四段相加，每一段都有在场条件：
 *    · 帖签：恒在（收尾态也在——它是帖的身份）；
 *    · 活体行：**仅进行时**（收尾即退场，不留空行）；
 *    · **内页**：仅展开且有内页块时（2026-11-21 帖内页批）——子代理自己的思考/工具/
 *      正文，默认收起；每步 = 序号列 + 体，步高由调用方传入的 stepH 实测（内页各 kind
 *      的体高与父卷同族但不带文类签，只有内页自己的 chrome）；
 *    · 复命段：仅展开且有回文/未办原因时。
 *  折叠态：壳层不渲染体，帖自身只留帖签 + 活体行。 */
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
  if (folded) return POST_HEAD_TOTAL_H + live;
  const inner = payload.inner ?? [];
  let h = POST_HEAD_TOTAL_H + live;
  if (inner.length > 0 && stepH) {
    h += POST_INNER_GAP;
    for (let i = 0; i < inner.length; i++) {
      h += stepH(i);
      if (i > 0) h += POST_INNER_STEP_GAP;
    }
  }
  const text = payload.report || payload.error;
  if (text) h += POST_REPORT_GAP + measurePostReportH(text, w, measureText);
  return h;
}

/** 内页块要扣掉的「父卷块壳」高：内页直接用各 kind 的**体**渲染器，没有父卷那些
 *  族标记（脚注族的 44px 注线 + padTop、程文同款、工具组的头行…）。
 *  表按 kind 列；未列 = 0（正文/来文/拟策的 padTop 本来就在 0 档）。
 *  ⚠ 这张表与 paper-inline.css 的 `.pp-block.pp-*` padding-top 一一对应——改 CSS 必改这里，
 *  否则内页展开后帖高会与真机差一个注线高（下方块压字）。 */
export function postInnerShellH(kind: string): number {
  switch (kind) {
    case 'tool':
    case 'toolgroup':
    case 'code':
      return CHROME_DERIVED.toolPadTop; // .pp-block.pp-tool/.pp-toolgroup/.pp-code padding-top
    default:
      return 0;
  }
}

/** 内页一步的体高：同 kind 的块高 − 该 kind 的块壳；内页宽度是内容宽（扣序号列与内距），
 *  量的时候换宽。measureBlocks 由 measure.ts 传入（文本测量只有那一条路径）。
 *
 *  ⚠ 为什么必须逐块量：内页块**不在父卷块栈里**（use-paper-regions 的单一分界点已滤掉），
 *  它们的宽度/折行也没有别处会算——不量就会「帖展开了、下方块还叠在原来位置」。 */
export function measurePostInnerStepH(
  innerBlock: { kind: string; w: number },
  postW: number,
  measureBlock: (b: { kind: string; w: number }) => number,
): number {
  const stepW = Math.max(80, postW - POST_INNER_PAD_L - POST_INNER_NO_W - POST_INNER_STEP_GAP);
  return Math.max(0, measureBlock({ ...innerBlock, w: stepW }) - postInnerShellH(innerBlock.kind));
}

/** 复命段高：段头行（mono 9px / 1.2）+ 正文（宋体 12.5 / 1.85，按宽实测）。
 *
 *  正文高度由调用方传入的 `measureText` 算——**不在本文件 import 测量器**：文本测量是
 *  measure.ts 的单一入口（pretext 缓存纪律 + 字体常量都住那边），本件若自己 import 一份，
 *  就成了第二条测量路径。字串（font）与行高是本族的**版式事实**，留在这里。 */
export function measurePostReportH(
  text: string,
  w: number,
  measureText: (text: string, width: number, font: string, lineH: number) => number,
): number {
  const bodyW = Math.max(80, w - POST_PAD_L);
  const headH = 9 * 1.2; // .pp-post-report-lab
  return POST_REPORT_PAD + headH + measureText(text, bodyW, `12.5px ${SONG_STACK}`, 1.85);
}
