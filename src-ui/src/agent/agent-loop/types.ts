// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// agent loop 契约（平台化 Phase 5 · D13，2026-08-28）——流式循环从 Agent
// 特权本体降为**第一方默认实现**：契约上可替换（ctx.agentLoop 注册表，
// 后注册胜），Agent 接口不变，扩展方只依赖本包的接口（AgentLoop/
// AgentLoopHost），不 import 默认实现内部（守卫测试 grep 归零）。
//
// AgentLoopHost = loop 体对 Agent 的全部依赖面（由 Agent._loopHost() 以
// 闭包构建——私有成员不出类，行为逐字节一致）。接口成员命名去掉下划线
// 前缀（宿主面是 loop 的公开契约，不是 Agent 内部命名）。
//
// 替换契约：第三方通常不替换 loop（事件/服务才是扩展面），但可以——
// register 一个 AgentLoop 即接管 turn/step/request/tool 全生命周期。

import type { Message, Provider, ToolCall, Usage } from '../../provider/types';
import type { AgentEvent, AgentUINotifier } from '../agent-types';
import type { CompactionTracker } from '../compaction-model';
import type { AgentEventBus } from '../events';
import type { HookRegistry, PreflightHookRegistry } from '../hooks';
import type { MessageBus } from '../message-bus';
import type { PlanGate } from '../plan/plan-registry';
import type { SessionLog } from '../session-log';
import type { StreamingToolExecutor } from '../streaming-executor';
import type { ToolRegistry } from '../tool';

/** loop 一次流式请求的产物（Agent.stream 的返回形状）。 */
export interface LoopStreamResult {
  text: string;
  reasoning: string;
  signature: string;
  calls: ToolCall[];
  usage: Usage | undefined;
  err: Error | undefined;
}

/** loop 体对宿主 Agent 的依赖面（Agent._loopHost() 构建）。
 *  成员分三类：稳定引用（对象/方法——引用即活值）、可变标量（get/set——
 *  闭包穿透保活性）、loop 专属状态。 */
export interface AgentLoopHost {
  // ── 稳定引用 ──
  readonly id: string;
  readonly prov: Provider;
  readonly tools: ToolRegistry;
  readonly hooks: HookRegistry | null;
  readonly preflightHooks: PreflightHookRegistry | null;
  /** 隔离 worktree id（null = 主仓）。 */
  readonly isolationId: string | null;
  readonly planGate: PlanGate;
  readonly loopEvents: AgentEventBus;
  readonly sessionLog: SessionLog;
  readonly bus: MessageBus | null;
  readonly injectedMsgIds: Set<string>;
  readonly ui: AgentUINotifier;
  readonly planState: { state: { active: boolean; planFilePath: string | null; id: string | null } } | null; // PlanStateManager 结构子集（loop 只读 active/planFilePath）
  readonly planInjector: {
    getReminder(
      step: number,
      state: { active: boolean; planFilePath: string | null; id: string | null },
      planContent: string,
    ): string | null;
  } | null;
  readonly compactionTracker: CompactionTracker;
  readonly contextWindow: number;
  readonly pendingInserts: readonly string[];

  // ── 方法（宿主能力）──
  sink(ev: AgentEvent): void;
  appendMessage(kind: 'user/message' | 'assistant/text' | 'tool/result', message: Message): void;
  stream(signal: AbortSignal, turn: number, executor?: StreamingToolExecutor): Promise<LoopStreamResult>;
  tokenCountWithEstimation(): number;
  compactNow(signal: AbortSignal): Promise<string>;
  maybeCompact(usage: Usage | undefined): void;
  stormNudge(calls: ToolCall[], resultsByCallId: Map<string, { output: string; err?: string }>): string | null;
  diagTokenBreakdown(apiUsage: Usage | undefined): void;
  toolReadOnly(name: string): boolean;
  applyPendingInserts(): void;
  applyPendingMemoryUpdates(): void;
  injectInbox(): void;
  injectDiscoveries(): void;
  onMessageDelivered(): Promise<void>;

  // ── 可变标量（get/set 闭包——活性由 Agent 侧字段保证）──
  get isRunning(): boolean;
  set isRunning(v: boolean);
  get currentRunSignal(): AbortSignal | null;
  set currentRunSignal(v: AbortSignal | null);
  get transientReminders(): string[];
  set transientReminders(v: string[]);
  get compactStuck(): boolean;
  get compactRunning(): boolean;
  get cacheHitTotal(): number;
  set cacheHitTotal(v: number);
  get cacheMissTotal(): number;
  set cacheMissTotal(v: number);
  get lastUsage(): Usage | undefined;
  set lastUsage(v: Usage | undefined);
}

/** 可替换的 agent loop（D13 seam）。id = 注册表寻址面（后注册胜）。 */
export interface AgentLoop {
  id: string;
  run(host: AgentLoopHost, signal: AbortSignal): Promise<void>;
}
