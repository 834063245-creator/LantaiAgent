// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工作区文件的两件纯函数——**单一真源**（2026-11-28 全局搜索批：从
// compose-dock/composer-helpers.ts 搬到 app 层）。
//
// 为什么搬：命令面板（app/CommandPalette）也要「按文件名模糊找」，而 app 层不许
// import 插件目录（层次纪律：插件依赖 app，反之不成立）。搬到这里之后两边共用同一把
// 尺子——坞的「引」面板与全局搜索的「文件」组必然是同一份匹配口径，不会各写一版。
// composer-helpers.ts 仍原样 re-export（既有 import 面零 churn）。

import type { DirEntry } from '../../rpc-contract';

/** 递归摊平目录树为文件清单（目录不入列——附卷的是文件）。 */
export function flattenDirEntries(entries: readonly DirEntry[]): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  const walk = (list: readonly DirEntry[] | null | undefined) => {
    for (const e of list ?? []) {
      if (!e.is_dir) out.push({ path: e.path, name: e.name });
      if (e.children?.length) walk(e.children);
    }
  };
  walk(entries);
  return out;
}

/** 文件模糊匹配：查询词对路径做子序列命中；basename 命中加权靠前，路径越短越靠前。
 *  空查询 = 清单原序截前 limit（打开即见常拥文件）。 */
export function fuzzyMatchFiles(
  files: ReadonlyArray<{ path: string; name: string }>,
  query: string,
  limit = 14,
): Array<{ path: string; name: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, limit);
  const hits: Array<{ path: string; name: string; score: number }> = [];
  for (const f of files) {
    const path = f.path.toLowerCase();
    const name = f.name.toLowerCase();
    if (!isSubsequence(q, path)) continue;
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
    hits.push({ ...f, score });
  }
  hits.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return hits.slice(0, limit);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}
