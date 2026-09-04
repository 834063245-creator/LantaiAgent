// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Workspace — 拥有一个已打开项目的全部状态。
// 替换 main.ts 中的 18+ 个模块级全局变量。
//
// 生命周期：
//   const ws = await Workspace.open(path, starGraph, chatPanel);
//   // ... 用户工作 ...
//   await ws.deactivate(chatPanel);
//
// 切换工作区是原子的：old.deactivate() → new = Workspace.open() → 赋值。

import type { Agent } from './agent/agent';
import { agentSessionState } from './agent/agent-session-state';
import { AgentStore } from './agent/agent-store';
import { resetAgentCaches } from './agent/cache-store';
import { SubAgentPool } from './agent/coordinator';
import { GoalManager } from './agent/goal-manager';
import { createGraphContext, type GraphContext, type GraphSnapshot, type NodeBrief } from './agent/hooks';
import { DisposerBag } from './agent/lifecycle';
import { initLogger, log } from './agent/logger';
import { MemoryManager } from './agent/memory';
import { memoryBundleIngest } from './agent/memory-bundle-client';
import {
  type BuilderDeps,
  buildToolRegistry,
  cancelEngineSnapshotRefresh,
  extractGraphNodeNames,
  scheduleEngineSnapshotRefresh,
} from './agent/runtime/agent-builder';
// ── 运行时层（替代 bootstrap.ts）──
import { AgentRuntime } from './agent/runtime/runtime';
import type { AgentHandle } from './agent/runtime/types';
import { SkillRegistry } from './agent/skills';
import { buildTurnStartBlock, refreshGitStatus, refreshTimeline } from './agent/state-inject';
import { TaskManager } from './agent/task';
import type { ToolRegistry } from './agent/tool';
import type { ChatCore } from './app/chat/chat-core';
import { useShellStore } from './app/shell-store';
import { resolveCurrentComposition } from './composition/preset-assembly';
import type { ResolvedComposition } from './composition/roster';
import type { Context, Fiber } from './cordis';
import { initCordisKernel } from './cordis/boot';
import { markDynamicFetchStart, mergeDynamicModels, recordDynamicFetchResult } from './provider/catalog';
import { resolveApiKey } from './provider/credentials';
import { createLiveProvider } from './provider/live';
import type { Provider } from './provider/types';
import {
  kernelGlobalMemoryDir,
  kernelProcessCall,
  parseJson,
  typedJsonRpc,
  typedListen,
  typedRpc,
  workspaceListCached,
} from './rpc-contract';
// Phase 1.5：全量图形状（GraphJSON/GraphNode/…）随分页栈退役；graphData = GraphSnapshot（agent/hooks）
import {
  type AppSettings,
  defaultPricing,
  getActiveProvider,
  graphEngineEnabled,
  loadSettings,
  loadSettingsWithSecrets,
  type ModelOverrides,
  modelContextWindow,
  type ProviderSettings,
} from './settings';
import type { AgentConfigChangeReason } from './state/agent-config-store';
import { getComposeStore, resolveComposeEffective } from './state/compose-store';
import { useCompositionStore } from './state/composition-store';
import type { CheckResult } from './state/dock-store';
import { useDockStore } from './state/dock-store';
import { broadcastGoalRecord } from './state/goal-store';
import { getPanelStore } from './state/panel-store';
import { bumpTimelineRefresh } from './state/timeline-store';
import { useAgentPanelStore } from './ui/agent-panel-store';
import { resetSessionState } from './ui/chat-session';
import { getDiagnosticsForFile, LspService } from './ui/lsp-client';
import { createBuilderDeps, createRuntimeAdapter } from './ui/runtime-adapter';
import { resolveSemanticToolName } from './ui/tool-semantics';
import { bumpWorkspaceEpoch, getWorkspaceEpoch, isCurrentEpoch } from './workspace-scope';

// ═══════════════════════════════════════════════════════
// 从引擎注册表动态加载工具
// ═══════════════════════════════════════════════════════

// ── 路径工具 ──────────────────────────────────────────────────────

/** 不区分大小写的路径比较（Windows 盘符大小写可能不同）。 */
export function isSamePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

// ── 参数翻译（从 main.ts 迁移）──────────────────────────────────

// ponytail: 所有 hologram 工具 schema 已用 camelCase (nodeId/maxDepth/from/to/...),
// Tauri v2 默认 camelCase 重命名 Rust snake_case 参数 → 期望的 JS key 正是这些 camelCase.
// 旧 ARG_TRANSLATIONS 把 camelCase→snake_case, 方向全反 → 7 个工具 (node/unused/impact/
// neighbors/path/coupling_report/community) 全部 "missing required key". 删整张表, args 直传.
// 若新增 hologram 命令: schema 参数名用 camelCase 即可, 无需任何翻译.

// ── Workspace 类 ─────────────────────────────────────────────────

/** graph-updated 事件载荷（workspace.rs 发射的 JSON 摘要）。
 *  Phase 1.5：diff 字段不再消费 —— 事件只作「图变了」信号，快照重拉。 */
interface GraphUpdatedSummary {
  meta?: { source_root?: string };
  total_nodes?: number;
  node_count?: number;
}

/** 工作区 scope fiber 的插件定义（cordis-migration P1）。
 *  apply 为空：资源登记发生在 fiber ctx 上（获取点就地 effect），不走插件闭包。 */
const workspaceScopePlugin = {
  name: 'hologram/workspace',
  apply() {},
};

export class Workspace {
  // ── 标识 ──
  readonly path: string;

  // ── 图数据 ──
  /** Phase 1.5：聚合快照（引擎 graph_snapshot 形态）——不再承载全量
   *  nodes/edges；按文件符号索引走 _preflightCtx 的按需查询。
   *  （fileGraphData 已随 hologram_graph_files.json 产物链退役——
   *  Phase 3 摘依赖时 regenerate_file_graph 死代码删除，此处为死状态。） */
  graphData: GraphSnapshot | null = null;

  // ── Agent 与记忆 ──
  /** 工厂已挂接标记（applyAgentConfig 的「补装配」分支判据——工厂在场
   *  即热同步，不重装、不动摊开集）。 */
  private _factoryRegistered = false;
  /** 工厂现造的最后一个 raw Agent 引用（模块能力面：setPlanMode /
   *  notifyMemorySaved / spawnSubAgent 闭包——接口层未覆盖的能力经此触达；
   *  句柄随卷生灭，本引用仅是「最近一次工厂产出」的借用，不持所有权）。 */
  private _lastRawAgent: Agent | null = null;
  prov: Provider | null = null;
  registry: ToolRegistry | null = null;
  memoryManager: MemoryManager | null = null;
  taskManager: TaskManager = new TaskManager();
  skillRegistry: SkillRegistry | null = null;
  agentStore: AgentStore | null = null;
  goalManager: GoalManager | null = null;

  // ── 运行时 ──
  runtime: AgentRuntime | null = null;

  // ── 子 Agent 池 ──
  subAgentPool = new SubAgentPool();

  // ── Store 路由（面板级隔离）──
  _storeId: string = '__default__';

  // ── 检查状态 ──
  checkRunning: boolean = false;
  checkPending: boolean = false;
  checkTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Agent 设置守卫 ──
  agentSetupRunning: boolean = false;
  agentSetupPending: boolean = false;

  // ── 内部状态 ──
  private _active: boolean = false;
  /** 工作区生命周期 = 根 Context 上的一个 cordis fiber（cordis-migration P1）。
   *  全部工作区级资源以 effect 登记在 fiber 上：constructor/open 的独立清理器直接
   *  effect（LIFO 释放）；setupAgent 的有序拆除组（先拆 runtime 再清缓存等顺序契约）
   *  每次调用打包为一个 DisposerBag、作为单个 effect 登记（组内串行逆序不变）。
   *  deactivate/forceClearState 统一走 fiber.dispose()（dispose-to-quiescence）。 */
  private readonly _fiber: Fiber;
  /** LSP 子系统服务（cordis-migration P3）— 状态与生命周期挂工作区 fiber。 */
  private readonly _lspService: LspService;

  /** 冷启动后台分析的健康状态。 */
  _health: 'unknown' | 'ready' | 'degraded' = 'unknown';
  /** 图谱后台预热中（workspace-flip 批 3，D-W1-3）：缓段拉页进行时为 true——
   *  UI 呈现「预热中」+ graph 工具缺席的诚实提示判定位。 */
  _graphWarming = false;

  /** P3-3（2026-09-02）：快照查询的门闩——open() 起始就并行发 load_graph_json
   *  （与监听器接线/setupAgent 的记忆装配重叠，省纯串行等待）；settle 前不
   *  阻塞 open() 返回，仅由 _setupAgentInner 在 buildToolRegistry 前 await
   *  （保序：注册期真值 graphData 必须就位——hologram 行工厂对 null 产出空集，
   *  是注册期决定不是调用期判空）。 */
  private _graphReady: Promise<void> | null = null;
  /** P3-3：预热完成 registry 重建所需的工作区级装配材料（builderDeps +
   *  agentRef + 装配时组合快照 + chatPanel）——rebuildToolRegistry 消费。 */
  private _agentRef: { current: Agent | null } = { current: null };
  private _builderDeps: BuilderDeps | null = null;
  private _assemblyComposition: ResolvedComposition | null = null;
  private _chatPanel: ChatCore | null = null;

  /** 图谱引擎开关快照（引擎开关，2026-08-22）：open() 时从 settings 读取。
   *  false = 本工作区不触图谱（graphData 恒 null / 不跑简报 / 不拉文件图谱）；
   *  生效语义 = 绑定期一次（在途工作区不活拆——下次绑定目录即见）。 */
  _graphEngineOn = true;

  /** 后台分析失败时的回调（冷启动降级模式）。 */
  onAnalysisFailed: ((err: unknown) => void) | null = null;

  /** 守卫（历史名 _initialRenderActive）：分页原子换入已随 Phase 1.5 退役，
   *  快照重拉幂等无需防踩踏 —— 字段保留给既有读写点，语义 = 初始装载期。 */
  _initialRenderActive: boolean = false;

  /** 预检 GraphContext — 存储以便写入后刷新引擎快照。 */
  _preflightCtx: GraphContext | null = null;

  get active(): boolean {
    return this._active;
  }

  /** 工作区 fiber 的 ctx — P2/P3 子系统（agent 装配、面板 Service）从这里挂子 fiber。 */
  get cordisCtx(): Context {
    return this._fiber.ctx;
  }

  /** LSP 子系统服务（cordis-migration P3）— 等价 cordisCtx.lsp 的便捷入口。 */
  get lsp(): LspService {
    return this._lspService;
  }

  // ── UI 回调（由 main.ts 设置）──
  onStatusChange: ((msg: string) => void) | null = null;
  onLoadingChange: ((loading: boolean) => void) | null = null;

  /** 低层构造（测试缝/占位形态退役后的实例化入口）：仅建 fiber 与身份，
   *  不绑定后端（open() 才是生产入口——内部走 workspace_activate）。
   *  直接 new 出来的实例 _active=false，不触发任何 RPC。 */
  constructor(path: string) {
    this.path = path;
    // 引擎开关快照（2026-08-22）：构造期读一次 settings——绑定期语义
    // （在途工作区不活拆，重新绑定/重启即见新值）。
    this._graphEngineOn = graphEngineEnabled(loadSettings());
    // 工作区 scope fiber — 挂在根 Context 上（initCordisKernel 幂等：生产路径
    // main.ts 已引导，复用既有根；测试路径首次调用自动建根）。
    this._fiber = initCordisKernel().plugin(workspaceScopePlugin);
    // cordis-migration P3：LSP 子系统服务挂工作区 fiber — 状态收进服务实例，
    // 生命周期随 fiber（deactivate/forceClear → provider/监听器/缓存/会话全清）。
    this._lspService = new LspService(this._fiber.ctx);
    // 构造即登记"恒在的清理器"（无获取点、工作区一建就存在）：
    // - checkTimer：停用时清掉防抖 timer；
    // - cancelEngineSnapshotRefresh：停用时取消在途引擎快照刷新。
    //   （fiber effect：setup 立即执行、返回值即清理器；LIFO 释放 — 注册在前的
    //   后释放，timers/快照最后清，与旧 deactivate 顺序一致。）
    this._fiber.ctx.effect(
      () => () => {
        if (this.checkTimer) {
          clearTimeout(this.checkTimer);
          this.checkTimer = null;
        }
      },
      'checkTimer-clear',
    );
    this._fiber.ctx.effect(() => () => cancelEngineSnapshotRefresh(), 'engine-snapshot-refresh-cancel');
  }

  // ═══════════════════════════════════════════════════════════════
  // 工厂方法：打开工作区 — 分析 + 数据装载 + 监听器
  // （V5 拆除 2026-08-22：starGraph 渲染面退役——图谱数据面照旧）
  // （workspace-session-ownership-rework 2026-08-27：占位工作区 path='' 退役——
  //  零目录会话已退役，工作区 = 目录实体，无项目不装配 Agent）
  // ═══════════════════════════════════════════════════════════════

  static async open(
    path: string,
    _starGraph: null,
    _chatPanel: ChatCore,
    callbacks?: {
      onStatusChange?: (msg: string) => void;
      onLoadingChange?: (loading: boolean) => void;
      /** per-workspace 图谱引擎旗标（2026-08-31）：
       *  true/false = 显式指定（新建工作区 sheet 的勾选）——随 workspace_activate
       *  写入注册表；
       *  null/undefined = 按注册表现值装配（无记录回退全局默认），注册表不被覆写。 */
      graphEngine?: boolean | null;
    },
  ): Promise<Workspace> {
    const ws = new Workspace(path);
    ws._active = true;
    // ponytail: 立即连接回调，以便本方法内的进度监听器能推送状态更新。
    // 否则整个分析阶段都是静默的 — onStatusChange 在 open() 返回后才被赋值。
    ws.onStatusChange = callbacks?.onStatusChange ?? null;
    ws.onLoadingChange = callbacks?.onLoadingChange ?? null;

    // per-workspace 引擎旗标解析（2026-08-31）：显式旗标 > 注册表现值 > 全局默认
    // （构造期已读入 ws._graphEngineOn = 全局默认）。进入既有工作区不携旗标 →
    // 查注册表该区的 graph_engine 字段；查不到（mock/毒化/未登记）→ 全局默认。
    let engineFlag: boolean | null = callbacks?.graphEngine ?? null;
    if (engineFlag === null) {
      try {
        // P1-2 优化：走短期缓存——首页挂载拉过的清单 10s 内直接复用
        const list = await workspaceListCached();
        const hit = list.find((w) => isSamePath(w.path, path));
        if (hit && typeof hit.graph_engine === 'boolean') engineFlag = hit.graph_engine;
      } catch {
        /* 读失败 → 全局默认（engineFlag 保持 null） */
      }
    }
    if (engineFlag !== null) ws._graphEngineOn = engineFlag;

    // Agent 写入文件时自动调度检查
    // （通过 agent:tool-done → onToolDone → scheduleCheck 处理，见下文）

    // 1. 向后端注册工作区（显式旗标随登记写入；null = 保持注册表现值）
    ws.onStatusChange?.('正在初始化引擎...');
    console.log('[Workspace.open] step 1: workspace_activate...');
    // #10 修复（2026-09-02）：workspace_activate 失败此前只 console.error——
    // 后端未注册工作区时后续文件操作会全失败，但用户看不到。现在 pushStatus
    // 可见化（不 throw——工作区文件层面仍可操作，只是后端桥断）。
    await typedRpc('workspace_activate', { path, graph_engine: callbacks?.graphEngine ?? null }).catch((e) => {
      console.error('[Workspace.open] workspace_activate failed:', e);
      const msg = e instanceof Error ? e.message : String(e);
      ws.onStatusChange?.(`⚠️ 工作区激活失败（后端桥可能不可用）: ${msg}`);
    });
    console.log('[Workspace.open] step 1: done');
    initLogger(path);

    // 2. 连接进度监听器（限定于本工作区）
    let currentPhase = '';
    // 2026-09-01 审计：三个监听器逐个 await——中途 reject 时已建者原本永不解除
    //（此时还没登记进 fiber effect）。创建期任一失败 = 先解已建者再抛。
    // P0-1 优化（2026-09-02）：三个监听器互相独立——Promise.all 批量注册，
    // 省 2 次 IPC 往返。任一失败仍回滚全部已建监听器。
    const createdListeners: Array<() => void> = [];
    let unlistenProgress: () => void;
    let unlistenPhase: () => void;
    let unlistenHeartbeat: () => void;
    try {
      [unlistenProgress, unlistenPhase, unlistenHeartbeat] = await Promise.all([
        typedListen('analyze-progress', ({ current, total, file }) => {
          if (!ws._active) return;
          const basename = file.replace(/.*[/\\]/, '');
          ws.onStatusChange?.(`${currentPhase ? currentPhase + ' — ' : ''}[${current}/${total}] ${basename}`);
        }),
        typedListen('analyze-phase', (p) => {
          if (!ws._active) return;
          currentPhase = p.message || p.phase;
          ws.onStatusChange?.(currentPhase);
        }),
        typedListen('analyze-heartbeat', ({ label, elapsed }) => {
          if (!ws._active) return;
          ws.onStatusChange?.(`${label} (${elapsed}...)`);
        }),
      ]);
      createdListeners.push(unlistenProgress, unlistenPhase, unlistenHeartbeat);
    } catch (e) {
      for (const un of createdListeners.splice(0)) un();
      throw e;
    }

    try {
      if (!ws._graphEngineOn) {
        // 引擎开关关闭（2026-08-22）：绑目录 ≠ 开图谱。graphData 留 null——
        // 走零目录会话的既有无图路径（hologram 工具行产出空集 + noGraph
        // prompt 段），fs/shell/git/权限全套保留。跳过：分析/快照装载、
        // 文件级图谱、初始简报（runCheck 的隐藏回退会强分析，见 runCheck 门禁注释）。
        // _health 保持 unknown——健康语义只对图谱数据面有意义。
        ws.onStatusChange?.('图谱引擎已停用——纯 Agent 工作区（图工具缺席，fs/shell/git 照常）');
      } else {
        // P3-3（2026-09-02）：快照查询不再阻塞 open() 返回——fire 后立即继续
        // 接线 graph-updated / tool-done 监听器；_setupAgentInner 的
        // buildToolRegistry 前 await _graphReady 保序（注册期真值契约）。
        // 收益 = 快照查询（首调含引擎子进程 spawn，秒级）与 setupAgent 的
        // 记忆装配 / 监听器接线全程重叠。
        // 形状真源 = engine graph_snapshot_value（schema 全检）。真机 Rust 出口
        // 已是结构化 Value——旧「string 泛型 + parseJson」在真机恒炸恒吞
        // （JSON.parse 收到对象）→ 图谱预热假死，2026-09-01 边界校验批修复。
        ws._graphReady = (async () => {
          try {
            const snap = await typedJsonRpc('load_graph_json', { path });
            if (!ws._active) return;
            if (snap.node_count > 0) {
              ws.graphData = snap;
              ws._health = 'ready';
            }
          } catch {
            /* 无缓存图 → 留 null，后台分析补 */
          }
          if (!ws._active) return;
          // 仍触发 analyze_and_load（force=false），保留缓存过期→重分析能力：
          // direct_analyze 内部校验 SQLite 缓存新鲜度，过期则重建；
          // 分析完成后由 graph-updated 事件驱动快照重拉。
          ws._graphWarming = ws.graphData === null;
          if (ws._graphWarming) {
            ws.onStatusChange?.('图谱后台预热中——对话已就绪，图工具将在分析完成后可用');
          }
          typedRpc('analyze_and_load', { path, force: false }).catch((e) => {
            // 2026-09-01 审计：失败要复位预热旗标 + 可见告警——否则 _graphWarming
            // 恒 true，图谱永不就绪也无人知道（静默卡死）。
            ws._graphWarming = false;
            console.warn('[Workspace.open] analyze_and_load 失败（图工具本次不可用）:', e);
            ws.onStatusChange?.('图谱预热失败——图工具本次不可用（重开工作区可重试）');
          });
        })();
      }

      // 3.（已删）文件级图谱装载——hologram_graph_files.json 产物链随
      //    regenerate_file_graph 退役（Phase 3），fileGraphData 消费面本就为零。

      // 4. 初始基线检查 — 渲染段已随 V5 拆除（星图退役），runCheck 保留
      //    （简报注入 cacheCheckResult 服务 Agent 状态注入面）。
      //    引擎开关关闭时跳过（runCheck 的隐藏回退会击穿开关，见 runCheck 门禁注释）。
      if (ws._graphEngineOn) {
        console.log('[Workspace.open] step 4: scheduling initial check...');
        ws._initialRenderActive = true;
        setTimeout(() => {
          ws._initialRenderActive = false;
          // 运行初始检查以建立基线
          ws.runCheck();
        }, 0);
      }

      // 5. 连接持久事件监听器（graph-updated）
      console.log('[Workspace.open] step 5: wiring listeners...');
      const unlistenGraphUpdated = await typedListen('graph-updated', async (rawSummary) => {
        if (!ws._active) return;
        // 引擎开关关闭：本工作区无图数据面——事件兜底/简报一律不触
        //（防御性守卫：正常路径下 watcher 未启动，事件本不该来）。
        if (!ws._graphEngineOn) return;
        try {
          const summary = JSON.parse(rawSummary) as GraphUpdatedSummary;
          const eventRoot = summary.meta?.source_root || '';
          if (eventRoot && !isSamePath(eventRoot, ws.path)) return;
          const nc = summary.total_nodes || summary.node_count || 0;
          if (nc > 0 && ws.path) {
            try {
              // Phase 1.5：快照重拉（毫秒级轻查询）——diff 本地合并与分页
              // 重载已随全量图形态退役；按需文件索引缓存同步失效。
              const snap = await typedJsonRpc('load_graph_json', { path: ws.path });
              if (snap.node_count > 0) {
                ws.graphData = snap;
                if (ws._graphWarming) {
                  ws._graphWarming = false;
                  ws._health = 'ready';
                  ws.onStatusChange?.('图谱预热完成——图工具已可用（新会话生效）');
                  ws.runCheck();
                  // P3-3（2026-09-02）：重建共享 registry——让上面那句「新会话
                  // 生效」从提示变成真话（此前 registry 只在 setupAgent 一次成型，
                  // 预热前装配的空工具面永不更新）。新会话经 this.registry 拿到
                  // 完整图工具；在途会话旧引用不动。
                  void ws.rebuildToolRegistry();
                }
                ws._preflightCtx?.invalidate();
              }
              bumpTimelineRefresh();
            } catch (e) {
              console.warn('[Workspace.open] 图谱快照重拉失败——保持现状:', e);
            }
          }
        } catch (e) {
          console.warn('[Workspace.open] graph-updated 载荷解析失败:', e);
        }
      });
      ws._fiber.ctx.effect(() => unlistenGraphUpdated, 'listener:graph-updated');

      // Agent 工具完成 → 文件可能变更时自动触发简报
      const FILE_MODIFY_TOOLS = new Set([
        'write_file',
        'edit_file',
        'delete_file',
        'rename_file',
        'move_file',
        'git_commit',
        'git_stage',
        'git_push',
        'git_pull',
        'run_shell',
        'rename_symbol',
      ]);
      const onToolDone = (evt: { toolName: string; args: Record<string, unknown> }) => {
        // 工具收敛后模型调用领域工具（fs/git/shell）— 归一化回旧语义名匹配
        const sem = resolveSemanticToolName(evt.toolName, JSON.stringify(evt.args || {}));
        if (FILE_MODIFY_TOOLS.has(sem)) {
          if (ws._graphEngineOn) {
            ws.scheduleCheck();
            // 刷新引擎快照 — 跟踪累积结构漂移
            if (ws._preflightCtx) scheduleEngineSnapshotRefresh(ws._preflightCtx, ws.path);
          }
          bumpTimelineRefresh();
        }
      };
      // P1 总线归零：agent:tool-done → agent-panel-store.lastToolDone（tick+payload 原子更新）
      const unsubToolDone = useAgentPanelStore.subscribe((s, prev) => {
        if (s.toolDoneTick !== prev.toolDoneTick && s.lastToolDone) onToolDone(s.lastToolDone);
      });
      ws._fiber.ctx.effect(() => unsubToolDone, 'listener:tool-done');

      // 清理进度监听器（仅在初始分析期间存活）
      unlistenProgress();
      unlistenPhase();
      unlistenHeartbeat();
      console.log('[Workspace.open] all done, returning workspace');
    } catch (err) {
      console.error('[Workspace.open] FAILED:', err);
      unlistenProgress();
      unlistenPhase();
      unlistenHeartbeat();
      ws.onStatusChange?.(`分析失败: ${err}`);
      ws.onLoadingChange?.(false);
      throw err;
    }

    return ws;
  }

  // ═══════════════════════════════════════════════════════════════
  // 停用 — 保存状态、停止监听器、移除监听器
  // ═══════════════════════════════════════════════════════════════

  async deactivate(chatPanel: ChatCore): Promise<void> {
    this._active = false;

    // 跨工作区串染根治（H3，2026-09-02）：deactivate 可能被 switchWorkspace 的
    // withTimeout(5000) 放弃后仍在后台跑——超时/异常路径的 catch 会调
    // forceClearState 抢救（推进代际）并继续开新工作区。迟到的保存步骤会
    // 用「已被新工作区覆盖的 store」快照写进旧工作区文件：saveCanvasState 把
    // 新工作区摊开集写进旧区 canvas.json（持久污染）；workspace_deactivate
    // 还会误关新工作区的后端态。每步落盘前校验代际，过期即弃。
    const epoch = getWorkspaceEpoch();

    // 保存聊天会话
    try {
      await chatPanel.saveActiveSession(this.path);
    } catch {
      /* 忽略 */
    }
    if (!isCurrentEpoch(epoch)) {
      console.warn('[Workspace.deactivate] 代际已变（超时被 forceClearState 抢救）——跳过剩余落盘，防跨工作区串写');
      return;
    }

    // Stage-5：切走前落盘工作区画布状态（布局 + 公共物——工作区级，随工作区走）
    try {
      await chatPanel.saveCanvasState(this.path);
    } catch {
      /* 忽略 */
    }
    if (!isCurrentEpoch(epoch)) return;

    // 停止 watcher 并清除后端状态（过期跳过——此 RPC 会误关**新**工作区的后端态）
    if (isCurrentEpoch(epoch)) {
      try {
        await typedRpc('workspace_deactivate', {});
      } catch {
        /* 忽略 */
      }
    }

    // 统一释放 fiber 上登记的全部工作区级清理器（dispose-to-quiescence：等待
    // 全部清理器 settle）。所有获取点（open/setupAgent）在获取时就地 effect 登记，
    // deactivate 不靠人肉枚举。失败必须可见（不静默）— setupAgent 有序组内部聚合
    // 记 warn；独立 effect 的失败走 cordis logger.error；均不阻断工作区切换。
    try {
      await this._fiber.dispose();
    } catch (err) {
      console.warn('[Workspace.deactivate] fiber.dispose 部分清理失败:', err);
    }
    // 推进工作区代际 — 使在途的旧项目 fire-and-forget 写共享态过期丢弃。
    bumpWorkspaceEpoch();
  }

  /** 强制清除所有状态。
   *  在 deactivate() 超时时调用 — 防止卡住的工作区
   *  阻塞下一次 switchWorkspace。
   *  #13 修复（2026-09-02）：fiber.dispose() 改为返回 Promise——调用方 await
   *  确保异步清理器（canvas flush、session 落盘等）在新工作区创建前 settle，
   *  否则旧工作区的 fire-and-forget 清理与新工作区设置竞态。runtime 同步
   *  disposeAll 保留（H3 防 60s TTL timer）；fiber async 清理器改为 await。 */
  async forceClearState(): Promise<void> {
    this._active = false;
    // 紧急路径：runtime 必须同步 disposeAll（H3）— 不等 flush，防 60s TTL timer
    // 继续对共享后端发 agent_isolation_discard（真实删 worktree）。
    // flushAllBoards 设计为 fire-and-forget。
    if (this.runtime) {
      void this.runtime.flushAllBoards();
      this.runtime.disposeAll();
      this.runtime = null;
    }
    // 快通道释放 fiber 上登记的清理器——runtime 已同步 disposeAll（H3），
    // 有序组内 runtime disposer 因 this.runtime === null 而 no-op。
    // async 清理器（canvas flush 等）await settle，防新工作区竞态。
    await this._fiber.dispose();
    // 推进工作区代际 — 使在途的旧项目 fire-and-forget 写共享态过期丢弃。
    bumpWorkspaceEpoch();
  }

  // ── Agent 配置变更统一入口 ──

  /**
   * Agent 配置变更统一入口（由 state/agent-config-store 信号驱动）。
   * 所有变更热切换，不重建 Agent：
   *  - 协作模式 → 运行时切换（setPlanMode）
   *  - 提供方身份变更 → 换 live provider 引用（唯一需要换引用的场景）
   *  - 同提供方内的 baseUrl/model/apiKey/thinking/maxTokens 变更 → 无需任何
   *    换引用——live provider（Phase C，2026-08-24）在每次使用点按名现解析，
   *    保存即生效
   *  - 定价 / contextWindow → 热同步（setPricing / setContextWindow）
   * 上下文、压缩缓存、hook、正在运行的执行、所有会话全部保留。
   * 例外：Agent 缺席（装配失败/异常路径的恢复——Phase C 后无 Key 冷启动不再
   * 走此分支，Agent 恒装配）→ 走全量装配（setupAgent + autoRestoreLastSession，
   * 与冷启动同序列）。组件不得绕过此方法直接调 setupAgent。
   *
   * ⚡ P14（2026-08-22）恒 swap 退役（Phase C，2026-08-24）：恒 swap 时代靠
   * 「每次信号重建 provider 换引用」把新配置带进在用 Agent——枚举漂移的旧雷
   * （_agentRebuildKey 手工 diff）曾靠它根治。live provider 把配置面整体移到
   * 使用点后，换引用只剩「提供方换人」一个场景；Key 清空不再拆除 Agent/会话
   * （下一次请求经 live 现解析出空 Key → MISSING_CREDENTIAL 响亮报错，会话
   * 照常显示）——DSH 形态的「配置断了 → 会话在，发送时报错」。
   */
  async applyAgentConfig(chatPanel: ChatCore, reason: AgentConfigChangeReason, sessionId?: number): Promise<void> {
    // 规划模式切换 — 运行时状态切换（raw Agent 引用承担——接口层无 setPlanMode；
    // 工厂现造的句柄下次造时从 mode-store 现读，无活句柄也不丢状态）
    if (reason === 'collaboration-mode') {
      const mode = this._modeState().collaborationMode;
      this._lastRawAgent?.setPlanMode(mode === 'plan');
      return;
    }

    // D2（2026-08-27 收窄）：热切换路径不再全量 restoreSecrets——loadSettings
    // 同步读就够了（providers/activeProvider/model 都在 localStorage）；诊断 Key
    // 状态改走 resolveApiKey（provider/credentials.ts 内存缓存，命中零 IPC）。
    // 此前每个 model-switched/settings-saved 信号都逐个 provider credential_get
    // （切一次模型 = N 次 IPC），只为算个诊断用 keyLen。request 期真实凭据仍由
    // live provider 按名现解析（fail-loud 语义不变）。
    const s = loadSettings();
    const act = getActiveProvider(s);

    // Key 状态仅作诊断呈现（不拆 Agent/会话——请求期由 live provider 报错）
    const apiKey = await resolveApiKey(act.name);
    if (!apiKey || apiKey.trim() === '') {
      useAgentPanelStore.getState().setDiag({
        text: `⚠️ API Key 未配置 — provider="${act.name}"。会话保留，发送请求将报错。`,
        ready: false,
      });
    } else {
      useAgentPanelStore.getState().setDiag({ text: `[Agent] provider=${act.name}`, ready: true });
    }

    // 工厂缺席（装配从未成功过的恢复路径）才补一次全量装配。
    if (!this._factoryRegistered) {
      await this.setupAgent(chatPanel);
      return;
    }

    // ── 方案甲（2026-08-27）：会话级变更（创作坞切模型/思考，信号带 sessionId）
    //    → 只热切换该会话的句柄。解析该会话生效配置（覆盖 ?? 全局默认）。 ──
    if ((reason === 'model-switched' || reason === 'thinking-changed') && sessionId != null) {
      const handle = agentSessionState.getAgent(this._storeId, sessionId);
      if (!handle) return; // 句柄未建（惰性）——工厂现造时会吃到新覆盖
      const eff = resolveComposeEffective(this._storeId, sessionId);
      const row = s.providers.find((p) => p.name === eff.providerName) ?? act;
      const prov = createLiveProvider(eff.providerName, undefined, {
        model: eff.model,
        thinking: eff.thinking,
      });
      prov.prewarm?.();
      handle.setProvider(prov, defaultPricing(row.kind, eff.model));
      handle.setThinking(eff.thinking);
      handle.setContextWindow(this._contextWindowFor(row, eff.model));
      return;
    }

    // ── 全局变更（settings-saved）→ 逐会话重解析（方案甲语义 3/4）：
    //    有覆盖的卷保持自己的值；无覆盖的卷实时跟随新全局默认。 ──
    this.prov = this._buildProvider(s); // 工厂/后续装配的全局基准
    this.prov.prewarm?.();
    agentSessionState.forEachAgentEntry((storeId, sid, h) => {
      const eff = resolveComposeEffective(storeId, sid);
      const row = s.providers.find((p) => p.name === eff.providerName) ?? act;
      // 覆盖存在 → live 带覆盖（该会话维度不跟随全局）；无覆盖 → 裸 live（现解析行值）
      const override = getComposeStore(storeId).getState().getPrefs(String(sid));
      const prov = override
        ? createLiveProvider(eff.providerName, undefined, { model: eff.model, thinking: eff.thinking })
        : createLiveProvider(eff.providerName);
      h.setProvider(prov, defaultPricing(row.kind, eff.model));
      h.setThinking(eff.thinking);
      h.setContextWindow(this._contextWindowFor(row, eff.model));
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // setupAgent — 构建带 hologram/coding/memory 工具的 LLM Agent
  // ═══════════════════════════════════════════════════════════════

  async setupAgent(chatPanel: ChatCore): Promise<void> {
    if (this.agentSetupRunning) {
      this.agentSetupPending = true;
      return;
    }
    this.agentSetupRunning = true;
    try {
      await this._setupAgentInner(chatPanel);
    } finally {
      this.agentSetupRunning = false;
      if (this.agentSetupPending) {
        this.agentSetupPending = false;
        await this.setupAgent(chatPanel);
      }
    }
  }

  /** P3-3（2026-09-02）：构建共享工具注册表——setupAgent 与 rebuildToolRegistry
   *  的共用出口。组装材料（deps/agentRef/memoryManager/skillRegistry…）全部
   *  工作区级，重建即换 graphData/组合快照两个真值。 */
  private async _buildRegistryLocked(composition: ResolvedComposition): Promise<ToolRegistry> {
    const registry = await buildToolRegistry({
      graphData: this.graphData,
      deps: this._builderDeps as BuilderDeps,
      memoryManager: this.memoryManager ?? undefined,
      skillRegistry: this.skillRegistry ?? undefined,
      taskManager: this.taskManager,
      subAgentPool: this.subAgentPool,
      subAgentSpawner: async (desc, prompt, prog, mode, al, sig, asyncMode, agentIdOverride, outputSchema) =>
        this._agentRef.current?.spawnSubAgent(
          desc,
          prompt,
          prog,
          mode,
          al,
          sig,
          asyncMode,
          agentIdOverride,
          outputSchema,
        ) ?? Promise.resolve({ text: '', err: 'agent not available' }),
      // S2-1 组合外化：工具行表穿线（roster 解析产物；缺省 = 出厂表 = 零漂移）
      toolRows: composition.tools,
    });
    this.registry = registry;
    this._assemblyComposition = composition;
    // 工具 schema 连接到 UI 面板（重建时同步刷新）
    this._chatPanel?.setToolSchemas(registry.schemas());
    return registry;
  }

  /** P3-3（2026-09-02）：预热完成后的共享 registry 重建——graph-updated 的
   *  warming 完成分支调用。此前「图工具已可用（新会话生效）」是句谎话：共享
   *  registry 在 setupAgent 时一次成型（graphData null → hologram 行空集），
   *  之后无人重建——新会话拿到的还是空工具面。重建后新会话即得完整工具面；
   *  在途会话持有的旧 registry 引用不受影响（句柄生命周期 = 卷）。
   *  防御：装配材料缺席（setupAgent 未跑/已拆）= no-op。 */
  async rebuildToolRegistry(): Promise<void> {
    if (!this._builderDeps || !this._active) return;
    try {
      const composition = useCompositionStore.getState().resolved;
      await this._buildRegistryLocked(composition);
      this.onStatusChange?.('图工具面已更新——新会话生效');
    } catch (e) {
      console.warn('[Workspace] 预热完成 registry 重建失败（保持旧工具面）:', e);
    }
  }

  /** 从 panel store 读取协作模式。回退到 normal。
   * （权限模式已迁 mode-store 单源真相，C11 重设计 2026-08-22——
   * 不再从 panel-store 读，agent 会话工厂亦不消费。） */
  private _modeState(): { collaborationMode: 'normal' | 'plan' } {
    try {
      const ps = getPanelStore(this._storeId).getState();
      return { collaborationMode: ps.collaborationMode };
    } catch (e) {
      console.warn('[Workspace] _modeState failed, falling back to normal:', e);
      return { collaborationMode: 'normal' };
    }
  }

  /** 构建 active provider 的 live 形态（Phase C，2026-08-24 工作区归属根治）：
   *  provider 对象 = 无状态协议适配器——baseUrl/model/apiKey/thinking/maxTokens
   *  每次使用点按提供方名现解析（createLiveProvider → provider/credentials.ts
   *  凭据缓存 + 写穿失效）。_setupAgentInner 与会话工厂共用此入口，保证两处
   *  构建永不分叉。Agent 的构造与存在性因此与 Key 无关（缺 Key = 请求期
   *  MISSING_CREDENTIAL 报错）；「强制关闭思考」的旁路（翻译/压缩）仍用
   *  显式构造的 createProvider，不经此入口。 */
  private _buildProvider(settings: AppSettings): Provider {
    return createLiveProvider(getActiveProvider(settings).name);
  }

  /** 方案甲（2026-08-27）+ per-model 覆盖（2026-08-26）：会话级窗口计算——
   *  per-model 覆盖（modelOverrides）优先，其次会话生效模型的目录值，最后 200K。
   *  工厂与热切换共用（原全局版 _effectiveContextWindow 随「全局单 provider 装配」
   *  退役；per-provider 单字段 contextWindow 已拆，多模型时代按 Provider 管一个值
   *  毫无意义）。 */
  private _contextWindowFor(
    row: { modelOverrides?: Record<string, ModelOverrides>; kind: string },
    model: string,
  ): number {
    return modelContextWindow(row as ProviderSettings, model);
  }

  private async _setupAgentInner(chatPanel: ChatCore): Promise<void> {
    this._storeId = chatPanel.panelId;

    // 跨工作区串卷根治（H2，2026-09-02）：旧工作区会话面清理必须在**任何可抛
    // 错的装配步骤之前**。此前挂在函数尾部——switchWorkspace 对 setupAgent 的
    // catch 只 pushStatus 后继续走恢复链（setProjectPath → restoreCanvasSpread），
    // 装配链任一步抛错即跳过清理 → sess store 残留旧区在内存卷 → 恢复链的
    // openIds 把撞号卷判「已在案头」，旧区内容渲染到新工作区画布（实机串卷
    // 根因之二；之一见 chat-session.ts 摊开路径的代际防护）。
    resetSessionState(chatPanel.panelId);

    // P0-4 优化（2026-09-02）：loadSettingsWithSecrets（含 credential_get 并行解密）
    // 与 get_global_memory_dir 互相独立——Promise.all 并行，省 1 次 IPC 往返。
    let globalDir: string | undefined;
    const settingsPromise = loadSettingsWithSecrets();
    const globalDirPromise = kernelGlobalMemoryDir()
      .then((d) => {
        globalDir = d;
      })
      .catch(() => {
        /* 忽略 */
      });
    const settings = await settingsPromise;
    await globalDirPromise;

    // 从保存的偏好初始化模式状态
    // 权限模式（C11 重设计）：mode-store 已在 boot 期水合并镜像 Rust
    // （hydratePermissionMode），此处不再从 settings 套用——单向陷阱退役。
    // 协作模式仍走 panel-store（会话级状态，与权限模式不同生命周期）。
    const sAgent = settings.agent || {};
    const ps = getPanelStore(this._storeId).getState();
    if (sAgent.collaborationMode && ps.collaborationMode === 'normal') {
      ps.setCollaborationMode(sAgent.collaborationMode);
    }

    const active = getActiveProvider(settings);

    const diag = `[Agent] provider=${active.name} keyLen=${(active.apiKey || '').length}`;
    this.onStatusChange?.(diag);
    useAgentPanelStore.getState().setDiag({ text: diag, ready: !!active.apiKey && active.apiKey.trim() !== '' });

    // Phase B（2026-08-24 工作区归属根治）：无 Key 不再拆除会话——装配照常进行
    //（工厂注册 + 会话内容层），缺 Key 的表现 = 发消息时工厂返 null →
    // ensureSessionAgent 提示「请先配置 API Key」/配 Key 后请求期报错，会话
    // 列表恒在（DSH 形态：配置断了 → 会话照常显示，发送时报错）。
    if (!active.apiKey || active.apiKey.trim() === '') {
      useAgentPanelStore.getState().setDiag({
        text: `⚠️ 未检测到 API Key — provider="${active.name}"。会话照常可用，发送前请在设置中配置。`,
        ready: false,
      });
    }

    // ⚡ 2026-08-08：删除启动时的 persistSecrets 回写（原在此行）。
    // 理由：读回→无条件写回是「null 复活」与双重编码放大循环的驱动器——
    // 任何残留在 state 里的垃圾 key（如字面量 "null"）都会在每次启动时
    // 被重新写入凭据库。凭据的唯一写入入口 = SettingsPanel 的保存动作。

    // 加载记忆（全局 + 项目）——globalDir 已在上方与 settings 并行获取（P0-4）
    let memorySection = '';
    // setupAgent 有序拆除组（cordis-migration P1）：每次调用一个 DisposerBag，
    // 作为单个 fiber effect 登记。组内保持 DisposerBag 的串行逆序契约 —
    // 「先拆 runtime 再清缓存」等顺序依赖不变。
    // 组创建即登记 effect（而非收集完再登记）：setupAgent 中途异常时已登记的
    // 部分清理器同样随 fiber dispose 释放（与旧 _bag 行为一致）。
    const teardown = new DisposerBag();
    this._fiber.ctx.effect(
      () => async () => {
        try {
          await teardown.dispose();
        } catch (err) {
          console.warn('[Workspace] setupAgent teardown 部分清理失败:', err);
        }
      },
      'setupAgent-teardown',
    );
    this.memoryManager = new MemoryManager(this.path, globalDir);
    // 获取即登记：停用时释放记忆。
    teardown.add(() => {
      this.memoryManager = null;
    }, 'memory-manager-null');
    this.memoryManager.onSaved = (info) => {
      // raw Agent 引用（agentRef）承担非接口能力面——接口层无 notifyMemorySaved
      this._lastRawAgent?.notifyMemorySaved(
        `记忆已更新: **${info.description || info.name}** (${info.confidence || 'reference'})`,
      );
    };
    try {
      memorySection = await this.memoryManager.loadPromptSection(extractGraphNodeNames(this.graphData));
    } catch (err) {
      console.error('[setupAgent] loadPromptSection failed:', err);
    }

    // 初始化 Agent 状态持久化 + goal 生命周期 + skill 注册表
    // 2026-09-01：AgentStore 已内存化（不再落盘 .lantai/agents，见 agent-store.ts 头注）
    this.agentStore = new AgentStore();
    this.goalManager = new GoalManager(this.path, broadcastGoalRecord);
    this.goalManager.adoptOrphans().catch((e) => console.warn('[workspace] goal adoption failed:', e));
    this.skillRegistry = new SkillRegistry(this.path);

    if (memorySection.trim()) {
      const memLines = memorySection.split('\n').filter((l) => l.startsWith('- ')).length;
      const globalCount = this.memoryManager?.scopes?.().includes('global') ? ' (含全局)' : '';
      this.onStatusChange?.(`[记忆] 已注入 ${memLines} 条${globalCount}`);
    }

    // ── 创建 Provider ──
    const prov: Provider = this._buildProvider(settings);
    prov.prewarm?.();
    // 从 API 获取动态模型，合并到目录（尽力而为）
    // R5 D8（2026-08-29）：拉取中面——compact 选择器分组头「目录获取中…」可见
    markDynamicFetchStart(active.name);
    prov
      .fetchModels?.()
      .then((models) => {
        if (models.length > 0) mergeDynamicModels(active.name, models);
        // C5（2026-08-27）：后台自动拉取也记失败面——成功清标记，失败记原因
        // （compact 选择器分组头可见「目录获取失败」）。last-good 已合并模型
        // 不因失败被清。
        recordDynamicFetchResult(active.name, true);
      })
      .catch((e) => recordDynamicFetchResult(active.name, false, e instanceof Error ? e.message : String(e)));
    this.prov = prov;

    // ── 创建 Runtime + UI 适配器 ──
    // P0-10：覆盖旧 runtime 前必须走完整拆除（与下方销毁路径同一顺序：
    // flushAllBoards → disposeAll）——否则旧 runtime 的订阅与防抖 flush
    // 定时器仍然存活，可能回写覆盖新看板（雷区地图 P0-10）
    if (this.runtime) {
      try {
        await this.runtime.flushAllBoards();
      } catch (e) {
        console.warn('[workspace] 旧 runtime 看板 flush 失败:', e);
      }
      this.runtime.disposeAll();
      this.runtime = null;
    }
    // 清注入缓存登记在 runtime 之前 → 逆序释放时晚于 runtime.disposeAll（先拆 Agent 再清缓存）。
    teardown.add(() => resetAgentCaches(), 'reset-agent-caches');
    // cordis-migration P2：runtime 挂在工作区 fiber 下 — 每个 Agent 在 cordis 树上
    // 获得身份 fiber（hologram/agent），生命周期随 AgentContext.dispose 摘除。
    // S2-1 组合外化：composition-store 的 resolved 穿进 runtime（capability
    // 表 + prompt 段表的运行时真源；store 缺省 = 出厂组合 = 现行装配）。
    const composition = useCompositionStore.getState().resolved;
    const runtime = new AgentRuntime(this.path, this._fiber.ctx, composition);
    const adapter = createRuntimeAdapter(this._storeId);
    runtime.setNotifier(adapter);
    runtime.setDiagnosticsSource(getDiagnosticsForFile);
    this.runtime = runtime;
    // 获取即登记：runtime 销毁（flush 看板 → disposeAll → 解引用）。
    // async 清理器在 deactivate（await fiber.dispose → 组内串行）等待；forceClearState
    // 走快通道（不等 settle）— runtime 已在 forceClear 顶部同步 disposeAll，此处因
    // this.runtime 已为 null 而 no-op。
    teardown.add(async () => {
      if (!this.runtime) return;
      try {
        await this.runtime.flushAllBoards();
      } catch (e) {
        console.warn('[workspace] runtime flushAllBoards 失败:', e);
      }
      this.runtime.disposeAll();
      this.runtime = null;
    }, 'runtime-dispose');
    teardown.add(() => {
      this.subAgentPool.stopAll();
    }, 'subagent-pool-stop');
    // ── 后台任务通知路由（bg:note）──
    // Rust 监视线程在 job 完成/停滞时发射（携带 owner）→ 这里排干该 owner 的
    // 通知队列并经 bus systemNotify 投递：idle agent 被 wake 回调唤起新一轮 run，
    // 运行中的 agent 则在下轮边界注入。owner = 发起 agent 的 bus id（executor
    // 注入 _owner_id）— 排干幂等（同一通知只经 listener 或 runLoop drain 之一
    // 到达）。owner 已消亡（子 Agent 结束注销）时不排干：通知留在 Rust 有界
    // 队列（超限丢最旧）— 排干后无处投递才是真丢失；bash_output(jobId) 仍是
    // 兜底拉取路径。
    const bgNoteBus = runtime.getBus();
    const unBgNote = await typedListen('bg:note', (payload) => {
      const owner = payload.owner;
      // 用户/UI 发起的任务（owner=null）不投给 agent；owner 已注销的直接跳过（见上）
      if (!owner || !bgNoteBus.isRegistered(owner)) return;
      void (async () => {
        try {
          // R3-d 信封退役：drain_bg_notifications 经 process_cap 能力口直呼
          const notes = await kernelProcessCall('drain_bg_notifications', { agent_id: owner });
          if (notes) bgNoteBus.systemNotify(owner, 'bg', notes);
        } catch {
          /* best-effort — 通知丢失时 bash_output(jobId) 仍可主动拉取 */
        }
      })();
    });
    teardown.add(unBgNote, 'listener:bg-note');
    // agentSessionState 解除本面板的全部会话句柄（dispose + 清表）— 拆 audit 中危：
    // 清理不再挂在下一个 setupAgent 上。
    teardown.add(() => agentSessionState.clearPanelState(this._storeId), 'session-state-clear');

    // ── 初始化 Agent 面板数据 + 订阅消息流 ──
    useAgentPanelStore.getState().setRuntime(runtime);
    useAgentPanelStore.getState().refresh(runtime);
    // 获取即登记：停用时清面板 runtime 引用 + currentSessionId（拆 audit 中危#3：
    // 2s 轮询打旧 runtime 建错位 board）+ 清看板列表。
    teardown.add(() => {
      const p = useAgentPanelStore.getState();
      p.setAgents([]);
      p.setTaskBoard([]);
      p.setDiscoveries([]);
      p.setCurrentSessionId('default');
      p.setRuntime(null);
    }, 'agent-panel-store-clear');
    const unsubMsg = runtime.getBus().subscribe({}, (msg) => {
      useAgentPanelStore.getState().pushMessage(msg);
    });
    teardown.add(unsubMsg, 'listener:runtime-msg');

    // ── 构建图谱上下文（Phase 1.5：file_nodes 按需索引 + 缓存）──
    // 快照形态下全量 fileIndex 不再存在 —— GraphContext 按文件轻查询
    // （单文件毫秒级），preflight 同步消费缓存、enrich 异步预热。
    const graphCtx = this.graphData
      ? createGraphContext(async (file) => {
          const raw = await typedRpc('hologram_file_nodes', { file });
          return parseJson<{ nodes?: NodeBrief[] }>(raw)?.nodes ?? [];
        })
      : null;
    this._preflightCtx = graphCtx;

    // P3-3（2026-09-02）：快照门闩——注册期真值契约（hologram 行工厂对
    // graphData null 产出空集）。open() 已并行发查询，此处 await 保序——
    // 快照在途期间 setupAgent 的记忆装配与其重叠，不空等。
    await this._graphReady?.catch(() => {});
    // 门闩 settle 后 graphData 可能已就位——graphCtx 按新值补建（上面按
    // null 建的 query 闭包不依赖 graphData 本体，仅 this.graphData 判空；
    // 就位即换真上下文）
    if (this.graphData && !this._preflightCtx) {
      this._preflightCtx = createGraphContext(async (file) => {
        const raw = await typedRpc('hologram_file_nodes', { file });
        return parseJson<{ nodes?: NodeBrief[] }>(raw)?.nodes ?? [];
      });
    }

    // ── 构建工具注册表（通过 agent-builder，零 UI 导入）──
    // P3-3：装配材料提升为实例字段（rebuildToolRegistry 消费）——预热完成
    // 后的 registry 重建复用同一 deps/agentRef/组合快照。
    const builderDeps: BuilderDeps = createBuilderDeps(this._storeId);
    this._builderDeps = builderDeps;
    this._agentRef = { current: null as Agent | null };
    this._assemblyComposition = composition;
    this._chatPanel = chatPanel;
    const agentRef = this._agentRef;

    const registry = await this._buildRegistryLocked(composition);

    // 冷启动：预热状态缓存（引擎关态跳过 timeline——它走引擎读取，
    // 关态必然 Err，不浪费一次注定失败的 IPC；git 状态与引擎无关照刷）
    refreshGitStatus(this.path).catch(() => {});
    if (this._graphEngineOn) refreshTimeline(this.path).catch(() => {});

    // ── 工厂：每次调用通过 runtime 创建全新 Agent ──
    // 返回 runtime 句柄（含 dispose）— 所有权随句柄交给会话 state
    // （agentSessionState），会话关闭时由其负责销毁；
    // agentRef 仅是借用 raw Agent 引用（spawn 闭包、notifyMemorySaved）。
    // S4-1a 会话工厂组合覆盖（设计件 §2.2 复审补充的机制位——「无生产 UI
    // 消费、机制完整、选择器留给 V5」）：当前生效组合 ≠ 工作区装配组合时，
    // 工厂为该会话构建会话作用域注册表（deps 全部工作区级可复用）并把组合
    // 覆盖传给 createAgent（prompt/capabilities 域随覆盖换源；工具域经会话
    // 注册表换源）。无选择器时两值恒等 → 走共享注册表 + 无覆盖 = S2 现状
    // 零漂移。子 Agent 经 ctx composition 服务继承 → 与父同面。
    const factory = async (sessionId: number): Promise<AgentHandle | null> => {
      // Phase C（2026-08-24 工作区归属根治）：Agent 恒可构造——Key 缺失不再拒绝
      // 装配。凭据/baseUrl/apiKey 全部在使用点经 live provider 按名现解析（缺
      // Key = 请求期 MISSING_CREDENTIAL 报错，会话不动）。定价/窗口出自同步
      // settings 快照（零 IPC），后续变更由 applyAgentConfig 热同步。
      // 方案甲（2026-08-27）：按会话生效配置装配——有覆盖的卷用会话的
      // provider/model/thinking，未改过的卷 = 裸 live（实时跟随全局默认）。
      const s = loadSettings();
      const act = getActiveProvider(s);
      const override = getComposeStore(this._storeId).getState().getPrefs(String(sessionId));
      const eff = resolveComposeEffective(this._storeId, sessionId);
      const row = s.providers.find((p) => p.name === eff.providerName) ?? act;
      const sessProv = override
        ? createLiveProvider(eff.providerName, undefined, { model: eff.model, thinking: eff.thinking })
        : createLiveProvider(eff.providerName);
      sessProv.prewarm?.(); // 廉价预热（fire-and-forget）；fetchModels 合目录只在 setupAgent 做

      const ms = this._modeState();

      await runtime.ready();
      // 唯一 agentId — 每会话一个 Agent 实例；'main' 硬编码会让所有会话的
      // Agent 在 runtime.agents/_agentSessions 里互相覆盖（多会话错位根因之一）
      const sessionAgentId = `main-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // 会话组合覆盖判定（S4-1a 机制位；V5 选择器接入后此处才会出现分歧）
      // P3-3：比较基准与共享注册表改读实例字段——预热完成的 registry 重建
      // （rebuildToolRegistry 更新 _assemblyComposition + registry）对后续
      // 新会话生效；在途会话持有的旧引用不受影响（「新会话生效」语义）。
      const sessionComposition = resolveCurrentComposition();
      const compositionOverride = sessionComposition !== this._assemblyComposition ? sessionComposition : undefined;
      // 会话作用域注册表：覆盖存在时按覆盖的 tools 域构建（deps 工作区级复用）
      const sessionRegistry = compositionOverride
        ? await buildToolRegistry({
            graphData: this.graphData,
            deps: builderDeps,
            memoryManager: this.memoryManager ?? undefined,
            skillRegistry: this.skillRegistry ?? undefined,
            taskManager: this.taskManager,
            subAgentPool: this.subAgentPool,
            subAgentSpawner: async (desc, prompt, prog, mode, al, sig, asyncMode, agentIdOverride, outputSchema) =>
              agentRef.current?.spawnSubAgent(
                desc,
                prompt,
                prog,
                mode,
                al,
                sig,
                asyncMode,
                agentIdOverride,
                outputSchema,
              ) ?? Promise.resolve({ text: '', err: 'agent not available' }),
            toolRows: compositionOverride.tools,
          })
        : (this.registry ?? registry);

      let handle: Awaited<ReturnType<typeof runtime.createAgent>>;
      try {
        handle = await runtime.createAgent(
          {
            agentId: sessionAgentId,
            parentId: null,
            projectPath: this.path,
            graphData: this.graphData,
            provider: sessProv,
            tools: sessionRegistry,
            memoryManager: this.memoryManager ?? undefined,
            skillRegistry: this.skillRegistry ?? undefined,
            goalManager: this.goalManager ?? undefined,
            agentStore: this.agentStore ?? undefined,
            subAgentPool: this.subAgentPool,
            taskManager: this.taskManager,
            graphContext: graphCtx,
            // 并发会话（2026-08-26）：事件入口按会话绑定——事件天生携带所属卷
            // 身份，两卷并发流式互不串扰（旧共享 eventSink 靠活跃卷猜测路由）。
            // execState 同步改挂会话级（权限卡/停止语义按卷隔离）。
            eventSink: chatPanel.eventSinkFor(sessionId),
            execState: chatPanel.getSessionExecState(sessionId),
            collaborationMode: ms.collaborationMode,
            pricing: defaultPricing(row.kind, eff.model),
            temperature: 0.7,
            // 从模型目录动态解析窗口（deepseek-v4 标 1M），查不到才 fallback 200K。
            // 0b3e5bf 曾加 Math.min(..., 200000) 硬封顶 — 把动态结果压成 200K，
            // 导致压缩在 110K 就触发；压缩已根治为只影响发送载荷，cap 无必要。
            // 方案甲：按会话生效模型 + provider 行覆盖计算。
            contextWindow: this._contextWindowFor(row, eff.model),
            onSessionPersisted: (_sid: string, messages: Array<{ role: string; content: unknown }>) => {
              memoryBundleIngest(
                messages.map((m) => ({
                  role: m.role,
                  content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                })),
                'holo',
                _sid,
              ).catch(() => {});
              (async () => {
                await refreshGitStatus(this.path);
                if (this._graphEngineOn) await refreshTimeline(this.path);
                // 只消费本 Agent 产生的构建结果（其他会话的留在槽位等本尊）——
                // 并发会话：用本工厂闭包捕获的 agent（handle 建成即定），不再
                // 经共享 agentRef.current（最后创建的卷）错路由。
                const block = buildTurnStartBlock(sessionAgentId);
                if (block)
                  agentRef.current?.insertMessage(`<system-reminder>\n${block}\n</system-reminder>`, { silent: true });
              })().catch(() => {});
            },
          },
          // S4-1a：会话组合覆盖（prompt/capabilities 域随会话换源；缺省 =
          // runtime 组合 = 工作区装配组合，S2 零漂移）
          compositionOverride,
        );
      } catch (e) {
        // Phase D（错误不静默，2026-08-28 加固）：createAgent 抛错此前被上层
        // 静默吞掉（createNewSession catch{} / ensureSessionAgent 无 catch）→
        // 「点发送没反应」。这里落 ui.log（[DEBUG-send] 标签），错误仍上抛由
        // 调用方（sendMessage 已加 catch）可见化。
        const msg = e instanceof Error ? e.message : String(e);
        log.error('workspace', `[DEBUG-send] 会话 Agent 装配抛错（projectPath=${this.path}）: ${msg}`, {
          stack: e instanceof Error ? e.stack : undefined,
        });
        throw e;
      }

      const agent = '_getAgent' in handle ? (handle as { _getAgent(): Agent })._getAgent() : null;
      if (!agent) {
        // Phase D（错误不静默）：句柄建了但 raw Agent 取不到——可见诊断，不只进
        // console（会话层只会看到「工厂返回空」，这里补上根因）
        const msg = '会话 Agent 创建失败（运行时句柄无 raw Agent）';
        useAgentPanelStore.getState().setDiag({ text: `❌ ${msg}`, ready: false });
        this.onStatusChange?.(`⚠️ ${msg}`);
        return null;
      }
      agentRef.current = agent;
      this._lastRawAgent = agent;
      return handle;
    };

    // 注册工厂（DSH 形态，2026-08-25：工厂 = 「知道怎么造」，零成本挂接）。
    // 不再预造初始 Agent——句柄生命周期跟随卷，拟文时 ensureSessionAgent
    // 经工厂现造；raw Agent 引用面由 factory 内部 agentRef 承担。
    chatPanel.setAgentFactory(factory);
    this._factoryRegistered = true;
    this.onStatusChange?.('[Agent] ✅ 工厂已就绪（拟文时装配）');
  }

  // ═══════════════════════════════════════════════════════════════
  // runCheck — 健康检查 / 简报
  // ═══════════════════════════════════════════════════════════════

  async runCheck(): Promise<void> {
    // 工作区已停用（切换中/后）不跑 — 否则在途 RPC resolve 会把旧项目
    // 结果写进新项目的 dock store 并弹开 check 面板（landmine-map H4）
    if (!this._active || !this.path) return;
    // 引擎开关关闭（2026-08-22）：简报是图数据面的一部分，一并停用。
    // 关键防御：hologram_run_check 的 Rust 侧有隐藏回退链（引擎空 →
    // engine_init → 仍空 → direct_analyze(force=true) 全量强分析），
    // 不 gate 这里，开关会被静默击穿——用户关了图谱却后台跑 420s 分析。
    if (!this._graphEngineOn) return;
    if (this.checkRunning) {
      this.checkPending = true;
      return;
    }
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }

    this.checkRunning = true;
    this.checkPending = false;
    try {
      const json = await typedRpc('hologram_run_check', { path: this.path });
      // 在途期间工作区已停用 — 结果是旧项目的，直接丢弃不写共享 store
      if (!this._active) return;
      try {
        const result: CheckResult = JSON.parse(json);
        const dock = useDockStore.getState();
        dock.setCheckResult(result);
        // C14：check 面板已随 V5 退役——不再 openPanel('check')；
        // 简报对用户的可见性走下方 statusText + 违规徽章
        bumpTimelineRefresh();
        // 通知工具栏以显示违规徽章
        const cnt =
          (result.l5_violations?.length || 0) +
          (result.l4_violations?.length || 0) +
          (result.l3_violations?.length || 0) +
          (result.l2_violations?.length || 0);
        // P1 总线归零：原 bus 'check:result' → bridge-adapters 转写，现直写 shell-store
        useShellStore.getState().setViolations(result.passed ? 0 : cnt);
        // 推送状态栏通知 — 即使检查面板关闭也可见
        if (!result.passed) {
          this.onStatusChange?.(`⚠ 简报未通过: ${cnt} 条违规`);
        }
      } catch (parseErr) {
        console.error('[runCheck] JSON parse failed:', parseErr, 'raw:', json.slice(0, 200));
        this.onStatusChange?.('简报解析失败');
      }
    } catch (err) {
      console.error('Check failed:', err);
      this.onStatusChange?.('简报请求失败');
    } finally {
      this.checkRunning = false;
      // 在途期间工作区已停用 — 不重武装 timer，旧项目的 pending 检查就此丢下
      if (this._active && this.checkPending) {
        this.checkPending = false;
        if (this.checkTimer) clearTimeout(this.checkTimer);
        this.checkTimer = setTimeout(() => {
          this.checkTimer = null;
          if (!this.checkRunning) this.runCheck();
        }, 2000);
      }
    }
  }

  /** 防抖检查 — Agent 写入文件时调用。3 秒延迟批量处理多次写入。 */
  scheduleCheck(): void {
    // 工作区已停用（切换中/后）不再排程 — 否则 timer 触发会走 runCheck 把
    // 旧项目结果写进新项目面板（landmine-map H4）
    if (!this._active || !this.path) return;
    // 引擎开关关闭：不排程（runCheck 已 gate，这里拦 timer 空转——同族防御）
    if (!this._graphEngineOn) return;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      if (!this.checkRunning) this.runCheck();
    }, 3000);
  }
}

// ═══════════════════════════════════════════════════════════════
// buildSystemPrompt — 纯函数，读取 Workspace 状态
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// （数据流追踪 Agent 已移除 — 由引擎查询替代）
