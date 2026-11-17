// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞**源码面**的读取口（测试专用）。
//
// 2026-11-17 上帝文件治理 P5：ComposerDock.tsx（1688 行）拆成坞本体 + 行件 / 模态 /
// 书眉 / 助手纯函数 / 五个 hook。源码级断言（「这个类名还在不在」「这行调用长什么样」）
// 原本只读 ComposerDock.tsx——拆完就得跟着代码走，否则断言退化成「文件搬家检查」。
//
// 口径与 helpers/panel-source.ts（纸壳 2026-11-06 同一件事）一致：同目录全部 .ts/.tsx
// 按名排序拼接。断言对象仍是这份源码，只是不再假设它住在一个文件里。
//
// ⚠ 例外：**宿主桥声明面不进聚合**。`host.ts` / `host.aliased.ts` 是「本包从内核取
// 什么」的清单（faceDeps 对照面），不是坞的视图代码——那里面一个键名恰好含 `abort`
// 或 `menuOpen`，不该被判成「坞把死代码复活了」（与「断言跟着实现走」是两回事：
// 这里排除的是**另一类文件**，不是把断言改软）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCK_DIR = join(__dirname, '..', '..', 'src', 'plugins', 'builtin', 'compose-dock');
const BRIDGE_FILES = new Set(['host.ts', 'host.aliased.ts']);

/** 创作坞全部源码（坞本体 + composer-rows / composer-modals / composer-helpers /
 *  composer-header / goal-strip / surface/use-composer-*.ts + 既有的 ModelSelector 等）。 */
export function readDockSources(): string {
  return readdirSync(DOCK_DIR)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !BRIDGE_FILES.has(f))
    .sort()
    .map((f) => readFileSync(join(DOCK_DIR, f), 'utf8'))
    .join('\n');
}
