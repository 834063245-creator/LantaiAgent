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

/** 帖首高（帖签 + 顶距）——收起态与展开态的共同底。 */
export const POST_HEAD_TOTAL_H = POST_PAD_TOP + POST_HEAD_H;

/** 活体行在场时额外占的高（不在场 = 0，不留空行）。 */
export const POST_LIVE_TOTAL_H = POST_LIVE_GAP + POST_LIVE_H;

/** 帖首的展开/收起几何（measure.ts 的 `subagent` 分支只需调它一次）。
 *
 *  三段相加，每一段都有在场条件：
 *    · 帖签：恒在（收尾态也在——它是帖的身份）；
 *    · 活体行：**仅进行时**（收尾即退场，不留空行）；
 *    · 复命段：仅展开且有回文/未办原因时。
 *  折叠态：壳层把体（子块）摘出布局栈，帖自身只留帖签 + 活体行。 */
export function measurePostHeight(
  payload: { status?: string; doing?: string | null; report?: string; error?: string },
  w: number,
  folded: boolean,
  measureText: (text: string, width: number, font: string, lineH: number) => number,
): number {
  const live = payload.status === 'running' && payload.doing ? POST_LIVE_TOTAL_H : 0;
  if (folded) return POST_HEAD_TOTAL_H + live;
  const text = payload.report || payload.error;
  if (!text) return POST_HEAD_TOTAL_H + live;
  return POST_HEAD_TOTAL_H + live + POST_REPORT_GAP + measurePostReportH(text, w, measureText);
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
