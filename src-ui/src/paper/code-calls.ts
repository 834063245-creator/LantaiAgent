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
//
// 2026-11-23（运行态批）：程序内调用不再只在落定后才出现——起跑一拍先落一行
// `⋯ 在跑`，落定后按同一 seq 原地改成 ✓/✗（用户：「程序体运行了一个 shell(run)，
// 但用户只能等到 shell 结束才看到一条工具信息的渲染」）。「在跑」字形与状态签
// 的石青同义（行内文本给墨，颜色由渲染层按 status 上色）。

import { type CodeCallStatus, codeCallStatus } from '../agent/code-run/dispatch-record';
import type { CodeCallPart } from './block-model';

/** 展示上限（超出行出注记）：一次程序跑几十次调用是常态（真机实测单次最多 46），
 *  逐条平铺会把整张卡撑成一堵墙；12 条够读「它在干什么」，全量在 session-log。 */
export const CODE_CALL_SHOW_CAP = 12;

/** 段头文案（渲染与测高共用）。 */
export const CODE_CALLS_LABEL = '程序内调用';

/** 一笔调用的展示行：文本 + 状态（状态只给渲染面上色；测高只看行数）。 */
export interface CodeCallLine {
  text: string;
  status: CodeCallStatus;
}

/** 一笔调用的给人读的一行：`3. fs(read) ✓ 12 行` / `5. shell(run) ⋯ 在跑`。
 *  成败用 ✓/✗ 而不是文字——一眼扫过就有读数，且与折叠行同族记号；
 *  在跑用 ⋯ + 「在跑」：前者是「还没完」的休止符，后者让不看图例的人也读得懂。 */
export function codeCallLine(c: CodeCallPart): CodeCallLine {
  const status = codeCallStatus(c);
  const target = c.action ? `${c.name}(${c.action})` : c.name;
  const mark = status === 'running' ? '⋯' : status === 'done' ? '✓' : '✗';
  const tail = status === 'running' ? ' 在跑' : c.summary ? ` ${c.summary}` : '';
  return { text: `${c.seq}. ${target} ${mark}${tail}`, status };
}

/** 段投影：展示行 + 决策注记（空串 = 无省略）。 */
export function codeCallLines(calls: readonly CodeCallPart[] | undefined): { lines: CodeCallLine[]; note: string } {
  if (!calls || calls.length === 0) return { lines: [], note: '' };
  const shown = calls.slice(0, CODE_CALL_SHOW_CAP);
  const rest = calls.length - shown.length;
  return {
    lines: shown.map(codeCallLine),
    note: rest > 0 ? `其余 ${rest} 条未显示（共 ${calls.length} 条）` : '',
  };
}

/** 展示签（测高/墨迹缓存的失效判据）：行文本 + 注记。
 *  只含**可见段**——被上限挡掉的调用不改变行数/行文本，也就不该让缓存失效；
 *  而同一行的 running→done 改字必须失效（否则墨迹会停在「⋯ 在跑」）。 */
export function codeCallsSignature(calls: readonly CodeCallPart[] | undefined): string {
  const { lines, note } = codeCallLines(calls);
  return lines.map((line) => line.text).join('\n') + (note ? `\n${note}` : '');
}

/** 折叠行读数（「内调 7」）：折叠态下用户仍要知道这条程序走了几步、还有几笔在跑。
 *  **只一笔在跑时报名字**（`在跑 shell(run)`）——这是用户 95% 时间看的那一行，
 *  也比「1 在跑」更直接地回答「现在卡在哪」；多笔才退回计数（一行放不下）。
 *  空串 = 无调用（折叠行回落字数读数）。 */
export function codeCallsReadout(calls: readonly CodeCallPart[] | undefined): string {
  if (!calls || calls.length === 0) return '';
  const running = calls.filter((c) => codeCallStatus(c) === 'running');
  const failed = calls.filter((c) => codeCallStatus(c) === 'error').length;
  const parts = [`内调 ${calls.length}`];
  if (running.length === 1) {
    const c = running[0];
    parts.push(`在跑 ${c.action ? `${c.name}(${c.action})` : c.name}`);
  } else if (running.length > 1) {
    parts.push(`${running.length} 在跑`);
  }
  if (failed > 0) parts.push(`${failed} 失败`);
  return parts.join(' · ');
}
