// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composer-helpers — 创作坞的**纯函数三件**（2026-11-17 上帝文件治理 P6 拆出；语义零新增）。
//
// 为什么单独立文件：坞本体在大文件账上（1688 行），而这三件没有状态、没有 hook、没有 DOM
// ——搬出去不改任何行为，只让坞本体少一段。它们的**导出面必须先经 ComposerDock.tsx 中继**
// （那里 re-export）：六个行为测试与 desk 用例直接从坞文件 import 这几个符号，
// 改动 import 面是无谓 churn。
//
// ⚠ 依赖方向是单向的：本件只 import 宿主桥（'./host'）与 react 之外的东西；
// 坞本体与本件之间只许「坞 → 本件」，不许反向——反向 = 又拼回一个环。

import type { DirEntry } from './host';
import { loadSettings } from './host';

/** 把目录模型描述符映射到已配置 provider 名（跨 provider 搜索时联动切换）。 */
export function providerNameForModel(desc: { vendor: string } | undefined, fallback: string): string {
  if (!desc?.vendor) return fallback;
  try {
    const providers = loadSettings().providers;
    const hit = providers.find((p) => p.name === desc.vendor);
    return hit ? hit.name : fallback;
  } catch {
    return fallback;
  }
}

/** B5（2026-08-27）：输入历史导航纯函数——↑ 回退 / ↓ 前进。
 *  idx = -1 = 不在历史浏览（live 草稿）；history 按旧→新排列（尾部 = 最近）。
 *  返回 entry.idx = 新的浏览下标，entry = null 表示该方向无路可走
 *  （最新端再 ↓ = 越出，调用方恢复草稿；空历史/最老端 ↑ 不动）。 */
export function navigateHistory(
  history: readonly string[],
  idx: number,
  dir: -1 | 1,
): { entry: { idx: number; text: string } | null } {
  if (history.length === 0) return { entry: null };
  const cur = idx >= 0 ? idx : history.length; // -1（live）视同「在最新一条之外」
  const next = cur + dir;
  if (next < 0 || next >= history.length) return { entry: null };
  return { entry: { idx: next, text: history[next] } };
}

/* ── 引（创作坞 v2 2026-08-31）：工作区文件模糊引用 ── */

/** list_directory 递归项（Rust DirEntry 序列化形状——schema 推导）。 */
type YinDirEntry = DirEntry;

/** 递归摊平目录树为文件清单（目录不入引——附卷的是文件）。 */
export function flattenDirEntries(entries: readonly YinDirEntry[]): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  const walk = (list: readonly YinDirEntry[]) => {
    for (const e of list ?? []) {
      if (!e.is_dir) out.push({ path: e.path, name: e.name });
      if (e.children?.length) walk(e.children);
    }
  };
  walk(entries);
  return out;
}

/** 引 模糊匹配纯函数：查询词对路径做子序列命中；basename 命中加权靠前，
 *  路径越短越靠前。空查询 = 清单原序截前 limit（打开即见常拥文件）。 */
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
