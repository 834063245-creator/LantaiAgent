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
import type { GraphContext, GraphDataShape } from '../hooks';
import { buildFileNodeIndex, createGraphContext } from '../hooks';
import { errText } from '../loop-helpers';
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
  /** dataflow_save 后的通知（UI 面板刷新） */
  onDataflowSaved?: () => void;
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
  if (!graphData || typeof graphData !== 'object') return undefined;
  const gd = graphData as Record<string, unknown>;
  const nodes = gd.nodes;
  if (!nodes) return undefined;
  if (Array.isArray(nodes)) {
    return nodes
      .map((n: unknown) => {
        if (typeof n === 'string') return n;
        if (typeof n === 'object' && n !== null) {
          const obj = n as Record<string, unknown>;
          return String(obj.id || obj.name || obj.file || '');
        }
        return '';
      })
      .filter(Boolean);
  }
  if (typeof nodes === 'object') {
    return Object.keys(nodes as Record<string, unknown>);
  }
  return undefined;
}

export function buildGraphContextFromData(graphData: GraphDataShape | null | undefined): GraphContext | null {
  if (!graphData) return null;
  const { fileIndex, fanIn, fanOut } = buildFileNodeIndex(graphData);
  return createGraphContext(fileIndex, fanIn, fanOut);
}

// ── System prompt builder ──
// S1-4 起 persona/规则段落拆入 composition/prompt-sections 的 section
// 注册表（表序 = 拼装序，两装配面经 applicable 分流）；本函数是签名
// 兼容壳——组装逻辑机械迁至 assembleSystemPrompt，standard 拼装结果
// 逐字节不变（system-prompt.fixture 快照守护）。

export function buildSystemPrompt(
  graphData: GraphDataShape | null | undefined,
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
  graphData: GraphDataShape | null;
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
  // 后台任务等待总上限:后台 job 若卡死(如 cargo 等待 target 文件锁)可能无限期运行,
  // 无总上限时下面的 for(;;) 循环永远 pending,Agent 会话表现为"无限等待 shell 结果"。
  const BG_WAIT_TIMEOUT = 30 * 60 * 1000;
  const codingExec: ToolExecutor = async (name, args, onProgress, signal) => {
    if (name === 'run_shell' && args.runInBackground) {
      // 命令名必须是 exec_command(run_shell 不是 Tauri 命令),args 已含 runInBackground: true
      const raw = await agentInvoke<string>('exec_command', args);
      const m = /ID:\s*(\d+)/.exec(raw);
      if (!m) return raw; // 启动失败 — 把 Rust 返回的消息直接给 agent（含构建锁打回）
      const jobId = m[1];
      let last = '';
      const bgDeadline = Date.now() + BG_WAIT_TIMEOUT;
      for (;;) {
        try {
          last = await agentInvoke<string>('bash_wait', { job_id: jobId, timeout_ms: 60_000 });
        } catch (e) {
          const msg = errText(e);
          if (msg.includes('等待超时')) {
            // 任务仍在跑 — 检查总超时,超时则放弃等待并把控制权交还 Agent
            if (Date.now() >= bgDeadline) {
              return `[exit -1] 后台任务已等待 ${BG_WAIT_TIMEOUT / 1000}s 仍未完成,已放弃等待(可能卡在文件锁或等待输入)。当前输出:\n${last}\n可用 bash_output(${jobId}) 查看进度, bash_kill(${jobId}) 终止任务。`;
            }
            if (onProgress) onProgress(`[后台任务运行中, job_id: ${jobId}]`);
            continue;
          }
          // 任务已被清理(完成或 kill)— 带最后已知输出返回
          return last ? `[后台任务结束]\n${last}` : `后台任务查询失败: ${msg}`;
        }
        if (last.includes('[任务已完成')) return last;
        if (onProgress) onProgress(last); // 每 60s 报一次进度
      }
    }
    if (name === 'exec_command' && !args.runInBackground) {
      // 直连流式执行（取消语义 + 600s 兜底）— 实现见 queued-shell.ts。
      // 构建锁冲突由 Rust 打回（错误信息直接返回，模型据此重试/等待）。
      return execStreamedShell(args, onProgress, signal);
    }
    // ── Timeout wrapper for search/list tools — prevent stuck Tauri invokes ──
    const TOOL_TIMEOUT = 120_000;
    const TIMEOUT_TOOLS = new Set(['search_content', 'search_code', 'glob', 'list_directory']);
    if (TIMEOUT_TOOLS.has(name)) {
      return new Promise<string>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(`(工具 ${name} 超时 (${TOOL_TIMEOUT / 1000}s)，请缩小搜索范围或使用更精确的模式)`);
        }, TOOL_TIMEOUT);
        agentInvoke<string>(name, args)
          .then((result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(typeof result === 'string' ? result : JSON.stringify(result));
          })
          .catch((e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(`错误: ${errText(e)}`);
          });
      });
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
    onDataflowSaved: () => deps.onDataflowSaved?.(),
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
  // 收编两类行，序 = builtin 在前、贡献行随后）。单一循环装配，行表源 =
  // 注入的组合解析产物；缺省 = 出厂组合（当前通道装载态的完整基座）。
  // 表序 = 组合序（前缀缓存语义的根基）；行内工具名冲突由
  // ToolRegistry.register 装载期拒绝（duplicate throw）。
  for (const row of toolRows ?? factoryComposition().tools) {
    for (const tool of await row.factory(rowCtx)) registry.register(tool);
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
    () => agent.getPricing(),
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
    const asSymbols = (v: unknown): Array<{ name?: string; location?: string; file?: string }> =>
      Array.isArray(v) ? (v as Array<{ name?: string; location?: string; file?: string }>) : [];
    const [fragileData, cycleData, healthData, blindspotsData] = await Promise.all([
      typedJsonRpc<EngineJson>('hologram_call', { tool: 'fragile_modules', args: { limit: 15 } }),
      typedJsonRpc<EngineJson>('hologram_call', { tool: 'detect_cycles', args: { mode: 'all' } }),
      typedJsonRpc<EngineJson>('hologram_call', { tool: 'project_health', args: { path: projectPath, days: 30 } }),
      typedJsonRpc<EngineJson>('hologram_call', { tool: 'arch_blindspots', args: { filter: 'all' } }).catch(
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
        const resolveData = await typedJsonRpc<EngineJson>('hologram_call', {
          tool: 'resolve_call',
          args: { file: r.file },
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
        const searchData = await typedJsonRpc<EngineJson>('hologram_call', {
          tool: 'search_symbols',
          args: { query: symbol, limit: 5 },
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
