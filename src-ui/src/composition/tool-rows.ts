// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置工具行表（S1-2）—— composition 架构的装配数据源。已迁入：fs、shell、git、search。
//
// 行（row）= 装配的最小单位：id 寻址 + factory 延迟实例化。
// 表序 = 组合序（standard preset 装配序的事实来源）——前缀缓存语义的根基。
//
// 迁入纪律（S1 设计件 §2.4，docs/plans/composition-architecture/designs/
// S1-convergence-per-preset.md）：每迁一族，不设 CONVERGENCE_PRESET 跑
// verify:convergence，三个 tool-schemas 快照必须逐字节零漂移——迁行是
// 现行装配的机械重述，不是行为变更。
//
// 过渡形态（S1 设计件 §5 未决项）：S1 期间行在 TS 常量表；S2 才数据
// 文件化（yml schema 是 S2 设计件的事）。
//
// 装配可见面说明：fs 族的 11 个细粒度工具在领域收敛（convergeRegistry）
// 后全部 hidden，可见面是 fs 域工具（schema 由 DOMAIN_SPECS 声明序构造，
// 与注册序无关）——fs 行迁不改变可见面，零漂移按构造成立。

import type { Tool, ToolExecutor } from '../agent/tool';
import { createFsTools, createGitTools, createSearchTools, createShellTools } from '../agent/tools/coding';

/** 行装配上下文 — buildToolRegistry 提供的运行时依赖。
 *  S1-2 起随族迁入逐字段扩展（shell/git/search 复用 codingExec；
 *  task 族加 taskManager、agent 族加 pool/spawner……）。 */
export interface ToolRowContext {
  codingExec: ToolExecutor;
}

/** 内置工具行：id 寻址 + factory 延迟实例化。
 *  id 惯例 `builtin/<family>`——与外部贡献（services.ts 的
 *  ToolContribution，id 形如 `<plugin>/<tool>`）区分命名空间。 */
export interface BuiltinToolRow {
  id: string;
  factory: (ctx: ToolRowContext) => Tool[];
}

/** fs 族行（S1-2 第一批迁入）。
 *  factory 与 createCodingTools 内的 fs 面同源（createFsTools），
 *  序 = 迁移前 createCodingTools 内的现行表序（机械重述）。 */
const FS_ROW: BuiltinToolRow = {
  id: 'builtin/fs',
  factory: (ctx) => createFsTools(ctx.codingExec),
};

/** shell 族行（S1-2 第二批迁入）。
 *  factory 与 createCodingTools 内的 shell 面同源（createShellTools），
 *  序 = 迁移前现行表序（run_shell → bash_output/kill/wait）。
 *  可见面：4 个细粒度名收敛后全 hidden，零漂移按构造成立。 */
const SHELL_ROW: BuiltinToolRow = {
  id: 'builtin/shell',
  factory: (ctx) => createShellTools(ctx.codingExec),
};

/** git 族行（S1-2 第三批迁入）。
 *  factory 与 createCodingTools 内的 git 面同源（createGitTools，
 *  主段 + Phase 2b 段按原声明序拼接）。
 *  可见面：细粒度名收敛后全 hidden，零漂移按构造成立。 */
const GIT_ROW: BuiltinToolRow = {
  id: 'builtin/git',
  factory: (ctx) => createGitTools(ctx.codingExec),
};

/** search 族行（S1-2 第四批迁入）——单工具 search_content。 */
const SEARCH_ROW: BuiltinToolRow = {
  id: 'builtin/search',
  factory: (ctx) => createSearchTools(ctx.codingExec),
};

/** 内置行表 — 表序 = 组合序。S1-2 起逐族迁入
 *  （fs → shell → git → search → graph/ops/lsp → agent → 其余）；
 *  S1-3 起 buildToolRegistry 末端整体改读本表并加名字冲突装载期拒绝。 */
export function builtinToolRows(): BuiltinToolRow[] {
  return [FS_ROW, SHELL_ROW, GIT_ROW, SEARCH_ROW];
}
