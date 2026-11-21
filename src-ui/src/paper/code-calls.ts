// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// paper/code-calls — 程文卡里的「程序内调用」段（2026-11-21 显形批）。
//
// 缘起：code_execution 把 N 次工具调用折叠成一次外层调用之后，纸面只剩一张
// 「跑了段程序」的卡——程序里究竟调了哪些工具、成没成、干了什么，只有
// session-log 的审计对知道（用户 2026-11-21：「程序内的子调用在纸面上其实是
// 应该显形的」）。
//
// 三条纪律（违反即返工）：
//   ① **纯展示**：数据来自执行期 onProgress 旁路（`part.calls`），不进模型面、
//      不改程序返回值、不替代 session-log 审计（那是 durable 事实面）。
//   ② **单一投影**：行文本由本文件的 `codeCallLines` 一次算清——渲染（CodeBody）、
//      测高（measure）、墨迹（inkSourcesFor）三面读同一份，禁各自拼。
//   ③ **不静默丢**：超出展示上限出注记行（「其余 N 条未显示」）。

import type { CodeCallPart } from './block-model';

/** 展示上限（超出行出注记）：一次程序跑几十次调用是常态（真机实测单次最多 46），
 *  逐条平铺会把整张卡撑成一堵墙；12 条够读「它在干什么」，全量在 session-log。 */
export const CODE_CALL_SHOW_CAP = 12;

/** 段头文案（渲染与测高共用）。 */
export const CODE_CALLS_LABEL = '程序内调用';

/** 一笔调用的给人读的一行：`3. fs(read) ✓ 12 行` / `5. shell(run) ✗ exit 1`。
 *  成败用 ✓/✗ 而不是文字——一眼扫过就有读数，且与折叠行同族记号。 */
export function codeCallLine(c: CodeCallPart): string {
  const target = c.action ? `${c.name}(${c.action})` : c.name;
  const mark = c.ok ? '✓' : '✗';
  return `${c.seq}. ${target} ${mark}${c.summary ? ` ${c.summary}` : ''}`;
}

/** 段投影：展示行 + 决策注记（空串 = 无省略）。 */
export function codeCallLines(calls: readonly CodeCallPart[] | undefined): { lines: string[]; note: string } {
  if (!calls || calls.length === 0) return { lines: [], note: '' };
  const shown = calls.slice(0, CODE_CALL_SHOW_CAP);
  const rest = calls.length - shown.length;
  return {
    lines: shown.map(codeCallLine),
    note: rest > 0 ? `其余 ${rest} 条未显示（共 ${calls.length} 条）` : '',
  };
}

/** 折叠行读数（「内调 7」）：折叠态下用户仍要知道这条程序走了几步。
 *  空串 = 无调用（折叠行回落字数读数）。 */
export function codeCallsReadout(calls: readonly CodeCallPart[] | undefined): string {
  if (!calls || calls.length === 0) return '';
  const failed = calls.filter((c) => !c.ok).length;
  return failed > 0 ? `内调 ${calls.length} · ${failed} 失败` : `内调 ${calls.length}`;
}
