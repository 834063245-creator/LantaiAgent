// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent 循环 — Run() → stream() → StreamingToolExecutor → 循环直到模型给出最终答案

import { currentPresetId } from '../composition/preset-assembly';
import { STREAM_IDLE_TIMEOUT_MS, streamWithIdleTimeout } from '../provider/idle-stream';
import type { StoredThinking } from '../provider/thinking';
import type { Message, Provider, ToolCall, ToolSchema, Usage } from '../provider/types';
import { ChunkType } from '../provider/types';
import { typedRpc } from '../rpc-contract';
import {
  applyAutoTuneConfigImpl,
  type CompactionHost,
  callSummaryLLMImpl,
  compactNowImpl,
  computeCompactRegionImpl,
  foldHead,
  loadCompactionConfigImpl,
  loadCompactionTrackerImpl,
  maybeCompactImpl,
  mergePartialsImpl,
  payloadMessagesImpl,
  selectSummaryProviderImpl,
  setCompactionConfigPathImpl,
  summarizeRegionImpl,
  summaryProviderImpl,
} from './agent-compaction';
import type { AgentRecord, AgentStore } from './agent-store';
// 共享类型 — 本文件内部也使用
import {
  type AgentEvent,
  type AgentUINotifier,
  computeCost,
  EventKind,
  type EventSink,
  type Pricing,
  type ToolEvent,
} from './agent-types';
import { type CompactionConfig, type CompactionSessionStats, CompactionTracker } from './compaction-model';
import type { AgentContext } from './context';
import { type ExecStateInstance, execState } from './execution-state';
import { type GoalLoopHost, type GoalRunResult, resumeGoalImpl, runGoalImpl } from './goal-loop';
import type { GoalManager } from './goal-manager';
import type { HookRegistry, PreflightHookRegistry } from './hooks';
import { log } from './logger';
import { batchStormSignature, finishReasonMessage, parseFilePathArg, type ToolOutcome } from './loop-helpers';
import { type PlanGate, planGateCheck } from './plan/plan-registry';
import { backoffDelay, isRetryable, MAX_RETRIES, sleepWithAbort } from './retry';
import { SessionLog, type SessionResetReason } from './session-log';
import { StreamingToolExecutor } from './streaming-executor';
import { type SubAgentSpawnHost, spawnSubAgentImpl } from './subagent-spawn';
import { countMessage, countMessages, countTexts, countToolSchemas } from './token-counter';
import type { ToolRegistry } from './tool';
import { createStableSchemaSelector, type StableSchemaSelector, userContext } from './tool-select';
import { resolveGuardToolName } from './tools/domains';
import { truncateToolOutput } from './truncate';

// 11c 拆分：wrapTool / buildSubAgentTools 原体已迁 subagent-spawn.ts，
// 此处 re-export 保外部导入面不变（tests/subagent-tool-strip.test.ts 等消费）。
export { buildSubAgentTools, wrapTool } from './subagent-spawn';

import type { DiscoveryBoard } from './discovery-board';
import type { FileOwnership } from './file-ownership';
import type { MessageBus } from './message-bus';
import type { TaskBoard } from './task-board';

export { type AgentEvent, computeCost, EventKind, type EventSink, type Pricing, type ToolEvent };

// ---- Agent 选项 ----

export interface AgentOptions {
  temperature?: number;
  pricing?: Pricing;
  /** 上下文窗口大小（token 数）。0 = 不压缩。 */
  contextWindow?: number;
  /** 触发压缩的 contextWindow 比例（默认: 0.7） */
  compactRatio?: number;
  /** 原文保留的最少近期消息数 */
  recentKeep?: number;
  /** 用于持久化的会话 ID。未提供则自动生成。 */
  sessionId?: string;
  /** 每次会话保存后调用（fire-and-forget，不阻塞循环）。 */
  onSessionPersisted?: (sessionId: string, messages: Message[]) => void;
  /** 子 Agent 嵌套深度（0 = 根，1 = 第一次 fork）。自动递增。 */
  subagentDepth?: number;
  /** 唯一 Agent 标识符。未提供则自动生成。 */
  agentId?: string;
  /** 派生此 Agent 的父 Agent ID。主 Agent 为 null。 */
  parentId?: string | null;
  /** 自定义事件 sink。设置后，Agent 事件发送到此处而非默认空操作。
   *  子 Agent 用它将输出捕获到 SubAgentPart。 */
  eventSink?: (ev: AgentEvent) => void;
  /** 执行状态实例。未提供则回退到全局 execState。 */
  execState?: ExecStateInstance;
  /** 每轮发给模型的工具 schema 上限（0 = 全量，默认 14）。 */
  visibleToolsLimit?: number;
  /** 工具结果批量折叠大小（默认 0 = 禁用）。tool 消息总数每超过
   *  折叠边界 + 2×batch 时，把最早一批（batch 条）折叠为占位符。
   *  默认禁用：在 DeepSeek 前缀缓存计价下，折叠省的（hit 1/50 价）与
   *  断的（边界后全价 miss）大致相抵甚至亏本；需要时再开启。 */
  toolResultWindow?: number;
  /** UI 通知端口 — 进度 / 工具完成 / 子 Agent 生命周期。
   *  由 workspace 注入；headless Agent 无。 */
  ui?: AgentUINotifier;
  /** 通信总线（可选 — 无则为 headless 无通信能力） */
  messageBus?: MessageBus;
  /** TaskBoard — 共享状态区，追踪异步子 Agent 的工作状态 */
  taskBoard?: TaskBoard;
  /** DiscoveryBoard — 共享发现区，Agent 间交换探索结果 */
  discoveryBoard?: DiscoveryBoard;
  // gate 已移除 — 权限由 Rust 后端 has_permission_to_use_tool() 处理
}

const STORM_BREAK_THRESHOLD = 3;
// 默认发全量可见工具 schema（0 = 全量）。DeepSeek 前缀缓存对 tools 段敏感：
// 按用户消息重打分选子集会让 tools 段漂移，整段历史缓存失效按全价计费
// （实测单次 ~10 万 tokens）。全量目录 ~46 工具 ≈ 10k tokens，逐字节稳定后
// 常驻缓存按 1/14 命中价计费，远低于一次全量 miss。设 >0 回退打分子集模式。
const DEFAULT_VISIBLE_TOOLS_LIMIT = 0;

// ---- Agent ----

export class Agent {
  private prov: Provider;
  private tools: ToolRegistry;
  private session: Message[];
  /** Phase 5：会话事件溯源日志 — 模型可见事实先入日志，this.session 为投影。 */
  private _sessionLog: SessionLog;
  private temperature: number;
  private _visibleToolsLimit: number;
  _toolResultWindow: number;
  /** 工具结果折叠边界（session tool 消息序号维度）— 批量前移，保持载荷前缀稳定 */
  _toolFoldBoundary = 0;
  private pricing: Pricing | undefined;
  _agentOpts: AgentOptions;

  // 装配 context — 身份/服务唯一来源；setBus/setSubAgentPool/setGoalManager
  // 经 write-through 把后续注入同步回 ctx（ctx 是服务真源）。
  private _ctx: AgentContext;

  /** 装配用组合产物（S4-1a）— ctx 路径从服务表读（runtime 装配期写入；
   *  child() 继承白名单成员，子 Agent 与父同一组合面）。
   *  消费面：spawnSubAgent 透传子 Agent（ctx 路径）、诊断/测试只读。 */
  private readonly _composition: import('../composition/roster').ResolvedComposition | null = null;

  /** 会话创建时点生效的 preset id（S4-1b 首事件的事实源镜像——构造期读
   *  currentPresetId()；空白会话期经 selectPreset() 改选并追加同名事件）。
   *  子 Agent 经 ctx composition 继承组合面，但各 Agent 各自记首事件。 */
  private _presetId: string = 'standard';

  /** 装配用组合产物（只读面）。 */
  get composition(): import('../composition/roster').ResolvedComposition | null {
    return this._composition;
  }

  // 上下文管理
  private contextWindow: number;
  private compactRatio: number;
  private recentKeep: number;
  // 真卡死闩锁 — 仅在"折叠后载荷仍 >95% 窗口"时置位（此时压缩确实
  // 无能为力，只有 /new 能解决）。瞬时失败不再使用它 — 见下方退避门控。
  compactStuck = false;
  // 压缩退避门控: session 长度未涨到此值不重试。空区域（对话太短）和
  // 失败后都通过它延迟重试 — 增长足够后自动恢复，无永久闩锁。
  compactRetryAfterLen = 0;
  // 连续失败计数 — 决定退避步长与是否升级用户告警
  compactFailCount = 0;
  // 缓存的摘要模型选择（null = 未计算）— 运行时自动选出，无用户配置
  _summaryProv: { prov: Provider; window: number } | null = null;

  // 子 Agent 深度追踪: 0 = 根，1 = 第一次 fork，2 = 孙 Agent，以此类推
  // MAX_SUBAGENT_DEPTH 随 spawn 实现迁 subagent-spawn.ts（宿主模式消费）
  _subagentDepth = 0;

  /** 只读深度访问器 — runtime/UI 观测用（agent_status 列表、后台活动过滤） */
  get subagentDepth(): number {
    return this._subagentDepth;
  }

  // Agent 身份 — 持久化用于生命周期追踪、会话恢复、谱系
  readonly id: string;
  readonly parentId: string | null;
  private agentStore: AgentStore | null = null;
  /** Goal 管理器 — goal-loop.ts 经 GoalLoopHost 接口读取（11c 拆分后跨模块消费）。 */
  goalManager: GoalManager | null = null;

  // 子 Agent 的隔离 ID — 注入到工具参数中，使 Rust 后端
  // 能通过 forward_map_path 解析 worktree 路径。
  _isolationId?: string;

  // Goal 循环实现已迁 goal-loop.ts（MAX_GOAL_ITERATIONS / MAX_STALL_ROUNDS 随迁）
  // PreToolUse hooks — 用图上下文增强工具结果
  private hooks: HookRegistry | null = null;

  // Preflight hooks — 破坏性写入前告警（edit_file / write_file）
  private preflightHooks: PreflightHookRegistry | null = null;

  // Pre-run hook — 在每条用户消息推入会话前调用。
  // 返回可选的上下文文本，作为 <system-reminder> 注入到消息前。
  // 由 workspace 设置，用于每轮 AuraSDK 语义记忆检索。
  private _preRunHook: ((input: string) => Promise<string | null>) | null = null;

  // Storm breaker — 检测重复失败的工具调用
  stormSig = '';
  stormCount = 0;

  // 缓存累积
  private cacheHitTotal = 0;
  private cacheMissTotal = 0;

  // 事件 sink — 父 Agent 使用全局总线；子 Agent 使用自定义 sink
  private _sink: (ev: AgentEvent) => void;
  // UI 通知端口（workspace 注入；headless 时为空操作）
  private _ui: AgentUINotifier;

  /** UI 会话 ID — 由 ChatCore 在运行前设置，使子 Agent 通知
   *  能更新正确的会话存储（而非仅活跃的）。子 Agent 派生域经宿主接口读取。 */
  _uiSessionId: number = 0;

  // code_execution 嵌套分发面（P2 执行原语）：blueprint capability 装配时
  // 写入（工具创建需要）；getter 供 capability 读取 agent 的门禁/hook/审计上下文。
  // 形状对齐 code-run/host.ts 的 ToolDispatchFn（输出 {output, isError}）。
  _codeDispatch:
    | ((name: string, args: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>)
    | null = null;

  /** code_execution 的嵌套分发面 — 工具装配（blueprint）注入。null = 未接线
   * （工具注册面照常，运行时报「未接线」错误，不留静默死路）。 */
  setCodeDispatch(
    fn: ((name: string, args: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>) | null,
  ): void {
    this._codeDispatch = fn;
  }
  getCodeDispatch():
    | ((name: string, args: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>)
    | null {
    return this._codeDispatch;
  }

  /** 会话事件日志只读访问（P2：code_execution 子分发审计追加面）。 */
  get sessionLog(): SessionLog {
    return this._sessionLog;
  }

  /** code_execution 的嵌套分发器 — executor 语义等价体（P2 C5/C6）。
   *
   *  复刻 streaming-executor.executeTool 的语义链（不 new executor：那套是
   *  流式边界专用，带 pending 管理与 UI 事件；这里只要单次调用的语义）。
   *  顺序：领域名解析（guardName）→ planGate → preflight HIGH → 元信息注入
   *  （_agent_id/_owner_id）→ execute → hooks 富化 → 预检警告前置 → 截断。
   *  嵌套调用不豁免任何门禁（P2 施工序 6）；isError 语义靠返回值区分
   *  （false = 成功 output；true = output 即错误文本）。 */
  dispatchNestedTool(name: string, args: Record<string, unknown>): Promise<{ output: string; isError: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return Promise.resolve({ output: `error: unknown tool "${name}"`, isError: true });
    }
    if (this.tools.isHidden(name)) {
      return Promise.resolve({ output: `[已淘汰] ${name} — 请用领域工具动作。`, isError: true });
    }
    const guardName = resolveGuardToolName(this.tools, name, args);

    // Plan 门禁（嵌套不豁免——与 executor 同规则）
    const blocked = this._planGate(guardName, args, tool);
    if (blocked) return Promise.resolve({ output: blocked, isError: true });

    // 预检钩子（HIGH 风险拦截至 _forceGate 语义——嵌套调用无 _forceGate 通道，
    // 高危写入在 code run 内一律打回：用户应直接调用工具走显式确认）
    let preflightWarning: string | null = null;
    if (this.preflightHooks) {
      try {
        preflightWarning = this.preflightHooks.check(guardName, args);
      } catch {
        preflightWarning = null; // 钩子异常不阻断（与 executor 同降级）
      }
    }
    if (preflightWarning?.includes('风险等级: HIGH')) {
      return Promise.resolve({
        output: `${preflightWarning}\n\n🚫 高风险写入不允许经 code_execution 嵌套执行——请直接调用工具并带 _forceGate: true。`,
        isError: true,
      });
    }

    // 元信息注入（与 executor 同序）：隔离 id + owner id（嵌套调用与直接调用
    // 同权限面——_agent_id 缺失会直写主仓，2026-08-13 事故防御）
    const enriched: Record<string, unknown> = { ...args };
    if (this._isolationId) enriched._agent_id = this._isolationId;
    if (this.id) enriched._owner_id = this.id;

    return tool
      .execute(enriched, undefined, this._currentRunSignal ?? undefined)
      .then(async (raw) => {
        let output = raw;
        // 工具后钩子富化（与 executor 同降级语义）
        if (this.hooks) {
          try {
            output = await this.hooks.apply(guardName, enriched, output);
          } catch {
            /* 富化失败不破坏结果 */
          }
        }
        if (preflightWarning) {
          output = `${preflightWarning}\n\n${'─'.repeat(40)}\n\n${output}`;
        }
        const trunc = truncateToolOutput(guardName, output);
        return { output: trunc.content, isError: false };
      })
      .catch((e: unknown) => {
        const eMsg = (e as { message?: string })?.message;
        const errMsg = eMsg ? eMsg.split('\n')[0] : String(e);
        return { output: `error: ${errMsg}`, isError: true };
      });
  }

  // 最近一次用量（用于状态显示）
  private lastUsage: Usage | undefined;

  // 执行状态 — 每个 Agent 实例独立（多窗口阶段 1）
  private _execState: ExecStateInstance;

  // 待插入的用户消息（工具执行期间排队，在安全边界应用）
  private _pendingInserts: string[] = [];

  // 待处理的记忆更新（从 memory:saved 事件排队，在安全边界应用）
  private _pendingMemoryUpdates: string[] = [];

  // 追踪本轮 runLoop 已注入的 inbox 消息 — 防止 LLM 不 ack/reply 时
  // 无限唤醒循环（消息留在 inbox，finally 块会不断重新触发 _onMessageDelivered）。
  private _injectedMsgIds = new Set<string>();

  // 当前活跃 runLoop 的 signal — 从工具调用派生的子 Agent
  // 将其合并到自己的 abort signal 中，使用户停止能级联到子 Agent。
  // 子 Agent 派生域（subagent-spawn.ts）经宿主接口读取。
  _currentRunSignal: AbortSignal | null = null;

  // runLoop 是否正在运行 — 用于 bus 唤醒时避免重入
  private _isRunning = false;

  /** runLoop 是否正在运行 */
  get isRunning(): boolean {
    return this._isRunning;
  }

  // TaskBoard — 异步子 Agent 追踪的共享状态区
  // （子 Agent 派生域经宿主接口读取 — 11c 拆分）
  _taskBoard: TaskBoard | null = null;

  // DiscoveryBoard — Agent 间知识共享的共享发现区
  // （子 Agent 派生域经宿主接口读取 — 11c 拆分）
  _discoveryBoard: DiscoveryBoard | null = null;

  // 追踪已注入的 discovery ID — 防止同一 runLoop 内重复注入
  private _injectedDiscoveryIds = new Set<string>();

  // 临时提醒 — 每轮 <system-reminder> 注入，发送给 LLM
  // 但不持久化到 this.session。每个 runLoop 步骤开始时清除。
  // 保持会话历史干净以获得稳定的缓存前缀。
  private _transientReminders: string[] = [];

  // 文件所有权 — 并行子 Agent 的运行时写保护。
  // 仅 fresh 子 Agent（无 worktree 隔离）受声明约束。
  // （子 Agent 派生域经宿主接口读写 — 11c 拆分）
  _fileOwnership: FileOwnership | null = null;

  // 会话持久化
  sessionId: string;
  private _onSessionPersisted: ((sessionId: string, messages: Message[]) => void) | undefined;
  /** 已持久化到 NDJSON 的消息数（P1-15 增量游标）。saveState 只追加此下标之后的消息。 */
  private _persistedMsgCount = 0;
  /** 已持久化到 session-log.ndjson 的最大事件 seq（Phase 5 双写游标）。
   *  事件只增不减（reset/retract 也是事件）—— 与消息游标不同，永不重置。 */
  private _persistedEventSeq = 0;
  /** 事件日志写链 — run() 结尾的 fire-and-forget saveState 与显式/dispose saveState
   *  并发时，同游标重复追加的事件会让 ndjson 出现重复 seq（回放即拒绝）。按调用序
   *  串行化（模式参照 AgentStore._indexChain / BoardPersistence._writeChain，P1-13）。 */
  private _eventAppendChain: Promise<void> = Promise.resolve();

  // 压缩成本模型追踪器
  private compactionTracker = new CompactionTracker();
  _compactionConfigPath: string | null = null;
  _compactionTrackerPath: string | null = null;

  // ── 压缩折叠状态（根治: session = 完整历史，压缩只影响发送载荷）──
  // session 永不被压缩动作替换 — UI 渲染与磁盘存档始终完整。
  // 压缩 = 生成摘要 + 记录折叠点；payloadMessages() 据此构造发送载荷。
  _compactSummary: string | null = null;
  _compactTailStart = -1;

  constructor(ctx: AgentContext, systemPrompt: string, opts: AgentOptions = {}) {
    this._ctx = ctx;
    this.prov = ctx.resolve('provider');
    this.tools = ctx.resolve('tools');
    this._sink = opts.eventSink ?? ctx.get('eventSink') ?? (() => {});
    this._ui = opts.ui ?? {};
    this._agentOpts = opts;
    this.temperature = opts.temperature ?? 0.7;
    this._visibleToolsLimit = opts.visibleToolsLimit ?? DEFAULT_VISIBLE_TOOLS_LIMIT;
    // 默认禁用折叠 — 见 toolResultWindow 注释（DeepSeek 缓存计价下不划算）
    this._toolResultWindow = opts.toolResultWindow ?? 0;
    this.pricing = opts.pricing;
    this.contextWindow = opts.contextWindow || 1000000; // 1M tokens 默认值; || 捕获零值（设置默认值），使压缩永不被静默禁用
    // ponytail: 0.55 将阈值设在 550K token（1M 窗口）。
    // 0.7 太高 — 最大的真实会话（450-630K）从未触发。
    // 积累足够样本后根据 compaction-model.ts 数据调优。
    this.compactRatio = opts.compactRatio ?? 0.55;
    this.recentKeep = opts.recentKeep ?? 4;
    this._subagentDepth = ctx.subagentDepth ?? opts.subagentDepth ?? 0;
    this.id = ctx.agentId ?? opts.agentId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.parentId = ctx.parentId ?? opts.parentId ?? null;
    this._execState = opts.execState ?? ctx.get('execState') ?? execState;
    this._bus = ctx.get('messageBus') ?? opts.messageBus ?? null;
    this._taskBoard = ctx.get('taskBoard') ?? opts.taskBoard ?? null;
    this._discoveryBoard = ctx.get('discoveryBoard') ?? opts.discoveryBoard ?? null;
    this.agentStore = ctx.get('agentStore') ?? null;
    this.goalManager = ctx.get('goalManager') ?? null;
    this._subAgentPool = ctx.get('subAgentPool') ?? null;
    this._composition = ctx.get('composition') ?? null;

    this.sessionId = opts.sessionId || `session-${Date.now()}`;
    this._onSessionPersisted = opts.onSessionPersisted;

    // Phase 5 双写：日志先于 session 初始化（构造期的 system prompt 也走事件入口）。
    this._sessionLog = ctx.get('sessionLog') ?? new SessionLog();
    this.session = [];
    if (systemPrompt) {
      this._replaceSession([{ role: 'system', content: systemPrompt }], 'init');
    }
    // S4-1b 首事件：构造（init reset）后必发 preset/selected——创建时点事实
    // （「模型可见 ⟺ 已记录」：preset 决定模型看到的 schema/段，必须可重建）。
    this._presetId = currentPresetId();
    this._sessionLog.append('preset/selected', { presetId: this._presetId });

    // bus 注册与隔离接线在构造内完成（ctx 为唯一入口）。
    if (this._bus) {
      const bus = this._bus;
      this.setBus(bus);
      // Phase 4：bus 注册的对称清理归 ctx 所有权——runtime _disposeAgent 经
      // ctx.dispose() 逆序统一释放（flush 前置顺序在 _disposeAgent 内保持）。
      ctx.effect(() => () => bus.unregister(this.id), 'bus-unregister');
    }
    if (ctx.isolationId) this._isolationId = ctx.isolationId;
  }

  /** 由 workspace 在会话中途保存记忆时调用 — 排队并在
   *  下一个安全边界作为 system-reminder 注入。 */
  notifyMemorySaved(text: string): void {
    this._pendingMemoryUpdates.push(text);
  }

  setHooks(hooks: HookRegistry): void {
    this.hooks = hooks;
  }

  setPreflightHooks(hooks: PreflightHookRegistry): void {
    this.preflightHooks = hooks;
  }

  /** Plan 模式状态 + 注入器 — 由 Runtime 在 createAgent 时设置。
   *  2026-08-10 起不再按 plan 状态切换工具注册表（schema 跨模式恒定，
   *  DeepSeek 前缀缓存不被 enter/exit 击穿）；写约束在执行层按
   *  planState 运行时拦截（planGateCheck → StreamingToolExecutor）。 */
  private _planState: import('./plan/plan-state').PlanStateManager | null = null;
  private _planInjector: import('./plan/plan-injection').PlanModeInjector | null = null;
  /** 项目路径 — plan 模式 enter 需要（UI 按钮切换路径） */
  private _projectPath = '';

  /** Plan 门禁委托 — 稳定引用供 executor 构造时注入；运行时读取最新 _planState。 */
  private _planGate: PlanGate = (name, args, tool) => planGateCheck(this._planState, name, args, tool);

  setPlanState(
    state: import('./plan/plan-state').PlanStateManager,
    injector: import('./plan/plan-injection').PlanModeInjector,
    projectPath = '',
  ): void {
    this._planState = state;
    this._planInjector = injector;
    this._projectPath = projectPath;
  }

  /** UI 按钮路径 — 运行时切换 plan 模式，不重建 Agent。 */
  setPlanMode(active: boolean): void {
    if (!this._planState) return;
    if (active && !this._planState.state.active) {
      if (!this._projectPath) return;
      this._planState.enter(this._projectPath);
    } else if (!active && this._planState.state.active) {
      this._planState.exit();
    }
  }

  /** UI 按钮路径 — 运行时更新思考策略（ModelSwitcher 切档位/深思考开关），
   *  不重建 Agent。子 Agent 共享 this.prov，自动一并生效。 */
  setThinking(cfg: StoredThinking | undefined): void {
    this.prov.setThinking?.(cfg);
  }

  /** UI 路径 — 运行时切换 provider（模型/提供方/协议），不重建 Agent。
   *  正在进行的请求已持有旧引用，继续完成后下一轮起用新 provider；
   *  子 Agent 共享 this.prov，自动一并生效。
   *  同时更新定价并清空摘要模型缓存，避免压缩摘要仍走旧模型。 */
  setProvider(prov: Provider, pricing?: Pricing): void {
    this.prov = prov;
    if (pricing) this.pricing = pricing;
    this._summaryProv = null;
    // write-through：子 Agent 从 ctx 服务表继承 provider（context.ts child()）。
    // 不写则热切换后新 spawn 的子 Agent 仍持有旧 provider/旧 Key ——
    // 2026-08-16 全链路断链审计（provider 切换 不生效 的根因之一）。
    try {
      this._ctx.set('provider', prov);
    } catch {
      /* ctx 已 dispose —— 忽略写入 */
    }
  }

  /** 从持久化快照恢复 plan 状态 — 在 agent load 后调用 */
  restorePlanState(
    snapshot: import('./plan/plan-state').PlanStateSnapshot | null | undefined,
    projectPath: string,
  ): void {
    if (this._planState) {
      this._planState.fromSnapshot(snapshot ?? null, projectPath);
    }
  }

  setUiSessionId(sid: number): void {
    this._uiSessionId = sid;
  }

  /** 设置在每条用户消息进入会话前触发的 hook。
   *  返回可选的上下文，作为 <system-reminder> 注入到消息前。
   *  用于每轮 AuraSDK 语义记忆检索。 */
  setPreRunHook(hook: (input: string) => Promise<string | null>): void {
    this._preRunHook = hook;
  }

  // ---- 公共 API ----

  getSession(): Message[] {
    return this.session;
  }

  /** Phase 5：本 Agent 的事件溯源日志（观测/差分/回放入口）。
   *  append 只发生在运行时边界（下方三个双写入口），外部不得直写。 */
  getSessionLog(): SessionLog {
    return this._sessionLog;
  }

  // ── Phase 5 双写入口：模型可见事实先 append 事件，同一消息对象进 session 投影 ──
  // 旧数组路径保留为真源（restore/UI/持久化读它）；等价性由 tests/session-differential.test.ts
  // 差分矩阵与 baseline/phase-5 契约快照钉住。agent.ts 内禁止绕过这三个入口直改 session。

  /** 追加一条模型可见消息（user / assistant / tool）。 */
  private _appendMessage(kind: 'user/message' | 'assistant/text' | 'tool/result', message: Message): void {
    this._sessionLog.append(kind, { message });
    this.session.push(message);
  }

  /** 会话整体替换（构造 init / setSession 恢复 / newSession / goal 恢复与清场）。
   *  事件内携带深拷贝快照（调用方后续改动不得回写历史）；折叠失效与游标重置
   *  语义留在调用点，与替换来源一一对应。 */
  private _replaceSession(messages: Message[], reason: SessionResetReason): void {
    this._sessionLog.append('session/reset', {
      messages: messages.map((m) => JSON.parse(JSON.stringify(m)) as Message),
      reason,
    });
    this.session = messages;
  }

  /** 区间撤回（[fromIndex, toIndex) splice 语义 — retractTurnAt / goal 暂停裁剪）。 */
  private _retractSessionRange(fromIndex: number, toIndex: number): void {
    this._sessionLog.append('session/retract', { fromIndex, toIndex });
    this.session.splice(fromIndex, toIndex - fromIndex);
  }

  setSession(msgs: Message[]): void {
    this._replaceSession(msgs, 'restore');
    // 会话被替换（恢复/加载）→ 折叠状态失效，从完整历史重新开始
    this._compactSummary = null;
    this._compactTailStart = -1;
    // P1-15: 增量游标重置 — 替换进来的消息不在本 Agent 的 NDJSON 里，
    // 下次 saveState 全量重建，保证磁盘与会话一致。
    this._persistedMsgCount = 0;
    this._execState.bumpVersion();
    this._ui.sessionReplaced?.(this.session);
  }

  /** 空白会话期改选 preset（S4-1b）：追加 preset/selected 事件（newest-wins
   *  重建的依据）+ 镜像字段更新。注意：**不重装配**——组合面在创建时点
   *  冻结（前缀缓存纪律；真正生效的下一次装配在会话边界）。本方法只服务
   *  「会话还没跑起来时改了默认 preset」的记录修正语义。 */
  selectPreset(presetId: string): void {
    this._presetId = presetId;
    this._sessionLog.append('preset/selected', { presetId });
  }

  /** 会话的 preset 选择重建（newest-wins；无事件 = undefined——S4-1b 前
   *  的旧会话文件兼容：调用方以 'standard' 缺省）。 */
  get sessionPresetId(): string | undefined {
    return this._sessionLog.resolveSessionPreset();
  }

  getLastUsage(): Usage | undefined {
    return this.lastUsage;
  }

  getCacheTotals(): { hit: number; miss: number } {
    return { hit: this.cacheHitTotal, miss: this.cacheMissTotal };
  }

  /** 获取当前会话的压缩成本模型统计。 */
  getCompactionStats(): CompactionSessionStats {
    return this.compactionTracker.getStats(this.pricing);
  }

  /** 压缩统计工具的公共访问器。 */
  getCompactionTracker(): CompactionTracker {
    return this.compactionTracker;
  }
  getPricing(): Pricing | undefined {
    return this.pricing;
  }
  getCompactRatio(): number {
    return this.compactRatio;
  }
  getRecentKeep(): number {
    return this.recentKeep;
  }
  getContextWindow(): number {
    return this.contextWindow;
  }

  /** 运行时更新上下文窗口（压缩阈值）。设置面板改 contextWindow 后热切换，
   *  不重建 Agent — 所有压缩判定都是运行时读此字段，下次判定即生效。 */
  setContextWindow(n: number): void {
    this.contextWindow = n > 0 ? n : 1000000; // 与构造兜底同语义
  }

  /** 运行时更新定价表（Phase C，2026-08-24）：同提供方内切换模型后 token
   *  计费跟随，不换 provider 引用（live 形态按名现解析，无需重建）。 */
  setPricing(p: Pricing): void {
    this.pricing = p;
  }

  /** 设置自动调优压缩配置的持久化路径（委托 agent-compaction.ts）。 */
  setCompactionConfigPath(projectPath: string): void {
    setCompactionConfigPathImpl(this as unknown as CompactionHost, projectPath);
  }

  /** E5: 从磁盘加载持久化的 tracker 状态。 */
  async loadCompactionTracker(): Promise<void> {
    return loadCompactionTrackerImpl(this as unknown as CompactionHost);
  }

  /** 尝试加载持久化的压缩配置。无保存则返回 null。 */
  async loadCompactionConfig(): Promise<CompactionConfig | null> {
    return loadCompactionConfigImpl(this as unknown as CompactionHost);
  }

  /** 应用自动调优的压缩参数。返回应用的配置。 */
  async applyAutoTuneConfig(): Promise<CompactionConfig | null> {
    return applyAutoTuneConfigImpl(this as unknown as CompactionHost);
  }

  /** 撤回一轮: 从 sessionIndex 开始移除用户消息 + 后续的 assistant + tool 消息。
   *  通过 SessionChanged 事件通知 UI。 */
  retractTurnAt(sessionIndex: number): void {
    let end = sessionIndex + 1;
    while (end < this.session.length && this.session[end].role !== 'user') {
      end++;
    }
    this._retractSessionRange(sessionIndex, end);
    this._execState.bumpVersion();
    this._sink({ kind: EventKind.SessionChanged });
    this._ui.sessionReplaced?.(this.session);
  }

  /** 预测下一次插入的会话索引。在 insertMessage 前调用获取索引。 */
  get nextInsertIndex(): number {
    return this.session.length + this._pendingInserts.length;
  }

  /** 将消息插入会话队列。安全排队；Agent 在下次循环迭代时看到。
   *  通知是可选的 — 系统调用方（onSessionPersisted）应传 silent=true。 */
  insertMessage(text: string, opts?: { silent?: boolean }): void {
    this._pendingInserts.push(text);
    if (!opts?.silent) {
      this._sink({ kind: EventKind.Notice, level: 'info', text: '消息已插入，Agent 将在下一轮看到' });
    }
  }

  // ── 子 Agent 生命周期 ──

  /** 子 Agent 池的引用。由 workspace 在构造后设置。 */
  private _subAgentPool: import('./coordinator').SubAgentPool | null = null;

  /** Agent 间通信的消息总线。由 runtime/spawnSubAgent 设置。 */
  private _bus: MessageBus | null = null;

  setSubAgentPool(pool: import('./coordinator').SubAgentPool): void {
    this._subAgentPool = pool;
    this._ctx.set('subAgentPool', pool);
  }

  /** 接线 Agent 间通信的消息总线。
   *  注册 Agent 地址 + 唤醒回调，当 Agent 空闲时消息到达会触发 runLoop。 */
  setBus(bus: MessageBus): void {
    this._bus = bus;
    this._ctx.set('messageBus', bus);
    bus.register({ agentId: this.id, parentId: this.parentId, depth: this._subagentDepth }, () => {
      void this._onMessageDelivered();
    });
  }

  /** 接线 discovery board 用于 Agent 间知识共享。
   *  由 runtime 调用，将共享 board 注入每个 Agent。 */
  setDiscoveryBoard(board: DiscoveryBoard): void {
    this._discoveryBoard = board;
  }

  /** 级联中止: 父 Agent 被中断时停止所有子 Agent。 */
  cascadeAbort(): void {
    const pool = this._subAgentPool;
    if (pool) {
      const stopped = pool.stopAll();
      if (stopped.length > 0) {
        log.info('agent', `cascade abort: stopped ${stopped.length} sub-agents`);
      }
    }
  }

  /** 接线文件所有权注册表，用于并行子 Agent 写保护。
   *  仅 fresh 子 Agent（无 worktree）受声明约束。 */
  setFileOwnership(fo: FileOwnership): void {
    this._fileOwnership = fo;
  }

  /** Bus 唤醒回调 — 当消息投递到此 Agent 的 inbox 时调用。
   *  若 Agent 空闲（未运行），启动新的 runLoop 处理消息。
   *  若正在运行，_injectInbox 会在下次迭代时拾取消息。 */
  private async _onMessageDelivered(): Promise<void> {
    if (this._isRunning) return;
    if (this._bus?.unreadCount(this.id) === 0) return;
    const signal = this._execState.start();
    try {
      await this.run(signal, '');
    } catch {
      // 唤醒失败不致命——消息还在 inbox，下次 run() 会捡到
    } finally {
      this._execState.done();
    }
  }

  /** 批量停止所有运行中的子 Agent。返回已停止的 Agent ID 列表。 */
  stopAllSubAgents(): string[] {
    return this._subAgentPool?.stopAll() ?? [];
  }

  /** 当前运行中的子 Agent 数量。 */
  runningSubAgentCount(): number {
    return this._subAgentPool?.runningCount ?? 0;
  }

  // ── Agent 身份与持久化 ──

  /** 接线持久化存储。主 Agent 从 Workspace 获取；
   *  子 Agent 从父 Agent 继承同一存储。 */
  setAgentStore(store: AgentStore): void {
    this.agentStore = store;
  }

  setGoalManager(mgr: GoalManager): void {
    this.goalManager = mgr;
    this._ctx.set('goalManager', mgr);
  }

  /** 将当前状态 + 会话持久化到磁盘。Best-effort — 不抛异常。
   *  会话走 NDJSON 增量追加（P1-15）：只写 _persistedMsgCount 之后的新消息，
   *  消除每轮全量重写 session.json 的 O(全量) 写放大。 */
  async saveState(status: AgentRecord['status'] = 'running'): Promise<void> {
    if (!this.agentStore) return;
    try {
      const planSnapshot = this._planState?.toSnapshot() ?? undefined;
      await this.agentStore.save(this.id, {
        parentId: this.parentId,
        description: this.id === 'main' ? '主Agent' : `子Agent (depth ${this._subagentDepth})`,
        status,
        subagentDepth: this._subagentDepth,
        planSnapshot,
      });
      // 会话增量：长度收缩（撤回/替换）→ truncate 全量重建；否则 append 新增段
      if (this.session.length < this._persistedMsgCount) {
        await this.agentStore.appendMessages(this.id, this.session, true);
      } else if (this.session.length > this._persistedMsgCount) {
        await this.agentStore.appendMessages(this.id, this.session.slice(this._persistedMsgCount));
      }
      this._persistedMsgCount = this.session.length;
      // Phase 5 双写：事件日志增量追加（append-only —— reset/retract 也是事件，
      // 无 rewrite 路径；事件游标与消息游标独立，永不重置）。经写链串行化 —
      // 并发 saveState（run 结尾 fire-and-forget + 显式/dispose）不得重复追加。
      const store = this.agentStore;
      const persistEvents = async (): Promise<void> => {
        const pendingEvents = this._sessionLog.eventsAfter(this._persistedEventSeq);
        if (pendingEvents.length === 0) return;
        await store.appendSessionEvents(this.id, pendingEvents);
        this._persistedEventSeq = pendingEvents[pendingEvents.length - 1].seq;
      };
      this._eventAppendChain = this._eventAppendChain.then(persistEvents, persistEvents);
      await this._eventAppendChain;
    } catch {
      /* 持久化是尽力而为 — 绝不阻塞 agent 循环 */
    }
  }

  /** 在安全边界应用排队的插入（循环顶部，工具结果提交后）。 */
  private _applyPendingInserts(): void {
    if (this._pendingInserts.length === 0) return;
    for (const text of this._pendingInserts) {
      this._appendMessage('user/message', { role: 'user', content: text });
    }
    this._pendingInserts = [];
    // 通知 chat.ts 在新响应开始前完成当前轮次
    this._sink({ kind: EventKind.TurnStarted });
  }

  /** 在安全边界应用排队的记忆更新。
   *  作为临时 system-reminder 注入，使 Agent 在会话中途看到更新的记忆。
   *  不持久化到会话 — Aura 系统独立存储记忆。 */
  private _applyPendingMemoryUpdates(): void {
    if (!this._pendingMemoryUpdates?.length) return;
    const text = this._pendingMemoryUpdates.join('\n');
    this._transientReminders.push(`<system-reminder>${text}</system-reminder>`);
    this._pendingMemoryUpdates = [];
  }

  /** 将未读 inbox 消息注入为 system-reminder。非破坏性 —
   *  消息留在 inbox 直到被显式 ack 或回复。
   *  追踪已注入的消息 ID 以防止同一轮内重复注入
   *  result/reply/bg 在注入时消费（从 inbox 移除）— 不需要回复。
   *  request 注入完整内容但留在 inbox（agent_reply 需要它在）。
   *  free 类型消息获得轻量通知；内容留在 inbox
   *  供 agent_inbox 查找。过期的 free 消息在注入前清除。 */
  private _injectInbox(): void {
    if (!this._bus) return;

    // 1. 清除过期的 free 类型消息
    this._bus.purgeExpired(this.id);

    // 2. 消费 result/reply/bg: 注入完整内容 + 从 inbox 移除
    //    （bg = 后台任务完成通知，owner 路由投递，含 jobId 指针 — 必须完整注入）
    const CONSUME_TYPES = ['result', 'reply', 'bg'];
    const { consumed, remaining } = this._bus.consumeByType(this.id, CONSUME_TYPES);

    // 3. 未消费的消息: 'request' 注入完整内容，其他注入轻量通知。
    //    'request' 留在 inbox 以便 agent_reply 找到并 ack。
    const newRemaining = remaining.filter((m) => !this._injectedMsgIds.has(m.id));
    for (const m of newRemaining) this._injectedMsgIds.add(m.id);

    const newRequests = newRemaining.filter((m) => m.type === 'request');
    const newFreeMsgs = newRemaining.filter((m) => m.type !== 'request');

    // 4. 强类型消息（result/reply/request）持久化到会话 — 它们
    //    从 inbox 消费或需要显式 ack，因此必须作为持久上下文
    //    保留供 Agent 处理。
    const durableParts: string[] = [];
    if (consumed.length > 0) {
      const formatted = consumed
        .map(
          (m) =>
            `[msg_id:${m.id}] from:${m.from} type:${m.type}\n${typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}`,
        )
        .join('\n\n');
      durableParts.push(`📬 消息 (${consumed.length} 条):\n${formatted}`);
    }
    if (newRequests.length > 0) {
      const formatted = newRequests
        .map(
          (m) =>
            `[msg_id:${m.id}] from:${m.from} type:${m.type}\n${typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}`,
        )
        .join('\n\n');
      durableParts.push(`📬 请求 (${newRequests.length} 条，用 agent_reply 回复):\n${formatted}`);
    }
    if (durableParts.length > 0) {
      this._appendMessage('user/message', {
        role: 'user',
        content: `<system-reminder>\n${durableParts.join('\n\n')}\n</system-reminder>`,
      });
    }

    // 5. free 类型消息是临时的（内容留在 inbox 供 agent_inbox 查找）
    if (newFreeMsgs.length > 0) {
      const summary = newFreeMsgs.map((m) => `- from:${m.from} type:${m.type} (msg_id:${m.id})`).join('\n');
      this._transientReminders.push(
        `<system-reminder>\n📬 未读消息 (${newFreeMsgs.length} 条，用 agent_inbox 查看详情):\n${summary}\n</system-reminder>`,
      );
    }

    // 6. 将 _injectedMsgIds 与实际 inbox 同步 — 移除自上次注入以来
    //    已 ack、过期或消费的消息 ID。
    const remainingIds = new Set(remaining.map((m) => m.id));
    for (const id of this._injectedMsgIds) {
      if (!remainingIds.has(id)) this._injectedMsgIds.delete(id);
    }
  }

  /** 将其他 Agent 的新发现注入为 system-reminder。
   *  仅注入本轮尚未见过 + 由其他 Agent 发布 + 5 分钟内的条目。
   *  使用 _injectedDiscoveryIds 防止重复注入。 */
  private _injectDiscoveries(): void {
    if (!this._discoveryBoard) return;
    const entries = this._discoveryBoard.query();
    if (entries.length === 0) return;
    // 仅注入来自其他 Agent、尚未见过、5 分钟内的 discoveries
    const recent = entries.filter(
      (e) => e.agentId !== this.id && !this._injectedDiscoveryIds.has(e.id) && Date.now() - e.ts < 5 * 60 * 1000,
    );
    if (recent.length === 0) return;
    for (const e of recent) this._injectedDiscoveryIds.add(e.id);
    const formatted = recent.map((e) => `[${e.category}] ${e.key}: ${e.value} (by ${e.agentId})`).join('\n');
    // 临时 — discoveries 可通过 agent_lookup 重新查询
    this._transientReminders.push(
      `<system-reminder>\n🔬 共享发现 (${recent.length} 条):\n${formatted}\n\n用 agent_discover 发布你的发现，agent_lookup 查询全部。\n</system-reminder>`,
    );
  }

  /** 开启全新对话 — 保留 system prompt，清除其他所有内容。 */
  newSession(): void {
    const sys = this.session.length > 0 && this.session[0].role === 'system' ? this.session[0] : null;
    this._replaceSession(sys ? [sys] : [], 'new-session');
    // S4-1b reset 语义：reset 开启新逻辑段——重发**当前生效选择**（重读默认
    // 值），不继承被清掉那个会话的改选（设计件 §2.4 三轮复审裁定：
    // 「reset 开启新段」与「首事件描述新段」是同一条纪律的两面）。
    this.selectPreset(currentPresetId());
    // 新会话 → 折叠状态失效
    this._compactSummary = null;
    this._compactTailStart = -1;
    this._execState.bumpVersion();
    this.cacheHitTotal = 0;
    this.cacheMissTotal = 0;
    this.lastUsage = undefined;
    this.stormSig = '';
    this.stormCount = 0;
    this.compactStuck = false;
    this.compactRetryAfterLen = 0;
    this.compactFailCount = 0;
    this.compactionTracker.reset();
    this._transientReminders = [];
    this._sink({ kind: EventKind.Notice, level: 'info', text: '已开启新会话' });
  }

  /** 从父会话提取最近的工具结果作为 fork 的上下文。
   *  去除 system prompt、assistant tool_calls，截取最近 N 条消息。
   *  每条消息截断到 1000 字符以保持 fork system prompt 精简。 */
  extractRecentContext(maxMessages: number): string {
    const recent = this.session
      .filter((m) => m.role !== 'system') // 不泄漏父 Agent 的 system prompt
      .slice(-maxMessages);
    if (recent.length === 0) return '(无父Agent上下文)';
    return recent
      .map((m) => {
        const roleLabel =
          m.role === 'assistant' ? '主Agent' : m.role === 'tool' ? `工具结果(${m.name || '?'})` : '用户';
        const MAX = 1000;
        const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const content = raw.length > MAX ? raw.slice(0, MAX) + '…[截断]' : raw;
        return `[${roleLabel}] ${content}`;
      })
      .join('\n\n');
  }

  /** 运行一轮: 追加用户输入，驱动工具循环。
   *  空输入（bus 唤醒）跳过 preRunHook 和用户消息 — runLoop
   *  从 _injectInbox() 开始，将 inbox 消息作为唯一输入。 */
  async run(signal: AbortSignal, input: string): Promise<void> {
    this._isRunning = true;
    this._ui.onStatusChange?.(true);
    if (this._preRunHook && input) {
      try {
        const recallCtx = await this._preRunHook(input);
        if (recallCtx) {
          this._transientReminders.push(`<system-reminder>\n${recallCtx}\n</system-reminder>`);
        }
      } catch {
        /* pre-run hook 失败非致命 */
      }
    }
    if (input) {
      this._appendMessage('user/message', { role: 'user', content: input });
      // 用户发新消息 → 重置 plan 提醒计数（下一轮注入全量提醒）
      this._planInjector?.resetOnUserInput();
    }
    try {
      await this.runLoop(signal);
      // 触发 onSessionPersisted 回调（记忆 bundle 摄取、git 刷新、turn-start 块）
      if (this._onSessionPersisted) {
        try {
          this._onSessionPersisted(this.sessionId, this.session);
        } catch {
          /* 尽力而为 */
        }
      }
    } finally {
      // 异常/中止路径也必须落盘 — runLoop 中途注入的 inbox 消息（result/bg）
      // 此刻只存在于内存 session；saveState 若被 throw 跳过，崩溃时静默丢失。
      // 旧实现 saveState 在 await runLoop 之后，throw 路径直接绕过。
      this.saveState('running').catch(() => {});
    }
  }

  // ══════════════════════════════════════════════════════
  // Goal 循环 — 自主多轮执行（实现已迁 goal-loop.ts，宿主接口委托）
  // ══════════════════════════════════════════════════════

  /** 自主运行目标: 规划 → 执行 → 验证 → 循环直到 goal_report。
   *  委托 goal-loop.ts（11c 拆分）；语义见 runGoalImpl 文档。 */
  async runGoal(signal: AbortSignal, goal: string): Promise<GoalRunResult> {
    return runGoalImpl(this as unknown as GoalLoopHost, signal, goal);
  }

  /** 恢复活跃目标（暂停/受阻的，或崩溃遗留的活跃记录）。返回类型与 runGoal 相同。 */
  async resumeGoal(signal: AbortSignal, id?: string): Promise<GoalRunResult> {
    return resumeGoalImpl(this as unknown as GoalLoopHost, signal, id);
  }

  /** 驱动工具循环而不添加用户消息。用于 fork 子 Agent
   *  其会话已以 fork 指令结尾的情况。 */
  private async runLoop(signal: AbortSignal): Promise<void> {
    const turnStart = performance.now();
    log.info('agent', 'turn started', { model: this.prov.name() });

    try {
      this._isRunning = true;
      this._currentRunSignal = signal; // 子 Agent 派生时合并此 signal 用于级联中止
      this._sink({ kind: EventKind.TurnStarted });
      // Phase 5：轮次边界事件（无消息投影 — 回放/审计用）
      this._sessionLog.append('turn/start', { model: this.prov.name() });

      for (let step = 0; ; step++) {
        // 清除上一步的临时提醒 — 仅当前步骤的
        // 提醒应对本轮 LLM 可见。
        // Step 0 跳过清除: run() 可能已将 preRunHook
        // （aura recall）结果推入 _transientReminders 后才调用 runLoop。
        if (step > 0) this._transientReminders = [];

        // Plan 模式提醒注入 — 去重逻辑在 PlanModeInjector 内部
        if (this._planState && this._planInjector) {
          let planContent = '';
          if (this._planState.state.active && this._planState.state.planFilePath) {
            try {
              const raw = await typedRpc('read_file_content', {
                file_path: this._planState.state.planFilePath,
                is_agent: false,
              });
              planContent = raw.replace(/^\s*\d+\t/gm, '');
            } catch {
              /* plan 文件尚未写入 — 正常 */
            }
          }
          const reminder = this._planInjector.getReminder(step, this._planState.state, planContent);
          if (reminder) {
            this._transientReminders.push(`<system-reminder>\n${reminder}\n</system-reminder>`);
          }
        }

        // 中止检查 — signal 覆盖用户停止 + 会话替换（通过 this._execState.stop）
        if (signal.aborted) throw new Error('aborted');

        // 在安全边界应用待插入的用户消息（工具结果提交后）
        this._applyPendingInserts();
        this._applyPendingMemoryUpdates();

        this._ui.progress?.(step + 1, 'thinking');

        // 在每次 stream() 调用前排空后台任务通知（临时 —
        // 轮次结束后进度更新无价值）。按 agent_id 路由排干：全局排干会把
        // 其他 agent（含并行子 Agent）的后台任务通知吸进本 agent 上下文。
        try {
          const notes = await typedRpc('drain_bg_notifications', { agent_id: this.id });
          if (notes) {
            this._transientReminders.push(`<system-reminder>\n${notes}\n</system-reminder>`);
          }
        } catch {
          // 尽力而为 — 排空失败不阻塞循环
        }

        // 注入未读 inbox 消息（窥探 — 不消费）
        this._injectInbox();

        // 注入其他 Agent 的新发现
        this._injectDiscoveries();

        // ── 预检上下文窗口 ──
        // 在发送到 API 前检查 — 捕获上轮结束时（maybeCompact() 在 0.55 触发）
        // 与危险区（0.88）之间的间隙。估算基于发送载荷（折叠视图），
        // 与真实 API 压力一致。没有这个检查，大量工具结果 + 注入
        // 会在下一轮导致 400 错误。
        if (this.contextWindow > 0) {
          const preFlight = this.tokenCountWithEstimation();
          const preFlightRatio = preFlight / this.contextWindow;
          if (preFlightRatio >= 0.88) {
            if (this.compactStuck) {
              log.warn('agent', 'pre-flight skipped: compact stuck', {
                estimated: preFlight,
                ratio: preFlightRatio.toFixed(2),
              });
              this._sink({
                kind: EventKind.Notice,
                level: 'warn',
                text: `上下文使用率 ${(preFlightRatio * 100).toFixed(0)}%，但压缩已卡住。建议 /new。`,
              });
            } else if (this.compactRunning) {
              log.info('agent', 'pre-flight skipped: compact already running', {
                estimated: preFlight,
                ratio: preFlightRatio.toFixed(2),
              });
            } else {
              log.info('agent', 'pre-flight compaction triggered', {
                estimated: preFlight,
                ratio: preFlightRatio.toFixed(2),
                contextWindow: this.contextWindow,
              });
              this._sink({
                kind: EventKind.Notice,
                level: 'warn',
                text: `上下文使用率 ${(preFlightRatio * 100).toFixed(0)}%，发送前压缩…`,
              });
              try {
                const outcome = await this.compactNow(signal);
                if (outcome === 'stuck') {
                  this._sink({
                    kind: EventKind.Notice,
                    level: 'warn',
                    text: '压缩无法减少上下文——消息太少。建议 /new。',
                  });
                }
              } catch {
                // compactNow 已发出自身错误 — 继续让 API 错误处理器
                // （stream 中的响应式压缩）捕获
                log.warn('agent', 'pre-flight compaction failed, falling through to API call');
              }
            }
          }
        }

        // ---- Stream（带流式工具执行器 + hooks）----
        this.compactionTracker.recordTurn();
        const executor = new StreamingToolExecutor(
          this.tools,
          (ev: AgentEvent) => this._sink(ev),
          this.hooks,
          this.preflightHooks,
          this._isolationId ?? null,
          signal,
          this._planGate,
          null,
          // 通知路由身份（bus id）— bg job owner / bash_kill 所有权（executor 注入 _owner_id）
          this.id,
        );
        let { text, reasoning, signature, calls, usage, err } = await this.stream(signal, step + 1, executor);
        if (err) {
          log.error('agent', 'stream error', { error: String(err.message || err) });
          throw err;
        }

        if (usage && usage.total_tokens > 0) {
          log.info('agent', 'llm response', {
            turn: step + 1,
            model: this.prov.name(),
            finish_reason: usage.finish_reason,
            total_tokens: usage.total_tokens,
            prompt_tokens: usage.prompt_tokens,
            cache_hit_tokens: usage.cache_hit_tokens,
            cache_miss_tokens: usage.cache_miss_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            completion_tokens: usage.completion_tokens,
            reasoning_tokens: usage.reasoning_tokens,
            elapsed_ms: Math.round(performance.now() - turnStart),
          });
          this._diagTokenBreakdown(usage);
          this.cacheHitTotal += usage.cache_hit_tokens;
          this.cacheMissTotal += usage.cache_miss_tokens;
          this.lastUsage = usage;
          this._sink({
            kind: EventKind.Usage,
            usage,
            pricing: this.pricing,
            session_hit: this.cacheHitTotal,
            session_miss: this.cacheMissTotal,
          });
        }

        // 异常完成原因告警
        const warnMsg = finishReasonMessage(usage);
        if (warnMsg) {
          this._sink({ kind: EventKind.Notice, level: 'warn', text: warnMsg });
        }

        // 保护: DeepSeek 拒绝既无 content 也无 tool_calls 的 assistant 消息。
        if (!text && calls.length === 0) {
          if (this._pendingInserts.length > 0 || reasoning) {
            text = reasoning ? '(思考完成)' : '(等待中)';
          } else {
            log.warn('agent', 'empty assistant turn — skipping push to avoid API 400');
            this._sink({
              kind: EventKind.Notice,
              level: 'warn',
              text: 'Provider 本次调用了但无内容返回，已跳过此轮。',
            });
            return;
          }
        }

        // 存储 assistant 轮次（reasoning 保留用于显示，不重新上传）
        this._appendMessage('assistant/text', {
          role: 'assistant',
          content: text,
          reasoning_content: reasoning,
          reasoning_signature: signature,
          tool_calls: calls,
        });
        // 工具调用审计事件（每调用一条；消息投影取自上方事件内嵌的 tool_calls — 单一事实源）
        for (const call of calls) {
          this._sessionLog.append('tool/call', { call });
        }

        if (calls.length === 0 && this._pendingInserts.length === 0) {
          return;
        }

        // ---- 收集工具结果（流式执行器在 stream 期间已执行）----
        log.info('agent', 'collect streaming results', {
          tools: calls.map((c) => c.name),
          count: calls.length,
        });
        const pendingResults = await executor.awaitRemaining();
        // 按调用顺序构建结果
        const resultsByCallId = new Map(pendingResults.map((r) => [r.call.id, r]));

        // ── Storm breaker + 压缩埋点 ──
        // 两个调用点在 6e75046（StreamingToolExecutor 清理前）丢失；
        // 在此重新接线。Storm breaker 将模型从相同失败的循环中推开；
        // tracker 用真实损失数据喂给压缩自动调优。
        const stormNudge = this._stormNudge(calls, resultsByCallId);
        for (const call of calls) {
          // 领域调用（fs/shell/...）解析回旧语义名 — 压缩追踪按旧名统计
          let guardName: string;
          try {
            guardName = resolveGuardToolName(this.tools, call.name, JSON.parse(call.arguments || '{}'));
          } catch {
            guardName = call.name;
          }
          this.compactionTracker.recordToolCall(guardName, call.arguments || '{}');
          if (guardName === 'read_file_content' || guardName === 'read_file') {
            const fp = parseFilePathArg(call.arguments);
            if (fp) this.compactionTracker.recordFileRead(fp);
          }
        }

        for (let i = 0; i < calls.length; i++) {
          const call = calls[i];
          const r = resultsByCallId.get(call.id);
          // r 存在但 output 为空 = 工具执行成功但无输出(如 git add 成功、git diff 无差异)。
          // 空字符串是 falsy,若用 `r?.output || error` 会把成功误判成"工具没结果",
          // 导致 Agent 看到 "did not produce a result" 而困惑/重试。
          // 仅当 r 不存在(流式重试丢失、未分发)才算真正失败。
          let content = r
            ? r.output || `(工具 ${call.name} 执行成功，无输出)`
            : `error: tool "${call.name}" did not produce a result`;
          if (!r) {
            // 补发 ToolResult 终止 UI 卡片（执行器 abort 已覆盖主流路径，
            // 此处兜底任何残留缺口，防止卡片永久"执行中"——会话 223 事故）。
            this._sink({
              kind: EventKind.ToolResult,
              tool: {
                id: call.id,
                name: call.name,
                args: call.arguments,
                output: content,
                err: 'did not produce a result',
                read_only: this.toolReadOnly(call.name),
              },
            });
          }
          if (stormNudge && i === 0) content += stormNudge;
          this._appendMessage('tool/result', {
            role: 'tool',
            content,
            tool_call_id: call.id,
            name: call.name,
          });
          // 通知面板自动刷新（workspace 注入的端口）
          this._ui.toolDone?.(
            call.name,
            (() => {
              try {
                return JSON.parse(call.arguments || '{}');
              } catch {
                return {};
              }
            })(),
            r?.output || '',
          );
        }

        // 下一轮前按需压缩
        this.maybeCompact(usage);
      }
    } finally {
      this._isRunning = false;
      this._ui.onStatusChange?.(false);
      // 重新检查新（尚未注入的）消息 — 避免本轮已注入但未 ack 的消息
      // 导致无限循环。
      if (!signal.aborted && this._bus) {
        const hasNew = this._bus.peekInbox(this.id).some((m) => !this._injectedMsgIds.has(m.id));
        if (hasNew) {
          queueMicrotask(() => {
            void this._onMessageDelivered();
          });
        }
      }
    }
  }

  // ---- 私有: stream（带重试）----

  private async stream(
    signal: AbortSignal,
    turn: number,
    executor?: StreamingToolExecutor,
  ): Promise<{
    text: string;
    reasoning: string;
    signature: string;
    calls: ToolCall[];
    usage: Usage | undefined;
    err: Error | undefined;
  }> {
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal.aborted) {
        executor?.discard();
        return { text: '', reasoning: '', signature: '', calls: [], usage: undefined, err: new Error('aborted') };
      }

      const result = await this.streamOnce(signal, turn, executor);

      // 成功 — 无错误，或错误已由 streamOnce 作为通知发出
      if (!result.err) return result;

      lastErr = result.err;

      // 响应式压缩: 如果错误是 "prompt too long"，压缩并重试，
      // 无论错误是否通常可重试。
      // 根治: 只有载荷确实接近窗口（>60%）时才响应式压缩 —
      // 错误文本匹配会误判（"400"+"token" 字样即可命中），
      // 低水位下不引发任何动作；也不再自动调低 contextWindow
      // （单次错误不能证明窗口大小，永久砍小会让压缩在荒谬
      // 的阈值反复触发，日志 2026-07-28 已实锤该恶性循环）。
      const errAt = this.tokenCountWithEstimation();
      if (
        this.isContextLengthError(lastErr) &&
        !this.compactStuck &&
        !this.compactRunning &&
        this.session.length >= this.compactRetryAfterLen &&
        errAt > this.contextWindow * 0.6
      ) {
        log.info('agent', 'reactive compact triggered by context-length error', {
          estimated: errAt,
          ratio: (errAt / this.contextWindow).toFixed(2),
        });
        this._sink({ kind: EventKind.Notice, level: 'warn', text: '上下文过长，自动压缩后重试…' });
        try {
          await this.compactNow(signal);
          // compactNow 更新折叠状态（载荷变小）— 跳过退避，立即重试
          continue;
        } catch {
          // compactNow 失败 — 转入正常重试/中止逻辑
          this._sink({ kind: EventKind.Notice, level: 'warn', text: '自动压缩失败，尝试直接重试…' });
        }
      }

      // 不可重试的错误不重试
      if (!isRetryable(lastErr)) return result;

      // 最后一次尝试 — 放弃
      if (attempt >= MAX_RETRIES) break;

      // 丢弃失败尝试的所有工具调用
      executor?.discard();

      // 重试前退避
      const delay = backoffDelay(attempt);
      log.info('agent', `stream retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`, {
        error: String(lastErr.message || lastErr),
      });
      this._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `模型调用失败，${(delay / 1000).toFixed(1)}s 后重试 (${attempt + 1}/${MAX_RETRIES})…`,
      });

      const aborted = await sleepWithAbort(delay, signal);
      if (aborted) {
        return { text: '', reasoning: '', signature: '', calls: [], usage: undefined, err: new Error('aborted') };
      }
    }

    // 重试已耗尽
    this._sink({
      kind: EventKind.Notice,
      level: 'error',
      text: `模型调用失败，已重试 ${MAX_RETRIES} 次：${lastErr?.message || '未知错误'}。请检查网络连接和 API 设置。`,
    });
    return { text: '', reasoning: '', signature: '', calls: [], usage: undefined, err: lastErr };
  }

  /** 单次流式尝试 — 无重试逻辑。
   *  当提供 executor 时，工具调用立即添加到其中
   *  （在流式过程中开始执行，而非之后）。 */
  private async streamOnce(
    signal: AbortSignal,
    _turn: number,
    executor?: StreamingToolExecutor,
  ): Promise<{
    text: string;
    reasoning: string;
    signature: string;
    calls: ToolCall[];
    usage: Usage | undefined;
    err: Error | undefined;
  }> {
    // 将临时提醒作为 user 消息追加到末尾 — 它们
    // 本轮对 LLM 可见但不持久化到 this.session。
    // 载荷 = 完整历史的折叠视图（若已压缩）+ 临时提醒。
    const transientMsgs: Message[] = this._transientReminders.map((content) => ({
      role: 'user' as const,
      content,
    }));
    const payload = this.payloadMessages();
    const fullSession = transientMsgs.length > 0 ? [...payload, ...transientMsgs] : payload;

    // 流空闲超时：30s 无任何 chunk 视为挂起（与 callSummaryLLM / dataflow NL 解析
    // 共用 streamWithIdleTimeout）。超时 abort 后 sendWithRetry/readSSE 抛 aborted，
    // 此处转为可读的挂起提示（[响应超时] 会在 stream() 重试循环里按瞬态重试）。
    // 外部 signal 只做转发，不直接传给 stream——避免超时 abort 连累调用方。
    // sanitizeToolPairing 不在此调用 — provider（openai/anthropic）是上线前的最终 gate。
    const stream = streamWithIdleTimeout(this.prov, signal, {
      messages: fullSession,
      tools: this.requestToolSchemas(),
      temperature: this.temperature,
      // max_tokens 不开放设置 — 0 = provider 默认 32000，发送前按模型目录上限钳制
      max_tokens: 0,
    });

    let text = '';
    let reasoning = '';
    let signature = '';
    const calls: ToolCall[] = [];
    let usage: Usage | undefined;
    let err: Error | undefined;

    try {
      for await (const chunk of stream.chunks) {
        switch (chunk.type) {
          case ChunkType.Reasoning:
            reasoning += chunk.text || '';
            if (chunk.signature) signature = chunk.signature;
            if (chunk.text) {
              this._sink({ kind: EventKind.Reasoning, text: chunk.text });
            }
            break;

          case ChunkType.Text:
            text += chunk.text || '';
            this._sink({ kind: EventKind.Text, text: chunk.text });
            break;

          case ChunkType.ToolCallStart:
            if (chunk.tool_call) {
              this._sink({
                kind: EventKind.ToolDispatch,
                tool: {
                  id: chunk.tool_call.id,
                  name: chunk.tool_call.name,
                  args: '',
                  read_only: this.toolReadOnly(chunk.tool_call.name),
                  partial: true,
                },
              });
            }
            break;

          case ChunkType.ToolArgPreview:
            if (chunk.tool_arg_preview) {
              this._sink({
                kind: EventKind.ToolProgress,
                tool: {
                  id: chunk.tool_arg_preview.tool_id,
                  name: chunk.tool_arg_preview.tool_name,
                  output: chunk.tool_arg_preview.content,
                  read_only: true,
                },
              });
            }
            break;

          case ChunkType.ToolCall:
            if (chunk.tool_call) {
              calls.push(chunk.tool_call);
              // 流式执行: 立即启动工具，不等流结束
              executor?.addTool(chunk.tool_call);
            }
            break;

          case ChunkType.Usage:
            usage = chunk.usage;
            break;

          case ChunkType.Error:
            err = chunk.err;
            // 落入 Done 以停止迭代
            break;

          case ChunkType.Done:
            break;
        }

        if (err) break;
      }
    } catch (e) {
      if (stream.idleTimedOut) {
        err = new Error(`[响应超时] 模型响应超时（${STREAM_IDLE_TIMEOUT_MS / 1000} 秒无输出），已自动中止`);
      } else {
        err = e instanceof Error ? e : new Error(String(e));
      }
    }

    if (err) {
      this._sink({ kind: EventKind.Notice, level: 'error', text: `模型调用失败: ${err.message || err}` });
      return { text: '', reasoning: '', signature: '', calls: [], usage, err };
    }

    // 关闭文本流
    if (text || reasoning) {
      this._sink({ kind: EventKind.Message, text, reasoning });
    }

    return { text, reasoning, signature, calls, usage, err: undefined };
  }

  // ---- Storm breaker — 打断重复工具调用循环 ----

  /** 检测重复相同的工具调用失败。返回追加到第一个工具结果的提示字符串，
   *  或 null。Storm 状态（stormSig/stormCount）在压缩/newSession 时重置；
   *  一批调用中任何成功调用也会重置。 */
  private _stormNudge(
    calls: ToolCall[],
    resultsByCallId: Map<string, { output: string; err?: string }>,
  ): string | null {
    const outcomes: ToolOutcome[] = calls.map((c) => {
      const r = resultsByCallId.get(c.id);
      const output = r?.output ?? '';
      return {
        output,
        errMsg: r?.err,
        blocked: output.includes('架构门禁已阻止'),
        truncated: false,
      };
    });
    const { sig, ok } = batchStormSignature(calls, outcomes);
    if (!ok) {
      this.stormSig = '';
      this.stormCount = 0;
      return null;
    }
    if (sig !== this.stormSig) {
      this.stormSig = sig;
      this.stormCount = 1;
      return null;
    }
    this.stormCount++;
    if (this.stormCount < STORM_BREAK_THRESHOLD) return null;

    const subject = calls.length === 1 ? `"${calls[0].name}"` : `this batch of ${calls.length} tool calls`;
    const short = calls.length === 1 ? calls[0].name : `a batch of ${calls.length} calls`;

    this._sink({
      kind: EventKind.Notice,
      level: 'warn',
      text: `loop guard: ${short} failed ${this.stormCount}× the same way — nudging the model to change approach`,
    });

    return `\n\n[loop guard] ${subject} has now failed ${this.stormCount} times in a row with the same error. Re-sending it will not help. Change approach: if an argument is being truncated, write less in one call and split the work; otherwise fix the arguments, use a different tool, or explain the blocker in your final answer.`;
  }

  // ---- 上下文窗口管理 ----

  compactRunning = false;
  // ⚡ sessionGen migrated to ExecutionState.sessionVersion

  /** 使用 cl100k_base tokenizer 精确计算 token 数。
   *  替代旧的 chars/2.5 启发式（误差 30-60%）。
   *  Cl100k_base 匹配 GPT-4、DeepSeek 和大多数 OpenAI 兼容模型。
   *  Anthropic 的 tokenizer 略有差异（< 8% 误差），对压缩安全。
   *  按发送载荷（payloadMessages 折叠视图）计数 — 触发判定必须
   *  与真实 API 压力一致，而非完整历史大小。 */
  /** 每轮发给模型的工具 schema：默认全量（limit=0），保持 tools 段逐字节稳定，
   *  DeepSeek 前缀缓存才能跨用户消息命中；limit>0 时按上下文打分注入子集
   *  （见 tool-select.ts）。打分子集的稳定性契约：只由 user 消息驱动、带锁存——
   *  同一用户请求的整个工具循环内逐字节一致，但跨请求仍会漂移击穿缓存。 */
  private _schemaSelector: StableSchemaSelector = createStableSchemaSelector();

  private requestToolSchemas(): ToolSchema[] {
    return this._schemaSelector.select(this.tools, this._visibleToolsLimit, userContext(this.session));
  }

  private tokenCountWithEstimation(): number {
    let total = countMessages(this.payloadMessages());
    // 计算临时提醒 token — 发送给 LLM 但不在会话中
    total += countTexts(this._transientReminders);
    // 计算工具 schema token — 每次请求都发送
    total += countToolSchemas(this.requestToolSchemas());
    return total;
  }

  /** 诊断: 按组件分解 token 消耗。
   *  每轮后以结构化 NDJSON 记录到 .lantai/logs/ui.log。
   *  过滤: jq 'select(.module=="agent" and .message=="token breakdown") | .ctx' */
  private _diagTokenBreakdown(apiUsage: Usage | undefined): void {
    try {
      const T = this.requestToolSchemas();
      const schemaTokens = countToolSchemas(T);
      // 统计发送载荷（折叠视图）而非完整历史 — 反映真实 API 成本
      const payload = this.payloadMessages();

      let sysTokens = 0,
        userTokens = 0,
        reminderTokens = 0,
        assistantTokens = 0,
        toolTokens = 0;
      let reminderCount = 0,
        inboxInjCount = 0;
      let sysMsgCount = 0,
        userMsgCount = 0,
        assistantMsgCount = 0,
        toolMsgCount = 0;

      for (const m of payload) {
        const tok = countMessage(m);
        if (m.role === 'system') {
          sysTokens += tok;
          sysMsgCount++;
        } else if (m.role === 'user') {
          if (typeof m.content === 'string' && m.content.includes('<system-reminder>')) {
            reminderTokens += tok;
            reminderCount++;
            if (m.content.includes('📬')) inboxInjCount++;
          } else {
            userTokens += tok;
            userMsgCount++;
          }
        } else if (m.role === 'assistant') {
          assistantTokens += tok;
          assistantMsgCount++;
        } else if (m.role === 'tool') {
          toolTokens += tok;
          toolMsgCount++;
        }
      }

      const transientTokens = countTexts(this._transientReminders);
      const estimatedTotal =
        sysTokens + userTokens + reminderTokens + transientTokens + assistantTokens + toolTokens + schemaTokens;

      const diag = {
        turn_session_msgs: payload.length,
        history_msgs: this.session.length,
        // ── 成本中心 ──
        system_prompt: { tokens: sysTokens, msgs: sysMsgCount },
        user_real: { tokens: userTokens, msgs: userMsgCount },
        reminders: { tokens: reminderTokens, msgs: reminderCount, inbox: inboxInjCount },
        transient_reminders: { tokens: transientTokens, msgs: this._transientReminders.length },
        assistant: { tokens: assistantTokens, msgs: assistantMsgCount },
        tool_results: { tokens: toolTokens, msgs: toolMsgCount },
        tool_schemas: { tokens: schemaTokens, count: T.length },
        folded_tool_results: Math.min(this._toolFoldBoundary, toolMsgCount),
        // ── 汇总 ──
        estimated_total: estimatedTotal,
        api_reported: apiUsage
          ? { prompt: apiUsage.prompt_tokens, completion: apiUsage.completion_tokens, total: apiUsage.total_tokens }
          : null,
        cache: apiUsage ? { hit: apiUsage.cache_hit_tokens, miss: apiUsage.cache_miss_tokens } : null,
      };

      log.info('agent', 'token breakdown', diag);
    } catch {
      /* 诊断绝不抛异常 */
    }
  }

  /** 检查错误是否为上下文长度超限。 */
  private isContextLengthError(err: Error): boolean {
    const msg = (err.message || String(err)).toLowerCase();
    // 完成预算错误（"Invalid max_tokens value…"）是请求参数 bug，
    // 不是 prompt 溢出 — 压缩 prompt 无法修复它们，
    // 误分类会导致每次输入都陷入 compact→retry→400 循环。
    if (msg.includes('max_tokens') || msg.includes('max_output_tokens')) return false;
    return (
      msg.includes('prompt is too long') ||
      msg.includes('context length') ||
      msg.includes('too many tokens') ||
      msg.includes('maximum context') ||
      msg.includes('reduce the length') ||
      msg.includes('token limit') ||
      (msg.includes('400') && (msg.includes('token') || msg.includes('context') || msg.includes('prompt')))
    );
  }

  // ── 折叠视图 + 压缩状态机（实现已迁 agent-compaction.ts，宿主接口委托）──

  /** session 头部偏移: 若第一条是 system prompt 则为 1，否则为 0。 */
  _foldHead(): number {
    return foldHead(this as unknown as CompactionHost);
  }

  /** 发送给 LLM 的载荷 — 完整历史 + 压缩折叠 + 工具结果滚动折叠。 */
  payloadMessages(): Message[] {
    return payloadMessagesImpl(this as unknown as CompactionHost);
  }

  /** 计算本次要折叠的中间区域。返回 null = 无可折叠内容（stuck）。 */
  computeCompactRegion(): { region: Message[]; tailStart: number; priorSummary: string | null } | null {
    return computeCompactRegionImpl(this as unknown as CompactionHost);
  }

  /** 手动压缩触发器（来自 /compact 命令）。返回摘要文本或错误。 */
  async compactNow(signal: AbortSignal): Promise<string> {
    return compactNowImpl(this as unknown as CompactionHost, signal);
  }

  maybeCompact(usage: Usage | undefined): void {
    maybeCompactImpl(this as unknown as CompactionHost, usage);
  }

  /** 对消息区域生成摘要 — map-reduce 分块管线（测试经 as any 调用）。 */
  async summarizeRegion(
    signal: AbortSignal,
    msgs: Message[],
    priorSummary: string | null = null,
  ): Promise<{ text: string; degraded: boolean }> {
    return summarizeRegionImpl(this as unknown as CompactionHost, signal, msgs, priorSummary);
  }

  /** 缓存的摘要模型选择。 */
  async summaryProvider(): Promise<{ prov: Provider; window: number }> {
    return summaryProviderImpl(this as unknown as CompactionHost);
  }

  /** 运行时自动选择摘要模型（B1 修复回归测试经 as any 调用）。 */
  async selectSummaryProvider(): Promise<{ prov: Provider; window: number }> {
    return selectSummaryProviderImpl(this as unknown as CompactionHost);
  }

  /** 单次摘要 LLM 调用 — 空闲超时守卫。 */
  async callSummaryLLM(signal: AbortSignal, systemPrompt: string, userText: string): Promise<string> {
    return callSummaryLLMImpl(this as unknown as CompactionHost, signal, systemPrompt, userText);
  }

  /** 滚动合并分段摘要（含 priorSummary）。 */
  async mergePartials(
    signal: AbortSignal,
    priorSummary: string | null,
    partials: string[],
    budgetTokens: number,
  ): Promise<{ text: string; degraded: boolean }> {
    return mergePartialsImpl(this as unknown as CompactionHost, signal, priorSummary, partials, budgetTokens);
  }

  private toolReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly() ?? false;
  }

  // ══════════════════════════════════════════════════════
  // 子 Agent 派生 — 用于并行/委派工作
  // ══════════════════════════════════════════════════════

  /** 派生子 Agent 处理聚焦任务。阻塞直到子 Agent 完成；
   *  子 Agent 的最终报告（加合并备注）成为工具结果。
   *  委托 subagent-spawn.ts（11c 拆分）；完整语义见 spawnSubAgentImpl 文档。 */
  async spawnSubAgent(
    description: string,
    prompt: string,
    onProgress?: (chunk: string) => void,
    mode: 'fork' | 'fresh' = 'fork',
    toolAllowlist?: string[] | null,
    poolSignal?: AbortSignal,
    asyncMode?: boolean,
    agentIdOverride?: string,
    outputSchema?: Record<string, unknown> | null,
  ): Promise<{ text: string; err?: string }> {
    return spawnSubAgentImpl(
      this as unknown as SubAgentSpawnHost,
      description,
      prompt,
      onProgress,
      mode,
      toolAllowlist,
      poolSignal,
      asyncMode,
      agentIdOverride,
      outputSchema,
    );
  }
}

// 隔离合并/丢弃的序列化在 isolation-queue.ts 中
// （与 merge.ts 共享 — 并发 git 操作会争抢 index lock）。
