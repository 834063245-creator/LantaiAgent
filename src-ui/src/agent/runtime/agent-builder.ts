// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// AgentBuilder — 从 bootstrap.ts 提取的纯组合逻辑
//
// 职责：
//   - 构建 ToolRegistry（coding tools + memory + skill + task）
//   - 构建 system prompt
//
// 不依赖：React, zustand, ui/event bus, ui/panel-store, ui/chat-store
//
// UI 回调通过 BuilderDeps 注入，不直接 import ui/ 模块。
//
// （图谱面——graphData 开关、loadEngineSnapshot 引擎快照、记忆召回图锚点
//  extractGraphNodeNames——随图谱功能全量退役删除，2026-09-09。）

import { assembleSystemPrompt, type PromptSection } from '../../composition/prompt-sections';
import { factoryComposition } from '../../composition/roster';
import type { BuiltinToolRow, ToolRowContext } from '../../composition/tool-rows';
import type { Agent } from '../agent';
import { requireCompactionImplementation } from '../compaction-impl';
import type { ToolExecutor } from '../tool';
import { agentInvoke, ToolRegistry } from '../tool';
import { convergeRegistry } from '../tools/domains';
import { execStreamedShell } from './queued-shell';

// ── Types ──

/** UI 依赖注入 — 由调用者（UI 层）提供，agent-builder 不直接 import ui/ */
export interface BuilderDeps {
  /** ask_user 工具的 UI 请求回调（单问 string[]；批量 questions + answers 数组） */
  onAskUser?: (req: import('../tool').AskUserRequest) => void;
  /** exit_plan_mode 工具的计划审批回调（UI 展示计划审批 banner） */
  onPlanReview?: (req: import('../plan/plan-contract').PlanReviewRequest) => void;
  /** LSP 诊断数据源（用于 state hooks） */
  diagnosticsSource?: {
    getDiagnosticsForFile(
      filePath: string,
    ): Promise<Array<{ line: number; severity: string; message: string; source: string }>>;
  };
  /** Shell 流式输出监听（由 UI 层提供 Tauri event listener） */
  shellStream?: {
    onOutput(streamId: string, cb: (chunk: string) => void): () => void;
    onDone(streamId: string, cb: (exitCode: number, error?: string) => void): () => void;
  };
}

// MCP Schema 加载与工具转换原在 agent/tools/hologram.ts——随图谱退役整删。

// ── System prompt builder ──
// S1-4 起 persona/规则段落拆入 composition/prompt-sections 的 section
// 注册表（表序 = 拼装序，装配面经 applicable 分流）；本函数是签名
// 兼容壳——组装逻辑机械迁至 assembleSystemPrompt，standard 拼装结果
// 逐字节不变（system-prompt.fixture 快照守护）。
// 两面（2026-09-09 图谱退役后）：hasProject = projectPath 非空
//（占位工作区 path='' = 零目录面）——有目录/零目录独立判面。

export function buildSystemPrompt(
  projectPath: string,
  memorySection = '',
  claudeMdSection = '',
  providerName?: string,
  shellEnvSection = '',
  sections?: PromptSection[],
  skillCatalog?: string,
  providerConfigPath?: string,
): string {
  const base = assembleSystemPrompt(
    {
      projectPath,
      hasProject: projectPath !== '',
      memorySection,
      claudeMdSection,
      providerName,
      shellEnvSection,
      providerConfigPath,
    },
    sections,
  );
  // 技能目录段（skills-mcp-production-plan Commit 2）：装配期追加技能
  // name+description 清单（模型据此发现可用技能）。空/缺省 = 无技能环境
  // 零注入——system-prompt fixture 与前缀缓存逐字节不变。
  if (!skillCatalog) return base;
  return `${base}

## 可用技能
以下技能可用。需要时用 Skill 工具按名执行（skill 参数 = 技能名）：
${skillCatalog}`;
}

// ── Tool registry builder ──

export interface ToolRegistryOptions {
  deps: BuilderDeps;
  memoryManager?: MemoryManager;
  skillRegistry?: SkillRegistry;
  taskManager: TaskManager;
  subAgentPool: SubAgentPool;
  /** 子 Agent spawn 函数 — 由 Runtime 注入 */
  subAgentSpawner?: SubAgentSpawner;
  /** 工具行表（S2-1 组合外化穿线）——roster 解析产物（composition-store）。
   *  缺省 = factoryComposition().tools 出厂组合快照（当前通道贡献行，
   *  S4-4 甲统一解析域；现行行为零漂移保证）。 */
  toolRows?: BuiltinToolRow[];
}

import type { MemoryManager } from '../memory';
import type { SkillRegistry } from '../skills';
import type { SubAgentPool } from '../subagent-runtime-contract';
import type { SubAgentSpawner } from '../subagent-tools-contract';
import type { TaskManager } from '../task';

export async function buildToolRegistry(opts: ToolRegistryOptions): Promise<ToolRegistry> {
  const { deps, memoryManager: mm, skillRegistry, taskManager, subAgentPool, subAgentSpawner, toolRows } = opts;
  const registry = new ToolRegistry();

  // ── Shell 执行（2026-08-10：队列退役，直连流式） ──
  // 多 Agent 构建锁互斥由 Rust 侧 BuildLock 承担（资源级原子检查 + 带路径打回，
  // 见 src-tauri/src/utils.rs）：冲突时 exec_command 返回错误，不排队不串行化。
  // abort 取消保留：bash_kill 携带 agent_id 身份，只能 kill 自己发起的 job。

  // ── Coding tools ──
  // 后台任务语义：run_shell(runInBackground) 启动即返 ID，模型经 bash_output
  // 自轮询（run_shell 描述如此引导）——通用路径直通即可。
  const codingExec: ToolExecutor = async (name, args, onProgress, signal) => {
    // R3-d（shell 域收口，kernel-capability-c3-design.md）：shell 域经
    // process_cap 能力口直呼（builtin.shell 信封退役）——codingExec 的特殊面
    // （前台流式执行）按 action + run_in_background 寻址（外层名恒
    // 'process_cap'；args 是 provider 映射后的顶层 snake 形）。后台三动词直通 ledger。
    if (name === 'process_cap') {
      const env = args as { action?: string; run_in_background?: boolean };
      if (env.action === 'exec_command' && !env.run_in_background) {
        // 直连流式执行（取消语义 + 600s 兜底）— 实现见 queued-shell.ts。
        // 构建锁冲突由 Rust 打回（错误信息直接返回，模型据此重试/等待）。
        return execStreamedShell(args, onProgress, signal);
      }
    }
    const result = await agentInvoke<string>(name, args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  };
  // ── 内置工具行表装配（composition/tool-rows，S1-3 起末端整体改读行表）──
  // 全部内置族（fs/shell/git/search/web/agent-isolation/ask/
  // skill/memory/task/agent/browser-desktop/wait）的工厂与组合序都在行表
  // ——表序 = 组合序（前缀缓存语义的根基）。行内工具名冲突由
  // ToolRegistry.register 装载期拒绝（duplicate throw）。
  // S2-1：行表可注入（roster 组合解析产物）；缺省 = 出厂表（零漂移）。
  const rowCtx: ToolRowContext = {
    codingExec,
    ui: { askUser: deps.onAskUser ?? (() => {}) },
    skillRegistry,
    memoryManager: mm,
    taskManager,
    subAgentPool,
    subAgentSpawner,
  };
  // ── 行表装配（S4-4 甲：builtin 行 + 插件贡献行统一进组合解析域）──
  // 插件贡献行（plugin/<贡献 id>，composition/plugin-tool-rows 折算）由组合
  // 解析产物一并携带（factoryComposition 快照收编两类行，序 = builtin 在前、
  // 贡献行随后）。
  // 表序 = 组合序（前缀缓存语义的根基）；行内工具名冲突由
  // ToolRegistry.register 装载期拒绝（duplicate throw）。
  // P2-3 优化（2026-09-02）：行工厂互相独立——Promise.all 并行执行全部
  // factory（构建工具定义的重活），结果按表序顺序 register（保序契约不变）。
  // N 行从 N 次串行 await 降到 max(单行)。
  const rows = toolRows ?? factoryComposition().tools;
  const rowResults = await Promise.all(rows.map((row) => row.factory(rowCtx)));
  for (const tools of rowResults) {
    for (const tool of tools) registry.register(tool);
  }

  registry.alias('read_file', 'read_file_content');

  // ── 工具层收敛：领域工具 + 隐藏旧名（旧工具保留在 registry 供 executor/测试解析）──
  convergeRegistry(registry);

  return registry;
}

// ── Compaction tools ──

export function registerCompactionTools(agent: Agent, reg: ToolRegistry): void {
  for (const tool of requireCompactionImplementation().createCompactionTools(
    () => agent.getCompactionTracker(),
    () => ({
      compactRatio: agent.getCompactRatio(),
      recentKeep: agent.getRecentKeep(),
      retainRatio: agent.getRetainRatio(),
      contextWindow: agent.getContextWindow(),
      summaryMaxTokens: agent.getSummaryMaxTokens(),
    }),
    async () => agent.loadCompactionConfig(),
  )) {
    reg.register(tool);
  }
}
