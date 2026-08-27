// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方工具域插件（P4 存量拆解 B① + ② + ①c + ①b，
// agent-plugin-architecture-plan §5）——从 composition/tool-rows 行表
// 迁入 ctx.tools 贡献通道，四批语义分家：
//  - **无状态族**（B① git/search + ② fs/shell/agent-isolation + ①b web，
//    六族）：只依赖 codingExec——实例缓存语义等价（闭包只引用模块级
//    agentInvoke/execStreamedShell，不捕获装配 opts）；
//  - **整组缓存行**（①b browser-desktop）：动态 import 族，一行贡献承载
//    整族（53 工具）——不收 rowCtx（无装配期依赖），实例缓存跨装配复用；
//  - **装配期真值族**（①c，2026-08-23 拍板 #2 路线一无缓存行）：
//    wait/ask + memory/skill/task/agent + hologram 七族——贡献声明 noCache
//    （pluginToolRows 每装配重调 factory，实例缓存不生效），工厂直收
//    rowCtx 装配期真值（subAgentPool / ui 回调 / 可选 registry / graphData
//    开关 + loadHologramSchemas 动态面），无跨装配串扰面。
//
// 可见面零漂移按构造成立：旧名在 convergeRegistry 后经
// collectHiddenToolNames 隐藏，可见域工具由 DOMAIN_SPECS 声明序重建
// （createDomainTools 按注册表现存旧工具过滤 action，注册序无关）——
// 走行表还是插件通道注册不改变模型可见面（phase-0 快照守护，双 preset
// 实测）。ask_user 与 wait 是常驻可见名（不受域收敛影响）。
//
// 寻址域（S4-4 甲恢复全量 + ①b 行表清空，2026-08-23）：贡献行经
// factoryComposition() 快照进组合解析域——patch/preset 可寻址
// 'plugin/hologram/<域>-domain/<工具名>' 行禁用单个工具（粒度 = 贡献行 =
// 单工具；browser-desktop/hologram 整族行 = 单行禁整族）。
//
// 一文件多插件：familyContributions（无状态族）/ noCacheContributions
// （装配期真值族）两个贡献清单 helper 由各域共享（族注册形状相同，拆文件
// 只会复制 helper——B① 落文件时已定此形）。

import { z } from 'zod';
import { createMemoryTools } from '../agent/memory';
import { createSkillTool } from '../agent/skills';
import { createTaskTools } from '../agent/task';
import type { Tool, ToolExecutor } from '../agent/tool';
import { agentInvoke } from '../agent/tool';
import {
  createAgentIsolationTools,
  createAskUserTools,
  createFsTools,
  createGitTools,
  createSearchTools,
  createShellTools,
  createWebTools,
} from '../agent/tools/coding';
import { defineTool } from '../agent/tools/define-tool';
import { loadHologramSchemas, mcpSchemaToTool } from '../agent/tools/hologram';
import { createAgentStatusTool, createSubAgentTool } from '../agent/tools/subagent';
import { createWaitTool } from '../agent/tools/wait';
import { graphExecute } from '../composition/graph-service';
import type { ToolContribution } from '../composition/services';
import type { ToolRowContext } from '../composition/tool-rows';
import type { Context } from '../cordis';

/** apply 期名字展开用的占位 exec——族工厂是纯函数，exec 只在工具 execute
 *  闭包里被引用，apply 期永不执行；占位符抛错保证任何误执行立即可见。 */
const NEVER_EXEC: ToolExecutor = async () => {
  throw new Error('[coding-domain-plugins] apply 期占位 exec 不应被调用');
};

/** ①c 族名序（手写清单——对拍族工厂声明序，防声明序漂移无人知；
 *  产出名面在 coding-domain-plugins.test 钉住）。 */
const TASK_TOOL_NAMES = ['task_create', 'task_update', 'task_list', 'task_get', 'task_stop'];
const MEMORY_TOOL_NAMES = [
  'hologram_memory_list',
  'hologram_memory_read',
  'hologram_memory_search',
  'hologram_memory_save',
  'hologram_memory_delete',
];

/** 域插件通用形状：ctx.tools.register 逐条 + disposer 逆序注销。 */
function registerFamily(ctx: Context, tag: string, contributions: ToolContribution[]) {
  ctx.effect(() => {
    const disposers = contributions.map((c) => ctx.tools.register(c));
    return () => {
      for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
    };
  }, tag);
}

/** 注册一个无状态工具族为贡献清单：每工具一条贡献（id = `<插件名>/<工具名>`）。
 *  贡献 factory 惰性建族——首个贡献装配时以真实 rowCtx.codingExec 构建，
 *  同族贡献共享一次建族（apply 作用域闭包，非模块级态）。 */
function familyContributions(pluginName: string, build: (exec: ToolExecutor) => Tool[]): ToolContribution[] {
  // apply 期展开一次取名字清单——真源是族工厂本身，不手抄名字表
  const names = build(NEVER_EXEC).map((t) => t.name());
  let family: Tool[] | null = null;
  return names.map((name) => ({
    id: `${pluginName}/${name}`,
    factory: (rowCtx) => {
      // 本通道贡献需要装配上下文（codingExec）——折算路径未穿 ctx 立即炸，
      // 不注入延迟爆炸的占位 exec（错误不静默）
      if (!rowCtx?.codingExec) {
        throw new Error(`[${pluginName}] 工具贡献 ${name} 需要装配上下文（codingExec）——折算路径未穿 rowCtx`);
      }
      family ??= build(rowCtx.codingExec);
      const tool = family.find((t) => t.name() === name);
      if (!tool) throw new Error(`[${pluginName}] 族内未找到工具 ${name} —— 族工厂输出漂移`);
      return tool;
    },
  }));
}

/** 注册一个装配期真值族为贡献清单（①c 无缓存行）：每工具一条 noCache 贡献
 *  ——factory 每装配重调（buildRow 每装配以当次 rowCtx 重建族），实例缓存
 *  对其不生效。buildRow 可为异步族（hologram 动态 schema 拉取）。
 *  names 必须显式给（族名序 = 声明序）——条件产出族（graphData 缺帐空集）
 *  无法无参展开取名，异步族 apply 期不展开。 */
function noCacheContributions(
  pluginName: string,
  buildRow: (rowCtx: ToolRowContext) => Tool[] | Promise<Tool[]>,
  names: string[],
): ToolContribution[] {
  return names.map((name) => ({
    id: `${pluginName}/${name}`,
    noCache: true,
    factory: async (rowCtx) => {
      if (!rowCtx) {
        throw new Error(`[${pluginName}] 工具贡献 ${name} 需要装配上下文——折算路径未穿 rowCtx`);
      }
      const family = await buildRow(rowCtx);
      const tool = family.find((t) => t.name() === name);
      if (!tool) return []; // 装配期条件族缺帐：该行无产出（原行 if 分支空集语义）
      return tool;
    },
  }));
}

// ── 无状态族（B① + ② + ①b web）──

/** web 域插件（①b 迁入，2026-08-23）——贡献 web_fetch 单工具。 */
export const webDomainPlugin = {
  name: 'hologram/web-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'web-domain-tools', familyContributions('hologram/web-domain', createWebTools));
  },
};

/** git 域插件——贡献 13 工具（序 = createGitTools 声明序）。 */
export const gitDomainPlugin = {
  name: 'hologram/git-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'git-domain-tools', familyContributions('hologram/git-domain', createGitTools));
  },
};

/** search 域插件——贡献 search_content 单工具。 */
export const searchDomainPlugin = {
  name: 'hologram/search-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'search-domain-tools', familyContributions('hologram/search-domain', createSearchTools));
  },
};

/** fs 域插件——贡献 11 工具（序 = createFsTools 声明序；② 批 2026-08-23）。 */
export const fsDomainPlugin = {
  name: 'hologram/fs-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'fs-domain-tools', familyContributions('hologram/fs-domain', createFsTools));
  },
};

/** shell 域插件——贡献 4 工具（run_shell → bash_output/kill/wait；② 批）。 */
export const shellDomainPlugin = {
  name: 'hologram/shell-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'shell-domain-tools', familyContributions('hologram/shell-domain', createShellTools));
  },
};

/** agent-isolation 域插件——贡献 worktree 隔离 5 工具（② 批）。 */
export const agentIsolationDomainPlugin = {
  name: 'hologram/agent-isolation-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'agent-isolation-domain-tools',
      familyContributions('hologram/agent-isolation-domain', createAgentIsolationTools),
    );
  },
};

// ── 整组缓存行（①b browser-desktop，2026-08-23）──

/** browser-desktop 域插件（①b 迁入）——动态 import 族（原装配同款），
 *  一行贡献承载整族（createBrowserTools + createDesktopTools，53 工具）。
 *  **为何整组形态而非 per-tool 名清单**：族大（53 名手抄清单必漂移）+
 *  名面被清单锁死（新增 browser_ / desktop_ 前缀工具不会自动进寻址域——
 *  hologram 动态面同款教训）；整族一行寻址（minimal preset 禁整族的
 *  原语义）恰是 preset 的使用形态。不收 rowCtx（无装配期依赖）→
 *  实例缓存跨装配复用（无状态闭包，语义等价）。 */
export const browserDesktopDomainPlugin = {
  name: 'hologram/browser-desktop-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const dispose = ctx.tools.register({
        id: 'hologram/browser-desktop-domain/tools',
        factory: async () => {
          const { createBrowserTools, createDesktopTools } = await import('../agent/tools/browser');
          return [...createBrowserTools(), ...createDesktopTools()];
        },
      });
      return () => dispose();
    }, 'browser-desktop-domain-tools');
  },
};

// ── 装配期真值族（①c 无缓存行，2026-08-23）──
// 工厂直收 rowCtx（subAgentPool/ui/registry/graphData 装配期真值）；贡献
// noCache 每装配重创——原行表 factory 语义逐字等价（行时代每次装配也是
// 重调 factory）。

/** wait 域插件——常驻 wait（依赖当次装配的 subAgentPool）。 */
export const waitDomainPlugin = {
  name: 'hologram/wait-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'wait-domain-tools',
      noCacheContributions('hologram/wait-domain', (rowCtx) => [createWaitTool(rowCtx.subAgentPool)], ['wait']),
    );
  },
};

/** ask 域插件——常驻 ask_user（ui 回调每次装配换新；缺帐时工具仍注册、
 *  execute 返回「UI 未接线」错误——原行语义保留）。 */
export const askDomainPlugin = {
  name: 'hologram/ask-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'ask-domain-tools',
      noCacheContributions('hologram/ask-domain', (rowCtx) => createAskUserTools(rowCtx.ui), ['ask_user']),
    );
  },
};

/** memory 域插件——memoryManager 缺帐时空集（原 if 分支语义）。 */
export const memoryDomainPlugin = {
  name: 'hologram/memory-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'memory-domain-tools',
      noCacheContributions(
        'hologram/memory-domain',
        (rowCtx) => (rowCtx.memoryManager ? createMemoryTools(rowCtx.memoryManager) : []),
        MEMORY_TOOL_NAMES,
      ),
    );
  },
};

/** skill 域插件——skillRegistry 缺帐时空集（原 if 分支语义）。 */
export const skillDomainPlugin = {
  name: 'hologram/skill-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'skill-domain-tools',
      noCacheContributions(
        'hologram/skill-domain',
        (rowCtx) => (rowCtx.skillRegistry ? [createSkillTool(rowCtx.skillRegistry)] : []),
        ['Skill'],
      ),
    );
  },
};

/** task 域插件——TaskManager 必填依赖（原装配无条件注册）。 */
export const taskDomainPlugin = {
  name: 'hologram/task-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'task-domain-tools',
      noCacheContributions('hologram/task-domain', (rowCtx) => createTaskTools(rowCtx.taskManager), TASK_TOOL_NAMES),
    );
  },
};

/** agent 域插件——subAgentSpawner 缺帐时空集（原 if 分支语义）。 */
export const agentDomainPlugin = {
  name: 'hologram/agent-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'agent-domain-tools',
      noCacheContributions(
        'hologram/agent-domain',
        (rowCtx) =>
          rowCtx.subAgentSpawner
            ? [
                createSubAgentTool(rowCtx.subAgentSpawner, rowCtx.subAgentPool),
                createAgentStatusTool(rowCtx.subAgentPool),
              ]
            : [],
        ['agent_spawn', 'agent_status'],
      ),
    );
  },
};

/** hologram 域插件（①c ③ 变体）——graph/ops/lsp 动态工具 + dataflow 对：
 *  graphData 是装配期开关（缺帐行产出空集——实例缓存会锁死首装配的有无，
 *  noCache 每装配现判）；loadHologramSchemas 动态面每装配刷新。
 *  **动态名承载**：工具名面在装配期才知（引擎/mock schema 各异）——本族
 *  不走 per-tool 名清单，而是「一行贡献承载整族」（factory 返回 Tool[]，
 *  S4-4 乙的整组形态；名字集 = 当次装配的 schemas + dataflow 对）。
 *  holoExec 与 dataflow 定义从 tool-rows 机械迁出（零改写）。 */
export const hologramDomainPlugin = {
  name: 'hologram/engine-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const dispose = ctx.tools.register({
        id: 'hologram/engine-domain/tools',
        noCache: true,
        factory: async (rowCtx) => {
          if (!rowCtx?.graphData) return []; // 缺帐 = 空集（原 if (graphData) 分支）
          const holoExec: ToolExecutor = async (name, args) => {
            // 平台化 Phase 2 · D11 施工⑦：engine 分析查询经 ctx.graph 注册表解析
            // provider（后注册胜；默认 builtin/rust-graph 经 hologram_call 派发）
            const result = await graphExecute(name, args);
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
      });
      return () => dispose();
    }, 'hologram-domain-tools');
  },
};
