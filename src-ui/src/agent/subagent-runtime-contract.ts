// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子代理运行时**契约面**（批 7c-1，2026-09-24）：运行时实现（池 / 生命周期 / 派生 / merge 与
// discovery 工具族）归产物包 `plugins/builtin/subagent-in-process/`，契约住内核——
// 内核（blueprint 的 capability / workspace 与 runtime 的构造点 / subagent-spawn 的调用面）
// 引用本件即可，不反向依赖产物包。

import type { Provider } from '../provider/types';
import type { AgentStore } from './agent-store';
import type { AgentUINotifier, EventSink } from './agent-types';
import type { AgentContext } from './context';
import type { DiscoveryBoard } from './discovery-board';
import type { FileOwnership } from './file-ownership';
import type { Disposer } from './lifecycle';
import type { MessageBus } from './message-contract';
import type { PlanStateManager } from './plan/plan-state';
import type { BoardEntry, TaskBoardFace } from './task-contract';
import type { Tool, ToolExecutor, ToolRegistry } from './tool';

/** merge 工具族实现面（含编译门禁）。 */
export interface MergeToolsImplementation {
  createMergeTool(
    board: TaskBoardFace,
    getAgentId: () => string,
    exec?: ToolExecutor,
    options?: { projectPath: string },
  ): Tool;
  runCompileTest(
    entry: BoardEntry,
    options: { projectPath: string; compileCommand?: string; compileTimeoutMs?: number },
    exec?: ToolExecutor,
  ): Promise<MergeGateResult>;
}

/** 编译门禁结果（结构对齐包内 `GateResult`——内核只做结构约束，不 import 产物类型）。 */
export interface MergeGateResult {
  passed: boolean;
  quiet: boolean;
  report: string;
}

/** discovery 工具族实现面（agent_discover / agent_lookup）。 */
export interface DiscoveryToolsImplementation {
  createDiscoveryTools(board: DiscoveryBoard, getAgentId: () => string): Tool[];
}

// ── 运行时形状（批 7c-2 上收：池 / 生命周期 / 派生宿主）──

export enum SubAgentStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Stopped = 'stopped',
}

export type SubAgentRunFn = (signal: AbortSignal) => Promise<{ text: string; err?: string }>;

export interface SubAgentHandle {
  id: string;
  description: string;
  status: SubAgentStatus;
  startedAt: number;
  result?: string;
  error?: string;
}

export interface SpawnedAgent {
  id: string;
  signal: AbortSignal;
  done: Promise<SubAgentHandle>;
}

/** 子 Agent 池公开面（成员与实现类逐字对齐；内核消费方只依赖本接口）。 */
export interface SubAgentPool {
  /** 任意子 Agent 完成时的可选回调（board 归档等；由 runtime 接线）。 */
  onFinish?: (agentId: string, status: SubAgentStatus) => void;
  spawn(description: string, runFn: SubAgentRunFn, callId?: string, timeoutMs?: number): SpawnedAgent | null;
  isQueued(id: string): boolean;
  registerAlias(aliasId: string, internalId: string): void;
  getHandle(id: string): SubAgentHandle | undefined;
  listRunning(): SubAgentHandle[];
  stop(id: string): boolean;
  stopAll(): string[];
  ownedDisposer(): Disposer;
  summary(): string;
  readonly runningCount: number;
}

/** 生命周期巡检器公开面（全局空闲判定 + 泄漏检测 + worktree TTL）。 */
export interface AgentLifecycleManager {
  isIdle(): boolean;
  start(): void;
  stop(): void;
  startOwned(): Disposer;
}

/** 子 Agent 派生对宿主 Agent 的最小状态面（成员与 Agent 类声明逐字对齐）。 */
export interface SubAgentSpawnHost {
  readonly id: string;
  readonly prov: Provider;
  readonly tools: ToolRegistry;
  readonly contextWindow: number;
  readonly _subagentDepth: number;
  readonly _ctx: AgentContext;
  readonly _planState: PlanStateManager | null;
  readonly _discoveryBoard: DiscoveryBoard | null;
  readonly _taskBoard: TaskBoardFace | null;
  readonly _bus: MessageBus | null;
  readonly _ui: AgentUINotifier;
  readonly _uiSessionId: number;
  readonly agentStore: AgentStore | null;
  _currentRunSignal: AbortSignal | null;
  _fileOwnership: FileOwnership | null;
  /** 附图字节读取器（B3 multimodal-image-plan）——子 Agent 继承父读取器。 */
  _imageReader: import('./request-images').RequestImageReader | null;
  extractRecentContext(maxMessages: number): string;
  /** 父 preflight 注册表（null = 主 Agent 未接线）— 子 Agent 门禁继承用。 */
  getPreflightHooks(): import('./hooks').PreflightHookRegistry | null;
}

/** 运行时实现面（池 / 生命周期 / 派生 + merge / discovery 两工具族）。 */
export interface SubagentRuntimeImplementation {
  createPool(maxConcurrent?: number, defaultTimeoutMs?: number): SubAgentPool;
  createLifecycleManager(
    pool: SubAgentPool,
    board: TaskBoardFace,
    bus: MessageBus,
    exec: ToolExecutor,
    sink: EventSink,
  ): AgentLifecycleManager;
  spawnSubAgent: SpawnSubAgentFn;
  mergeTools: MergeToolsImplementation;
  discoveryTools: DiscoveryToolsImplementation;
}

/** 子 Agent 派生入口（与实现签名逐字对齐）。 */
export type SpawnSubAgentFn = (
  host: SubAgentSpawnHost,
  description: string,
  prompt: string,
  onProgress?: (chunk: string) => void,
  mode?: 'fork' | 'fresh',
  toolAllowlist?: string[] | null,
  poolSignal?: AbortSignal,
  asyncMode?: boolean,
  agentIdOverride?: string,
  outputSchema?: Record<string, unknown> | null,
) => Promise<{ text: string; err?: string }>;
