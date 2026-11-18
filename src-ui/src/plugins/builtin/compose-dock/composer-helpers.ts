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

/* ── 引（创作坞 v2 2026-08-31）：工作区文件模糊引用 ──
 * 2026-11-28 全局搜索批：两件纯函数搬去 `app/search/file-match.ts`（命令面板的「文件」组
 * 要用同一把尺子，而 app 层不许 import 插件目录）。本文件原样 re-export——既有 import
 * 面（坞内「引」面板、行为测试）零 churn，口径仍是同一份实现。 */
export { flattenDirEntries, fuzzyMatchFiles } from '../../../app/search/file-match';
