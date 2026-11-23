// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 文档改稿差分（插件文档通道 · 批 2）——**宿主侧**算，插件只交新正文。
//
// 为什么在宿主算：改稿单是宿主给用户的证据面，不能由插件自己说「我改了哪几行」；
// 差分因此是宿主从**磁盘现状 + 插件交来的正文**两串真源现场算出来的。
//
// 口径：行级 LCS（够用即可，不做字符级/词级）；输出 `+` / `-` / ` ` 前缀行；
// 超行数上限只截展示，**计数不截**（用户看到的 `+a −b` 永远是全量）。

/** 差分摘要：计数（全量）+ 展示文本（可截断）。 */
export interface DocumentDiffSummary {
  added: number;
  removed: number;
  /** 统一风格文本（`+` / `-` / 空格前缀），超上限尾部出省略注记。 */
  text: string;
}

const DEFAULT_MAX_LINES = 120;

function splitLines(s: string): string[] {
  return s.length === 0 ? [] : s.split(/\r?\n/);
}

/** 行级 LCS 表（O(n·m) 内存；文档量级够用——超万行由调用方先截断或拒绝）。 */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const w = b.length + 1;
  const t = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  return t;
}

/** 差分摘要（`before` = 磁盘现状，`after` = 插件交来的新正文）。 */
export function summarizeDocumentDiff(
  before: string,
  after: string,
  opts?: { maxLines?: number },
): DocumentDiffSummary {
  if (before === after) return { added: 0, removed: 0, text: '（正文无变化）' };
  const a = splitLines(before);
  const b = splitLines(after);
  const t = lcsTable(a, b);
  const w = b.length + 1;
  const rows: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      rows.push(`-${a[i]}`);
      removed += 1;
      i += 1;
    } else {
      rows.push(`+${b[j]}`);
      added += 1;
      j += 1;
    }
  }
  while (i < a.length) {
    rows.push(`-${a[i]}`);
    removed += 1;
    i += 1;
  }
  while (j < b.length) {
    rows.push(`+${b[j]}`);
    added += 1;
    j += 1;
  }
  const cap = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const shown = rows.length > cap ? rows.slice(0, cap) : rows;
  const tail = rows.length > cap ? `\n…（共 ${rows.length} 行差分，仅展示前 ${cap} 行）` : '';
  return { added, removed, text: shown.join('\n') + tail };
}
