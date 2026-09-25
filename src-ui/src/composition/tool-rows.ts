// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 工具行模型 + 行装配上下文（S1-2/S1-3 起 composition 架构的装配数据源；
// ①b 收官 2026-08-23：builtin 行表全量迁毕退役——web + browser-desktop
// 是最后两族，与 git/search（B①）+ fs/shell/agent-isolation（②）+
// wait/ask/memory/skill/task/agent/hologram（①c）合计十四族全部经
// ctx.tools 第一方插件通道贡献
// （plugins/coding-domain-plugins.ts，经 composition/first-party-tools.ts
// 装载——无状态族实例缓存 / 装配期真值族 noCache 每装配重创）。
// 本文件保留两件事：行形状（BuiltinToolRow——plugin-tool-rows 折算贡献
// 行的载体）与行装配上下文（ToolRowContext——buildToolRegistry 提供给
// 行 factory 的运行时依赖，贡献 factory 与行 factory 同一签名）。
// 表序 = 组合序（standard preset 装配序的事实来源）——前缀缓存语义的根基
// （①b 后行真源 = factoryComposition().tools = pluginToolRows()，序 =
// firstPartyToolPlugins 清单序）。
//
// 迁入纪律（S1 设计件 §2.4）：每迁一族，不设 CONVERGENCE_PRESET 跑
// verify:convergence，三个 tool-schemas 快照必须逐字节零漂移——迁行是
// 现行装配的机械重述，不是行为变更。
//
// 装配可见面说明：细粒度工具名在领域收敛（convergeRegistry）后全部
// hidden（ask_user 与 wait 例外，它们是常驻可见名），可见面 = 域工具
// （schema 由 DOMAIN_SPECS 声明序构造）+ ask_user + wait——与注册序
// 无关，行迁不改变可见面，零漂移按构造成立。
//
// 不属于行表的装配步骤（保留在 buildToolRegistry 末端）：read_file 别名
// （注册表操作非工具定义）、convergeRegistry。MCP 工具全量经插件/用户级
// mcp.json 折算行贡献（mcp-bridge / user-mcp）——mcpClients 直连旁路已删
// （2026-09-07，skills-mcp-production-plan Commit 6 死代码清理，零调用方）。
// S4-4 甲（2026-08-23）：插件贡献行经 factoryComposition() 快照进组合
// 解析域——patch/preset 寻址 'plugin/<插件名>/<工具名>' 行（builtin/<族>
// 行 id 已随行表退役终结，不复存在）。

import type { MemoryManagerFace } from '../agent/memory-contract';
import type { SkillRegistryFace } from '../agent/skill-contract';
import type { SubAgentPool } from '../agent/subagent-runtime-contract';
import type { SubAgentSpawner } from '../agent/subagent-tools-contract';
import type { TaskManager } from '../agent/task';
import type { CodingToolsUI, Tool, ToolExecutor } from '../agent/tool';

/** 行装配上下文 — buildToolRegistry 提供的全部运行时依赖。
 *  可选字段的缺席 = 该行/贡献产出空集（族内工具按依赖存在性条件注册，
 *  与迁移前 builder 的 if 分支语义一致）。 */
export interface ToolRowContext {
  codingExec: ToolExecutor;
  /** ask_user 的 UI 回调（builder 从 BuilderDeps.onAskUser 注入）。 */
  ui?: CodingToolsUI;
  skillRegistry?: SkillRegistryFace;
  memoryManager?: MemoryManagerFace;
  taskManager: TaskManager;
  subAgentPool: SubAgentPool;
  subAgentSpawner?: SubAgentSpawner;
}

/** 工具行：id 寻址 + factory 延迟实例化（支持异步族，如 browser/desktop
 *  动态 import）。
 *  行 id 命名空间（①b 后唯一来源）：'plugin/<贡献 id>'（composition/
 *  plugin-tool-rows 折算，贡献 id 形如 '<插件名>/<工具名>'）——'builtin/
 *  <family>' 前缀随 builtin 行表退役成为历史。 */
export interface BuiltinToolRow {
  id: string;
  factory: (ctx: ToolRowContext) => Tool[] | Promise<Tool[]>;
  /** 默认关（S6 P1，2026-09-15）：贡献面标记（ToolContribution.defaultOff）随
   *  折算行进解析域——组合解析据此把该行初始置为 disabled（显式 `disabled: false`
   *  可回开），诊断面据此区分「未选中」与「被禁用」。缺省（undefined）= 现行语义。 */
  defaultOff?: boolean;
}
