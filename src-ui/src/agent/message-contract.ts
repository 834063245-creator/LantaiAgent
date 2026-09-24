// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 多 Agent 通信域**契约面**（批 7b，2026-09-24；原 agent/message-types.ts 整件升格）
//
// 拓扑无关、格式无关的消息总线类型契约。实现（MessageBus / JsonMessageStore / 三种拓扑 /
// 通信与请求工具族）已归产物包 `plugins/builtin/multiagent-comm/`，**类型与错误类留内核**：
//   - `AgentMessage` 被 UI 直读（`ui/agent-panel-store.ts`）；
//   - `MessageBus` 是内核多处只读面（agent / context / agent-loop 契约 / lifecycle-manager /
//     subagent-spawn / blueprint）；
//   - 四个错误类是**跨边界可判类型**（工具层 catch/throw 与调用方按类型分流）。

// ── Agent 身份与路由 ──

export interface AgentAddress {
  /** agentId 在 runtime 内唯一 */
  agentId: string;
  /** parentId 用于拓扑策略判断（树形） */
  parentId: string | null;
  /** subagentDepth 用于深度限制 */
  depth: number;
}

// ── 消息信封 ──

export interface AgentMessage {
  /** 唯一 ID，用于去重和回复关联 */
  id: string;
  /** 发送者 agentId */
  from: string;
  /** 接收者 agentId，或 'broadcast' 表示广播 */
  to: string;
  /** 消息类型，用于订阅过滤（如 'question', 'result', 'status', 'notification'） */
  type: string;
  /** 消息内容，类型不限 */
  payload: unknown;
  /** 时间戳 */
  ts: number;
  /** 如果是回复某条消息，关联原消息 ID */
  replyTo?: string;
  /** 扩展元数据 */
  meta?: Record<string, unknown>;
}

// ── 订阅过滤 ──

export interface MessageFilter {
  /** 仅匹配特定发送者 */
  from?: string;
  /** 仅匹配特定接收者 */
  to?: string;
  /** 仅匹配特定消息类型 */
  type?: string | string[];
  /** 自定义谓词，最终决定是否匹配 */
  predicate?: (msg: AgentMessage) => boolean;
}

// ── 拓扑策略接口 ──

export interface TopologyPolicy {
  /** 判断 from→to 的消息是否允许通过 */
  canSend(from: string, to: string, bus: { getAgent: (id: string) => AgentAddress | undefined }): boolean;
  /** 返回允许的通信目标列表（供工具描述使用） */
  allowedTargets(agentId: string, bus: { listAgents: () => AgentAddress[] }): string[];
}

// ── 背压策略 ──

export type BackpressureStrategy = 'block' | 'drop' | 'reject';

// ── 持久化接口（Phase 2 实现，Phase 1 为 no-op） ──

export interface MessageStore {
  flush(inboxes: Map<string, AgentMessage[]>): Promise<void>;
  restore(): Promise<Map<string, AgentMessage[]>>;
  /** Delete the persisted inbox for an agent (called on unregister). */
  delete(agentId: string): Promise<void>;
}

// ── 消息传输层接口 — 将 bus 逻辑与传输解耦 ──
//
// Phase 1: InProcessTransport（内存直达）
// Phase 2+: TauriEventTransport（跨窗口）/ RpcTransport（跨机器）

export interface MessageTransport {
  /** 投递消息到目标 agent 的 inbox。
   *  实现负责：inbox 容量检查、背压策略、msgIndex 维护。
   *  抛 InboxFullError / AgentNotFoundError 由调用方处理。 */
  deliver(agentId: string, msg: AgentMessage): void;

  /** 注册消息到达回调（agent idle 时用来唤醒 runLoop）。
   *  transport 实现可选 — MessageBus 自身也维护 wake callbacks。 */
  onDelivered?(agentId: string): void;
}

// ── 自定义错误类型 ──

export class TopologyDeniedError extends Error {
  constructor(
    message: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(message);
    this.name = 'TopologyDeniedError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(
    message: string,
    public readonly agentId: string,
  ) {
    super(message);
    this.name = 'AgentNotFoundError';
  }
}

export class InboxFullError extends Error {
  constructor(
    message: string,
    public readonly agentId: string,
  ) {
    super(message);
    this.name = 'InboxFullError';
  }
}

export class MessageNotFoundError extends Error {
  constructor(
    message: string,
    public readonly msgId: string,
  ) {
    super(message);
    this.name = 'MessageNotFoundError';
  }
}

// Phase 2+ 预留（暂不实现）
// export class DeadlockError extends Error { ... }
// export class RequestTimeoutError extends Error { ... }

// ── 总线实现面（批 7b：实现进包，内核只读接口）──

/** MessageBus 的公开面（成员与实现类逐字对齐；内核消费方只依赖本接口）。 */
export interface MessageBus {
  register(addr: AgentAddress, onWake?: () => void): void;
  unregister(agentId: string): void;
  isRegistered(agentId: string): boolean;
  systemNotify(to: string, type: string, payload: unknown): string | null;
  send(msg: Omit<AgentMessage, 'id' | 'ts'> & { from: string }): string;
  reply(callerId: string, originalMsgId: string, payload: unknown, meta?: Record<string, unknown>): string;
  broadcast(from: string, type: string, payload: unknown, meta?: Record<string, unknown>): string[];
  subscribe(filter: MessageFilter, handler: (msg: AgentMessage) => void): () => void;
  peekInbox(agentId: string): AgentMessage[];
  queryInbox(
    agentId: string,
    filter: { from?: string; type?: string; msgId?: string; limit?: number; summaryOnly?: boolean },
  ): AgentMessage[] | { count: number; messages: { id: string; from: string; type: string; ts: number }[] };
  consumeByType(agentId: string, types: string[]): { consumed: AgentMessage[]; remaining: AgentMessage[] };
  purgeExpired(agentId: string): void;
  purgeEphemeralTypes(): void;
  ackMessage(agentId: string, msgId: string): boolean;
  unreadCount(agentId: string): number;
  setTopology(policy: TopologyPolicy): void;
  getTopology(): TopologyPolicy;
  canSend(from: string, to: string): boolean;
  setInboxCapacity(capacity: number): void;
  setBackpressureStrategy(strategy: BackpressureStrategy): void;
  flush(): Promise<void>;
  restore(): Promise<void>;
  clearFlushTimer(): void;
  getAgent(id: string): AgentAddress | undefined;
  listAgents(): AgentAddress[];
}

/** 通信域实现面——产物包 `hologram/multiagent-comm` 在 apply 期登记；内核
 *  （`runtime.ts` 造 bus/store · blueprint 两条 capability 造工具面）查表取用。
 *  **service 语义**：runtime 构造点是会话基础设施，缺实现即 fail-loud。 */
export interface MultiagentCommImplementation {
  createBus(transport?: MessageTransport, store?: MessageStore): MessageBus;
  createJsonStore(projectPath: string): MessageStore;
  createCommunicationTools(bus: MessageBus, agentId: () => string): import('./tool').Tool[];
  createRequestTool(bus: MessageBus, getAgentId: () => string): import('./tool').Tool;
}
