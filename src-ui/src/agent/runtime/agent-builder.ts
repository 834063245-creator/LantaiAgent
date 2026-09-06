// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentBuilder — 从 bootstrap.ts 提取的纯组合逻辑
//
// 职责：
//   - 构建 ToolRegistry（hologram tools + coding tools + memory + skill + task）
//   - 构建 system prompt
//   - 加载引擎快照（loadEngineSnapshot）
//
// 不依赖：React, zustand, ui/event bus, ui/panel-store, ui/chat-store
//
// UI 回调通过 BuilderDeps 注入，不直接 import ui/ 模块。

import { assembleSystemPrompt, type PromptSection } from '../../composition/prompt-sections';
import { factoryComposition } from '../../composition/roster';
import type { BuiltinToolRow, ToolRowContext } from '../../composition/tool-rows';
import { typedJsonRpc } from '../../rpc-contract';
import type { Agent } from '../agent';
import { createCompactionTools } from '../compaction-model';
import type { GraphContext, GraphSnapshot } from '../hooks';
import { type McpClient, registerMcpTools } from '../mcp';
import type { ToolExecutor } from '../tool';
import { agentInvoke, ToolRegistry } from '../tool';
import { convergeRegistry } from '../tools/domains';
import { execStreamedShell } from './queued-shell';

// ── Types ──

/** UI 依赖注入 — 由调用者（UI 层）提供，agent-builder 不直接 import ui/ */
export interface BuilderDeps {
  /** ask_user 工具的 UI 请求回调（单问 string[]；批量 questions + answers 数组） */
  onAskUser?: (req: import('../tools/coding').AskUserRequest) => void;
  /** exit_plan_mode 工具的计划审批回调（UI 展示计划审批 banner） */
  onPlanReview?: (req: import('../plan/plan-tools').PlanReviewRequest) => void;
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

// MCP Schema 加载与工具转换已迁至 agent/tools/hologram.ts（S1-3 机械迁出，
// composition/tool-rows 的行 factory 复用；本地定义删除避免双源）。

// ── Graph helpers ──

export function extractGraphNodeNames(graphData: unknown): string[] | undefined {
  // Phase 1.5：graphData = 聚合快照 —— 记忆召回锚点从全量节点名缩到
  // top 扇入/扇出枢纽（聚合面自然范围；全量名单在 kernel 级仓库本就过重）。
  const snap = graphData as { top_fan_in?: Array<{ name?: string }>; top_fan_out?: Array<{ name?: string }> } | null;
  if (!snap || typeof snap !== 'object') return undefined;
  const names = [...(snap.top_fan_in ?? []), ...(snap.top_fan_out ?? [])]
    .map((n) => String(n.name || ''))
    .filter(Boolean);
  return names.length > 0 ? names : undefined;
}

// ── System prompt builder ──
// S1-4 起 persona/规则段落拆入 composition/prompt-sections 的 section
// 注册表（表序 = 拼装序，装配面经 applicable 分流）；本函数是签名
// 兼容壳——组装逻辑机械迁至 assembleSystemPrompt，standard 拼装结果
// 逐字节不变（system-prompt.fixture 快照守护）。
// 三面解耦（2026-08-25）：hasProject = projectPath 非空（占位工作区
// path='' = 零目录面）——绑目录但关图谱引擎的 Agent 不再跌进零目录
// 简短面，null 图 + 非空路径 = 关引擎面（行为规则/协作模式等照常注入）。

export function buildSystemPrompt(
  graphData: GraphSnapshot | null | undefined,
  projectPath: string,
  memorySection = '',
  graphSnapshot = '',
  claudeMdSection = '',
  providerName?: string,
  shellEnvSection = '',
  sections?: PromptSection[],
): string {
  return assembleSystemPrompt(
    {
      graphData,
      projectPath,
      hasProject: projectPath !== '',
      memorySection,
      graphSnapshot,
      claudeMdSection,
      providerName,
      shellEnvSection,
    },
    sections,
  );
}

// ── Tool registry builder ──

export interface ToolRegistryOptions {
  graphData: GraphSnapshot | null;
  deps: BuilderDeps;
  memoryManager?: MemoryManager;
  skillRegistry?: SkillRegistry;
  taskManager: TaskManager;
  subAgentPool: SubAgentPool;
  /** 子 Agent spawn 函数 — 由 Runtime 注入 */
  subAgentSpawner?: SubAgentSpawner;
  /** 外部 MCP server client 列表 — 其工具以 mcp__<server>__<name> 注册进 registry */
  mcpClients?: McpClient[];
  /** 工具行表（S2-1 组合外化穿线）——roster 解析产物（composition-store）。
   *  缺省 = factoryComposition().tools 出厂组合快照（builtin 行 + 当前通道
   *  贡献行，S4-4 甲统一解析域；现行行为零漂移保证）。 */
  toolRows?: BuiltinToolRow[];
}

import type { SubAgentPool } from '../coordinator';
import type { MemoryManager } from '../memory';
import type { SkillRegistry } from '../skills';
import type { TaskManager } from '../task';
import type { SubAgentSpawner } from '../tools/subagent';

export async function buildToolRegistry(opts: ToolRegistryOptions): Promise<ToolRegistry> {
  const {
    graphData,
    deps,
    memoryManager: mm,
    skillRegistry,
    taskManager,
    subAgentPool,
    subAgentSpawner,
    mcpClients,
    toolRows,
  } = opts;
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
    // 'process_cap'；args 是 provider 映射后的顶层 snake 形，与 tests/ab/
    // ab-tools.ts 的 kernelExec 互为镜像）。后台三动词直通 ledger。
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
  // 全部内置族（hologram/fs/shell/git/search/web/agent-isolation/ask/
  // skill/memory/task/agent/browser-desktop/wait）的工厂与组合序都在行表
  // ——表序 = 组合序（前缀缓存语义的根基）。行内工具名冲突由
  // ToolRegistry.register 装载期拒绝（duplicate throw）。
  // S2-1：行表可注入（roster 组合解析产物）；缺省 = 出厂表（零漂移）。
  const rowCtx: ToolRowContext = {
    graphData,
    codingExec,
    ui: { askUser: deps.onAskUser ?? (() => {}) },
    skillRegistry,
    memoryManager: mm,
    taskManager,
    subAgentPool,
    subAgentSpawner,
  };
  // ── 行表装配（S4-4 甲：builtin 行 + 插件贡献行统一进组合解析域）──
  // 全部内置族（hologram/web/ask/skill/memory/task/agent/browser-desktop/
  // wait）的工厂与组合序在行表；插件贡献行（plugin/<贡献 id>，composition/
  // plugin-tool-rows 折算）由组合解析产物一并携带（factoryComposition 快照
  // 收编两类行，序 = builtin 在前、贡献行随后）。
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

  // ── 外部 MCP server 工具（mcp__<server>__<name>）──
  // 由调用方（Runtime/UI）在构建时传入已连接好的 McpClient 列表；
  // 这里把其远端工具注册进 registry，Agent 就能像本地工具一样调用。
  if (mcpClients && mcpClients.length > 0) {
    for (const client of mcpClients) {
      if (client.isConnected) {
        registerMcpTools(client, registry);
      }
    }
  }

  // ── 工具层收敛：领域工具 + 隐藏旧名（旧工具保留在 registry 供 executor/测试解析）──
  convergeRegistry(registry);

  return registry;
}

// ── Compaction tools ──

export function registerCompactionTools(agent: Agent, reg: ToolRegistry): void {
  for (const tool of createCompactionTools(
    () => agent.getCompactionTracker(),
    () => ({
      compactRatio: agent.getCompactRatio(),
      recentKeep: agent.getRecentKeep(),
      contextWindow: agent.getContextWindow(),
    }),
    async () => agent.loadCompactionConfig(),
  )) {
    reg.register(tool);
  }
}

// ── Engine snapshot ──

export async function loadEngineSnapshot(ctx: GraphContext, projectPath: string, isRefresh = false): Promise<void> {
  try {
    // 引擎快照四路数据的宽松形态（引擎字段名跨版本有别名，保持宽容读取）
    // biome-ignore lint/suspicious/noExplicitAny: 引擎响应宽容读取别名字段，与旧 JSON.parse 返回 any 同宽
    type EngineJson = Record<string, any>;
    // hologram_call 载荷随工具不恒定（边界粗检 z.unknown()），工具面宽容读取
    // 收敛在 holo 这一个出口（载荷校验归 define-tool 工具面体系）。
    const holo = (tool: string, args: Record<string, unknown>): Promise<EngineJson> =>
      typedJsonRpc('hologram_call', { tool, args }) as Promise<EngineJson>;
    const asSymbols = (v: unknown): Array<{ name?: string; location?: string; file?: string }> =>
      Array.isArray(v) ? (v as Array<{ name?: string; location?: string; file?: string }>) : [];
    const [fragileData, cycleData, healthData, blindspotsData] = await Promise.all([
      holo('fragile_modules', { limit: 15 }),
      holo('detect_cycles', { mode: 'all' }),
      holo('project_health', { path: projectPath, days: 30 }),
      holo('arch_blindspots', { filter: 'all' }).catch(
        (): EngineJson => ({
          blindspots: [],
        }),
      ),
    ]);
    const fragilityRanks: Array<{ file: string; score: number }> = [];
    if (fragileData.fragile_modules || fragileData.modules) {
      const list = fragileData.fragile_modules || fragileData.modules;
      for (const m of list)
        fragilityRanks.push({ file: m.file || m.module || '', score: m.fragility_score || m.score || 0 });
    }
    const cycleCount = cycleData.total_cycles || cycleData.cycles?.length || 0;
    const healthScore = healthData.coupling_density_score || healthData.score || 0;
    const synthesisAlerts: Array<{ type: string; count: number; detail: string }> = [];
    const rawBlindspots = blindspotsData.blindspots || blindspotsData.alerts || [];
    const typeCounts = new Map<string, number>();
    for (const b of rawBlindspots) {
      const t = b.type || b.kind || 'unknown';
      typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
    }
    for (const [type, count] of typeCounts)
      synthesisAlerts.push({ type, count, detail: `${count} detected in project` });
    const lspHotspots: Array<{ file: string; symbol: string; callers: number }> = [];
    for (const r of fragilityRanks.slice(0, 5)) {
      if (r.score > 100)
        lspHotspots.push({
          file: r.file,
          symbol:
            r.file
              .split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '') || '',
          callers: Math.round(r.score / 10),
        });
    }
    const lspCallers = new Map<string, Array<{ symbol: string; count: number }>>();
    for (const r of fragilityRanks.slice(0, 3)) {
      try {
        const resolveData = await holo('resolve_call', {
          file: r.file,
        }).catch((): EngineJson => ({}));
        if (resolveData.calls && Array.isArray(resolveData.calls)) {
          const fc = new Map<string, number>();
          for (const c of resolveData.calls) {
            const fn = c.callee || c.function || c.name || '';
            if (fn) fc.set(fn, (fc.get(fn) || 0) + 1);
          }
          const sorted = [...fc.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([symbol, count]) => ({ symbol, count }));
          if (sorted.length > 0) lspCallers.set(r.file, sorted);
        }
      } catch {}
    }
    const semanticNeighbors = new Map<string, Array<{ name: string; file: string }>>();
    for (const r of fragilityRanks.slice(0, 3)) {
      const symbol =
        r.file
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') || '';
      if (!symbol) continue;
      try {
        const searchData = await holo('search_symbols', {
          query: symbol,
          limit: 5,
        }).catch((): EngineJson => ({ results: [] }));
        const results = asSymbols(searchData.results);
        const neighbors = results
          .filter((s) => (s.name || '').toLowerCase() !== symbol.toLowerCase())
          .slice(0, 3)
          .map((s) => ({ name: s.name || '', file: s.location || s.file || '' }));
        if (neighbors.length > 0) semanticNeighbors.set(r.file, neighbors);
      } catch {}
    }
    let baselineFragility: Map<string, number>;
    let sessionDrift = 0;
    if (!isRefresh && !ctx.engine) {
      baselineFragility = new Map<string, number>();
      for (const r of fragilityRanks) baselineFragility.set(r.file, r.score);
    } else {
      const prev = ctx.engine?.baselineFragility;
      if (prev && prev.size > 0) {
        let delta = 0;
        for (const r of fragilityRanks) {
          const before = prev.get(r.file) ?? 0;
          if (r.score > before) delta += (r.score - before) / Math.max(before, 1);
        }
        sessionDrift = delta;
      }
      baselineFragility = ctx.engine?.baselineFragility ?? new Map();
    }
    ctx.engine = {
      fragilityRanks,
      cycleCount,
      healthScore,
      baselineFragility,
      sessionDrift,
      lspHotspots,
      lspCallers,
      synthesisAlerts,
      semanticNeighbors,
      vectorReady: semanticNeighbors.size > 0,
    };
  } catch (e) {
    console.warn('[loadEngineSnapshot] engine data unavailable:', e);
  }
}

let _snapshotRefreshTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleEngineSnapshotRefresh(ctx: GraphContext, projectPath: string): void {
  if (_snapshotRefreshTimer) clearTimeout(_snapshotRefreshTimer);
  _snapshotRefreshTimer = setTimeout(() => {
    _snapshotRefreshTimer = null;
    loadEngineSnapshot(ctx, projectPath, true).catch(() => {});
  }, 3000);
}

/** 取消在途的引擎快照刷新 timer — Workspace 停用/强清时登记进 bag（无泄漏）。 */
export function cancelEngineSnapshotRefresh(): void {
  if (_snapshotRefreshTimer) {
    clearTimeout(_snapshotRefreshTimer);
    _snapshotRefreshTimer = null;
  }
}
