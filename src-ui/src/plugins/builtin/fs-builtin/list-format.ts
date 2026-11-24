// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// fs(list) 模型面整形（2026-11-24 B 案）：fs_cap 的 {entries} 树 → 逐行文本树。
//
// 病灶（2026-11-24 实测）：{entries} 是**单行紧凑 JSON**，条目各背一遍绝对路径
// （research-system 根 1349 条 = 192 KB / **一行**）。工具结果截断器对「首行超
// 50KB」的处理是整段丢弃（agent/truncate.ts 的 firstLineExceedsLimit → content:''），
// 于是任何 >350 条的项目根目录，模型只收到一句 `[Output truncated: ...]`、零信息，
// 会话日志里也没留原文（记的就是那句提示）。同月会话实证：模型自己写
// 「odd… let me use shell ls instead」改道，多烧一轮。
//
// 逐行树的收益（同一棵树）：
//   · 体积 ~1/5——名字 + 两空格缩进，不再每条重复根路径；
//   · 截断边界不再是悬崖——逐行正是既有截断器（50 KB / 2000 行）的原生粒度；
//   · 模型直读：目录尾 `/`、缩进即层级、首行给根路径与条目数。
//
// 形状纪律（`tests/fs-list-format.test.ts` 钉死）：
//   · 首行恒为 `<root> — <N> 项`（N = 树里全部条目数；卡片投影据此取折叠读数）；
//   · 目录条目尾 `/`，文件不加；两空格一层；
//   · 排序 = 目录先、名字不区分大小写升序——Rust read_dir 的返回序是文件系统序，
//     不排则同一目录两次调用输出不同（不确定性不是信息）；
//   · 超预算收窄成**两层地图**（根的直接子项 + 其直接子项），末行说明已列/总数；
//     绝不静默丢（收窄与截断都要有一句话交代）。
//
// 只做投影，不改协议：fs_cap 仍回 {entries}（UI 的 kernelListDirectory 走同一条
// RPC，形状不动）；线格式违形时调用方直通原文（不静默改写）。

import type { DirEntry } from '../../../rpc-contract';

/** 完整展开的条目上限；超过则收窄成两层地图（~600 行 ≈ 13 KB，单次调用可承受）。 */
export const FULL_TREE_LIMIT = 600;
/** 地图模式每个目录最多列出的直接子项数。 */
export const MAP_CHILD_LIMIT = 20;
/** 一层缩进。 */
const INDENT = '  ';
/** Windows 扩展长度路径前缀 `\\?\`（Rust canonicalize 的产物，模型面是噪音）。 */
const EXT_LONG_PREFIX = /^\\\\\?\\/;
/** Rust 侧条目上限（confined_fs::list_dir_recursive 的 MAX_ENTRIES）命中时的交代语。 */
const CAP_NOTE = '… 目录树达 2000 条上限，已截断（更细的层级用更窄的 path 继续）。';

/** 子树条目总数（含自身）。 */
function countEntries(entries: readonly DirEntry[]): number {
  let n = 0;
  for (const e of entries) {
    n += 1;
    if (e.children) n += countEntries(e.children);
  }
  return n;
}

/** 目录先、名字不区分大小写升序（与 confined_fs::list_dir_flat 同序）。 */
function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an === bn) return 0;
  return an < bn ? -1 : 1;
}

function sortedEntries(entries: readonly DirEntry[]): DirEntry[] {
  return [...entries].sort(compareEntries);
}

/** DirEntry 线格式判据：name/is_dir 必需，children 键恒在（null 或数组）。
 *  任一环违形 ⇒ 整份拒收（调用方直通原文），不做半信半疑的局部投影。 */
function isDirEntry(value: unknown): value is DirEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as { name?: unknown; is_dir?: unknown; children?: unknown };
  if (typeof e.name !== 'string' || typeof e.is_dir !== 'boolean') return false;
  return e.children === null || asDirEntries(e.children) !== null;
}

function asDirEntries(value: unknown): DirEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: DirEntry[] = [];
  for (const item of value) {
    if (!isDirEntry(item)) return null;
    out.push(item);
  }
  return out;
}

/** 根路径的展示形态：剥 `\\?\` 前缀、反斜杠归正斜杠（模型/人都读得顺）。 */
function displayRoot(root: string | undefined): string | null {
  if (!root) return null;
  const trimmed = root.replace(EXT_LONG_PREFIX, '').replace(/\\/g, '/');
  return trimmed === '' ? null : trimmed;
}

function emitTree(entries: readonly DirEntry[], depth: number, out: string[]): void {
  for (const e of sortedEntries(entries)) {
    out.push(`${INDENT.repeat(depth)}${e.name}${e.is_dir ? '/' : ''}`);
    if (e.is_dir && e.children && e.children.length > 0) emitTree(e.children, depth + 1, out);
  }
}

/** 两层地图：根的直接子项 + 其直接子项（每目录封顶 MAP_CHILD_LIMIT，余量报数）。
 *  返回实际列出的条目数（不含 `… +K 项未列` 标记行）。 */
function emitMap(entries: readonly DirEntry[], out: string[]): number {
  let emitted = 0;
  for (const e of sortedEntries(entries)) {
    if (emitted >= FULL_TREE_LIMIT) break;
    out.push(`${e.name}${e.is_dir ? '/' : ''}`);
    emitted += 1;
    if (!e.is_dir || !e.children || e.children.length === 0) continue;
    const kids = sortedEntries(e.children);
    const shown = kids.slice(0, MAP_CHILD_LIMIT);
    for (const k of shown) {
      out.push(`${INDENT}${k.name}${k.is_dir ? '/' : ''}`);
      emitted += 1;
    }
    if (kids.length > shown.length) out.push(`${INDENT}… +${kids.length - shown.length} 项未列`);
  }
  return emitted;
}

/**
 * fs_cap list 的 `{entries}` JSON → 模型面逐行树。
 *
 * @param raw fs_cap 返回的 JSON 字符串
 * @param root 本次请求的根路径（模型可见原值；缺省则首行只报条目数）
 * @returns 文本树；**线格式违形时返回 null**（调用方直通原文，不静默改写）
 */
export function formatListPayload(raw: string, root?: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const entries = asDirEntries((parsed as { entries?: unknown }).entries);
  if (!entries) return null;

  const total = countEntries(entries);
  const shownRoot = displayRoot(root);
  const lines: string[] = [shownRoot ? `${shownRoot} — ${total} 项` : `${total} 项`];
  // Rust 侧 2000 条上限命中 ⇒ `total` 只是下限，必须有一句话交代（否则读数会骗人）。
  const capped = entries[0]?.truncated === true;

  if (total <= FULL_TREE_LIMIT) {
    emitTree(entries, 0, lines);
    if (capped) lines.push(CAP_NOTE);
    return lines.join('\n');
  }

  const emitted = emitMap(entries, lines);
  const cut = emitted < total ? `已列 ${emitted} / ${total} 项` : `共 ${emitted} 项`;
  lines.push(`… 树较大：${cut}（只展开两层）；传更窄的 path 继续。`);
  if (capped) lines.push(CAP_NOTE);
  return lines.join('\n');
}
