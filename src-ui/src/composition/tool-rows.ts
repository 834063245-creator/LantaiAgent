// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置工具行表（S1-2/S1-3）—— composition 架构的装配数据源。
// 现存 12 族：hologram(graph/ops/lsp)、fs、shell、web、agent-isolation、
// ask、skill、memory、task、agent、browser-desktop、wait。
// git/search 两族已于 P4 B①（2026-08-23）迁入 ctx.tools 第一方插件通道
// （plugins/git-search-plugin.ts，经 composition/first-party-tools.ts 装载）。
// 表序 = 组合序（standard preset 装配序的事实来源）——前缀缓存语义的根基。
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

import { z } from 'zod';
import type { SubAgentPool } from '../agent/coordinator';
import type { MemoryManager } from '../agent/memory';
import type { SkillRegistry } from '../agent/skills';
import { createSkillTool } from '../agent/skills';
import type { TaskManager } from '../agent/task';
import { createTaskTools } from '../agent/task';
import type { Tool, ToolExecutor } from '../agent/tool';
import { agentInvoke } from '../agent/tool';
import type { CodingToolsUI } from '../agent/tools/coding';
import {
  createAgentIsolationTools,
  createAskUserTools,
  createFsTools,
  createShellTools,
  createWebTools,
} from '../agent/tools/coding';
import { defineTool } from '../agent/tools/define-tool';
import { loadHologramSchemas, mcpSchemaToTool } from '../agent/tools/hologram';
import type { SubAgentSpawner } from '../agent/tools/subagent';
import { createAgentStatusTool, createSubAgentTool } from '../agent/tools/subagent';
import { createWaitTool } from '../agent/tools/wait';
import { typedRpc } from '../rpc-contract';

/** 行装配上下文 — buildToolRegistry 提供的全部运行时依赖。
 *  可选字段的缺席 = 该行产出空集（族内工具按依赖存在性条件注册，
 *  与迁移前 builder 的 if 分支语义一致）。 */
export interface ToolRowContext {
  /** graph/ops/lsp 族的开关：缺帐时该行产出空集（原 if (graphData) 分支）。 */
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

/** 内置工具行：id 寻址 + factory 延迟实例化（支持异步族，如 hologram
 *  动态 schema 加载与 browser/desktop 动态 import）。
 *  id 惯例 `builtin/<family>`——与外部贡献（services.ts 的
 *  ToolContribution，id 形如 `<plugin>/<tool>`）区分命名空间。 */
export interface BuiltinToolRow {
  id: string;
  factory: (ctx: ToolRowContext) => Tool[] | Promise<Tool[]>;
}

/** hologram 族行（graph/ops/lsp 动态工具 + dataflow 对）。
 *  graphData 缺帐时产出空集；holoExec 与 dataflow 定义从
 *  agent-builder 机械迁出（零改写）。 */
const HOLOGRAM_ROW: BuiltinToolRow = {
  id: 'builtin/hologram',
  factory: async (ctx) => {
    if (!ctx.graphData) return [];
    const holoExec: ToolExecutor = async (name, args) => {
      const result = await typedRpc('hologram_call', { tool: name, args });
      return typeof result === 'string' ? result : JSON.stringify(result);
    };
    const schemas = await loadHologramSchemas();
    const tools = schemas.map((s) => mcpSchemaToTool(s, holoExec));
    tools.push(
      defineTool({
        name: 'dataflow_save',
        description: '保存数据流追踪结果到 .lantai/dataflow/，供面板查看和后续查询。',
        schema: z.object({
          query: z.string(),
          content: z.string(),
        }),
        execute: async (args) => {
          const r = await agentInvoke('dataflow_save', args);
          ctx.onDataflowSaved?.();
          return r;
        },
      }),
    );
    tools.push(
      defineTool({
        name: 'dataflow_query',
        description: '查询已保存的数据流追踪结果。',
        schema: z.object({
          traceId: z.string().optional(),
          list: z.boolean().optional(),
        }),
        readOnly: true,
        execute: (args) => agentInvoke('dataflow_query', args),
      }),
    );
    return tools;
  },
};

/** fs 族行（S1-2 第一批迁入）。
 *  factory 与 createCodingTools 内的 fs 面同源（createFsTools），
 *  序 = 迁移前 createCodingTools 内的现行表序（机械重述）。 */
const FS_ROW: BuiltinToolRow = {
  id: 'builtin/fs',
  factory: (ctx) => createFsTools(ctx.codingExec),
};

/** shell 族行（S1-2 第二批迁入）。
 *  factory 与 createCodingTools 内的 shell 面同源（createShellTools），
 *  序 = 迁移前现行表序（run_shell → bash_output/kill/wait）。 */
const SHELL_ROW: BuiltinToolRow = {
  id: 'builtin/shell',
  factory: (ctx) => createShellTools(ctx.codingExec),
};

/** git 族行与 search 族行已迁出（P4 B①，2026-08-23）——两族改经 ctx.tools
 *  贡献通道注册（plugins/git-search-plugin.ts）；行 id 'builtin/git' /
 *  'builtin/search' 退役，贡献行 id 形如 'plugin/hologram/git-domain/<工具名>'。
 *  迁出依据（baton7 §1 勘定）：两族只依赖无状态 codingExec，实例缓存语义
 *  等价；可见域工具面由 DOMAIN_SPECS 驱动，与注册通道无关（零漂移）。 */

/** web 族行（S1-2 第五批迁入）——单工具 web_fetch。 */
const WEB_ROW: BuiltinToolRow = {
  id: 'builtin/web',
  factory: (ctx) => createWebTools(ctx.codingExec),
};

/** agent-isolation 族行（S1-2 第六批迁入）——worktree 隔离 5 工具。 */
const AGENT_ISOLATION_ROW: BuiltinToolRow = {
  id: 'builtin/agent-isolation',
  factory: (ctx) => createAgentIsolationTools(ctx.codingExec),
};

/** ask 族行（S1-2 第七批迁入）——常驻 ask_user（模型可见的细粒度名）。
 *  ui 缺帐时工具仍注册，execute 返回「UI 未接线」错误（原行为保留）。 */
const ASK_ROW: BuiltinToolRow = {
  id: 'builtin/ask',
  factory: (ctx) => createAskUserTools(ctx.ui),
};

/** skill 族行——skillRegistry 缺帐时空集（原 if 分支）。 */
const SKILL_ROW: BuiltinToolRow = {
  id: 'builtin/skill',
  factory: (ctx) => (ctx.skillRegistry ? [createSkillTool(ctx.skillRegistry)] : []),
};

/** memory 族行——memoryManager 缺帐时空集（原 if 分支 + 动态 import）。 */
const MEMORY_ROW: BuiltinToolRow = {
  id: 'builtin/memory',
  factory: async (ctx) =>
    ctx.memoryManager ? ((await import('../agent/memory')).createMemoryTools(ctx.memoryManager) as Tool[]) : [],
};

/** task 族行——TaskManager 是必填依赖（原装配无条件注册）。 */
const TASK_ROW: BuiltinToolRow = {
  id: 'builtin/task',
  factory: (ctx) => createTaskTools(ctx.taskManager),
};

/** agent 族行（子 Agent 工具对）——subAgentSpawner 缺帐时空集（原 if 分支）。 */
const AGENT_ROW: BuiltinToolRow = {
  id: 'builtin/agent',
  factory: (ctx) =>
    ctx.subAgentSpawner
      ? [createSubAgentTool(ctx.subAgentSpawner, ctx.subAgentPool), createAgentStatusTool(ctx.subAgentPool)]
      : [],
};

/** browser/desktop 族行——动态 import（原装配同款）。 */
const BROWSER_DESKTOP_ROW: BuiltinToolRow = {
  id: 'builtin/browser-desktop',
  factory: async () => {
    const { createBrowserTools, createDesktopTools } = await import('../agent/tools/browser');
    return [...createBrowserTools(), ...createDesktopTools()];
  },
};

/** wait 族行——常驻 wait（模型可见名，替代轮询循环）。 */
const WAIT_ROW: BuiltinToolRow = {
  id: 'builtin/wait',
  factory: (ctx) => [createWaitTool(ctx.subAgentPool)],
};

/** 内置行表 — 表序 = 组合序 = standard preset 装配序。
 *  buildToolRegistry 末端整体读本表（S1-3 起）；行内工具名冲突由
 *  ToolRegistry.register 装载期拒绝（duplicate throw）。 */
export function builtinToolRows(): BuiltinToolRow[] {
  return [
    HOLOGRAM_ROW,
    FS_ROW,
    SHELL_ROW,
    WEB_ROW,
    AGENT_ISOLATION_ROW,
    ASK_ROW,
    SKILL_ROW,
    MEMORY_ROW,
    TASK_ROW,
    AGENT_ROW,
    BROWSER_DESKTOP_ROW,
    WAIT_ROW,
  ];
}
