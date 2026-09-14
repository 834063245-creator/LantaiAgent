// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 共享 agent 类型 — 从 agent.ts 中提取，避免 agent.ts 和 streaming-executor.ts 之间的循环依赖。

import type { Message, Usage } from '../provider/types';
import type { TokenRequestRecord } from './token-meter/types';

export enum EventKind {
  TurnStarted = 'turn_started',
  Reasoning = 'reasoning',
  Text = 'text',
  Message = 'message',
  ToolDispatch = 'tool_dispatch',
  ToolResult = 'tool_result',
  ToolProgress = 'tool_progress',
  Usage = 'usage',
  Notice = 'notice',
  SessionChanged = 'session_changed',
  PlanReview = 'plan_review',
  /** 资产块终值（权威）：一次性交付完整 payload（append/replace 两段式的 replace 端） */
  Asset = 'asset',
  /** 资产块增量（append/replace 两段式的 append 端）：chunk 追加到未 finalised 的 BlockPart */
  AssetDelta = 'asset_delta',
}

export interface ToolEvent {
  id: string;
  name: string;
  args?: string;
  output?: string;
  err?: string;
  read_only: boolean;
  partial?: boolean;
  truncated?: boolean;
}

/** 工具管道上下文 — Phase 2 类型化事件的载荷（agent-core-convergence）。
 *  guard 阶段 args 为原始 JSON 解析结果（非法 JSON 时 null）；guardName 为
 *  领域名解析后的工具名（dispatch 阶段未解析，等于 call.name）。 */
export interface ToolPipelineContext {
  call: import('../provider/types').ToolCall;
  tool: import('./tool').Tool | null;
  args: Record<string, unknown> | null;
  agentId: string | null;
  signal: AbortSignal | null;
  /** 领域名解析后的工具名（resolveGuardToolName 结果） */
  guardName: string;
}

export interface PlanReviewEvent {
  planFilePath: string;
  planContent: string;
  options?: { label: string; description: string; outcome?: import('./plan/plan-tools').PlanOptionOutcome }[];
  callback: (response: import('./plan/plan-tools').PlanApprovalResponse) => void;
}

/** 确认卡决议（confirm kind，plan 审批语义的资产化泛化）：
 *  approved=用户点了确认（选了某个选项则带 selectedLabel）；
 *  revise=用户要求修改（带反馈）；rejected=用户拒绝；
 *  no_ui=无界面通道（嵌套/headless 环境）立即放行；timeout=等待超时放行。 */
export type ConfirmCardResponse =
  | { decision: 'approved'; selectedLabel?: string }
  | { decision: 'revise'; feedback: string }
  | { decision: 'rejected' }
  | { decision: 'no_ui' }
  | { decision: 'timeout' };

/** 资产块终值载荷（EventKind.Asset）——BlockPart 的权威来源；payload 必须纯 JSON。
 *  presentation 缺省时由渲染层回落 kind 的 defaultPresentation（协议 §2.2）。 */
export interface AssetEventData {
  /** 资产身份——会话内唯一，后续 update/reference 的唯一键 */
  assetId: string;
  /** 语义 kind（kind 注册表的键；update 不可变更） */
  kind: string;
  /** 表现形态（presentation）——kind 白名单内的表现原语名；可空（回落 default） */
  presentation?: string;
  /** 面向用户的标题（文类签展示语义，可空） */
  title?: string;
  /** 完整 payload（纯 JSON） */
  payload: unknown;
  /** 确认卡决议回调（confirm kind 实时卡专用；PlanReview.callback 同构）。
   *  瞬态函数——只经事件管道进 BlockPart，永不持久化（JSON 序列化自然丢弃，
   *  重载后的历史确认卡只读态）。非 confirm 资产恒缺省。 */
  onResponse?: (response: ConfirmCardResponse) => void;
}

/** 资产块增量载荷（EventKind.AssetDelta）——append 型 kind 的流式 chunk。 */
export interface AssetDeltaEventData {
  assetId: string;
  kind: string;
  /** 追加文本块（字符串累加器语义——与 TextPart 追加同构） */
  chunk: string;
}

export interface AgentEvent {
  kind: EventKind;
  text?: string;
  reasoning?: string;
  tool?: ToolEvent;
  usage?: Usage;
  /** token 计量记录（2026-09-13）：每次请求一条，随 Usage 事件投递。
   *  真源 = Agent 侧 SessionTokenMeter 账本；UI 侧计量面（state/token-store）
   *  按它累进，因此事件重放不会重复入账（同一 token record 幂等地刷同一槽）。 */
  token?: TokenRequestRecord;
  session_hit?: number;
  session_miss?: number;
  level?: 'info' | 'warn' | 'error';
  plan?: PlanReviewEvent;
  /** EventKind.Asset 时携带 */
  asset?: AssetEventData;
  /** EventKind.AssetDelta 时携带 */
  assetDelta?: AssetDeltaEventData;
}

/** Sink 接收 agent 的类型化事件流。 */
export type EventSink = (event: AgentEvent) => void;

/** UI 通知端口 — 由 workspace 注入，使 agent 核心永远不
 *  导入 UI 模块（单向边界：ui → agent，绝无 agent → ui）。
 *  所有成员可选；headless agent 不需要任何通知。 */
export interface AgentUINotifier {
  /** 循环进度（驱动状态栏）。 */
  progress?(step: number, toolName: string): void;
  /** 工具调用完成（面板自动刷新）。 */
  toolDone?(toolName: string, args: Record<string, unknown>, output: string): void;
  /** 子 Agent 启动中。UI 在此构建其渲染状态，并返回
   *  子 agent 应流式输出的 EventSink（undefined → 空操作 sink）。
   *  sessionId 标识拥有此子 Agent 输出的 UI 会话。 */
  subAgentSpawn?(
    info: { agentId: string; description: string; sessionId: number },
    onProgress?: (chunk: string) => void,
  ): EventSink | undefined;
  /** Agent 运行状态变更（idle ↔ running） */
  onStatusChange?(running: boolean): void;
  /** 子 Agent 完成 — UI 完成其渲染状态。 */
  subAgentFinished?(agentId: string, sessionId: number, ok: boolean): void;
  /** Agent 的会话数组已被替换（压缩 / 撤回 / setSession）。
   *  ChatCore 需要重建其 ChatMessage[] 投影。 */
  sessionReplaced?(messages: Message[]): void;
}
