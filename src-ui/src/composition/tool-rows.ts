// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 内置工具行表（S1-2/S1-3）—— composition 架构的装配数据源。
// 现存 2 族：web、browser-desktop（①b 迁移的后续候选——寻址前置已就位）。
// 迁出史：git/search（B①）+ fs/shell/agent-isolation（②）无状态五族 +
// wait/ask + memory/skill/task/agent + hologram（①c 装配期真值七族，
// 2026-08-23）全部迁入 ctx.tools 第一方插件通道
// （plugins/coding-domain-plugins.ts，经 composition/first-party-tools.ts
// 装载——①c 七族经 noCache 贡献每装配重创实例，装配期真值无跨装配串扰）。
// 表序 = 组合序（standard preset 装配序的事实来源）——前缀缓存语义的根基。
// S4-4 甲（2026-08-23）：插件贡献行与本表同进组合解析域
// （factoryComposition().tools = builtin 行在前 + 贡献行随后）。
//
// 迁入纪律（S1 设计件 §2.4）：每迁一族，不设 CONVERGENCE_PRESET 跑
// verify:convergence，三个 tool-schemas 快照必须逐字节零漂移——迁行是
// 现行装配的机械重述，不是行为变更。
//
// 过渡形态（S1 设计件 §5 未决项）：S1 期间行在 TS 常量表；S2 才数据
// 文件化（yml schema 是 S2 设计件的事）。
//
// 装配可见面说明：细粒度工具名在领域收敛（convergeRegistry）后全部
// hidden（ask_user 与 wait 例外，它们是常驻可见名），可见面 = 域工具
// （schema 由 DOMAIN_SPECS 声明序构造）+ ask_user + wait——与注册序
// 无关，行迁不改变可见面，零漂移按构造成立。
//
// 不属于行表的装配步骤（保留在 buildToolRegistry 末端）：read_file 别名
// （注册表操作非工具定义）、外部 mcpClients 贡献、convergeRegistry。
// S4-4 甲后行表源含插件贡献行（经 factoryComposition 快照）；行 id 惯例
// 'builtin/<family>' 与贡献行 'plugin/<插件名>/<工具名>' 分立命名空间。

import type { SubAgentPool } from '../agent/coordinator';
import type { MemoryManager } from '../agent/memory';
import type { SkillRegistry } from '../agent/skills';
import type { TaskManager } from '../agent/task';
import type { Tool, ToolExecutor } from '../agent/tool';
import type { CodingToolsUI } from '../agent/tools/coding';
import { createWebTools } from '../agent/tools/coding';
import type { SubAgentSpawner } from '../agent/tools/subagent';

/** 行装配上下文 — buildToolRegistry 提供的全部运行时依赖。
 *  可选字段的缺席 = 该行/贡献产出空集（族内工具按依赖存在性条件注册，
 *  与迁移前 builder 的 if 分支语义一致）。 */
export interface ToolRowContext {
  /** graph/ops/lsp 族的开关：缺帐时该贡献产出空集（原 if (graphData) 分支）。 */
  graphData?: unknown;
  codingExec: ToolExecutor;
  /** ask_user 的 UI 回调（builder 从 BuilderDeps.onAskUser 注入）。 */
  ui?: CodingToolsUI;
  /** dataflow_save 完成回调（builder 从 BuilderDeps.onDataflowSaved 注入）。 */
  onDataflowSaved?: () => void;
  skillRegistry?: SkillRegistry;
  memoryManager?: MemoryManager;
  taskManager: TaskManager;
  subAgentPool: SubAgentPool;
  subAgentSpawner?: SubAgentSpawner;
}

/** 内置工具行：id 寻址 + factory 延迟实例化（支持异步族，如
 *  browser/desktop 动态 import）。
 *  id 惯例 `builtin/<family>`——与外部贡献（services.ts 的
 *  ToolContribution，id 形如 `<plugin>/<tool>`）区分命名空间。 */
export interface BuiltinToolRow {
  id: string;
  factory: (ctx: ToolRowContext) => Tool[] | Promise<Tool[]>;
}

/** web 族行（S1-2 第五批迁入）——单工具 web_fetch。 */
const WEB_ROW: BuiltinToolRow = {
  id: 'builtin/web',
  factory: (ctx) => createWebTools(ctx.codingExec),
};

/** browser/desktop 族行——动态 import（原装配同款）。 */
const BROWSER_DESKTOP_ROW: BuiltinToolRow = {
  id: 'builtin/browser-desktop',
  factory: async () => {
    const { createBrowserTools, createDesktopTools } = await import('../agent/tools/browser');
    return [...createBrowserTools(), ...createDesktopTools()];
  },
};

/** 内置行表 — 表序 = 组合序 = standard preset 装配序。
 *  buildToolRegistry 末端整体读本表（S1-3 起）；行内工具名冲突由
 *  ToolRegistry.register 装载期拒绝（duplicate throw）。 */
export function builtinToolRows(): BuiltinToolRow[] {
  return [WEB_ROW, BROWSER_DESKTOP_ROW];
}
