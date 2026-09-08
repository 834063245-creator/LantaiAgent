// ── 消息模型 — 数据驱动的聊天渲染
// 用扁平消息数组替代旧的"单个 currentBubble + appendChild"模式。
// 每条消息是不可变记录；流式更新替换数组条目，渲染器做 diff。
//
// 受 Claude Code（messages/*.tsx）和 Hermes（@assistant-ui）启发。

// ── 类型 ────────────────────────────────────────────────

export type MessageId = string;

import type { PlanApprovalResponse, PlanOptionOutcome } from '../agent/plan/plan-tools';
import type { ChatImageRef } from '../provider/types';
// ⚡ _idSeq → chat-store.ts
import { getChatStore } from './chat-store';

export function nextMsgId(storeId?: string): MessageId {
  const store = getChatStore(storeId).sess.getState();
  const id = store.msgIdSeq + 1;
  getChatStore(storeId).sess.setState({ msgIdSeq: id });
  return `m${id}`;
}

/** 重置给定 store 的消息 ID 计数器。
 *  注意：现在是空操作，以防止跨会话 ID 冲突。
 *  计数器单调递增，确保全局唯一 ID。
 *  以前重置会导致新会话从 m1 重新开始，与已有会话冲突并错误路由流式事件。 */
export function resetMsgIdCounter(_storeId?: string): void {
  // 有意为空 — 见上方说明。
}

// ── 附件 ──────────────────────────────────────────

export interface FileAttachment {
  path: string;
  name: string;
  size: number;
}

// ── 消息部分（助手）────────────

export type ToolStatus = 'pending' | 'running' | 'done' | 'error';

export interface ReasonPart {
  type: 'reasoning';
  text: string;
}

export interface TextPart {
  type: 'text';
  text: string;
  /** 为 true 时，此文本已最终化（不再流式追加）。 */
  finalised: boolean;
}

export interface ToolCallPart {
  type: 'tool';
  toolId: string;
  name: string;
  args: string;
  /** 面向用户的标签，如"读取文件"或"搜索代码"。 */
  label: string;
  readOnly: boolean;
  status: ToolStatus;
  /** 工具运行期间累积的输出。 */
  output?: string;
  /** 工具失败时的错误信息。 */
  err?: string;
  /** 后端截断输出时为 true。 */
  truncated?: boolean;
  /** 首次进入 running 态的时刻（Date.now()，毫秒）——纸面行走秒的计时起点。
   *  历史会话/未流式直建的卡片无此字段（渲染层降级为不带秒）。 */
  startedAt?: number;
}

/** 子 agent 嵌套块 — 在助手消息内渲染为可折叠分组。 */
export interface SubAgentPart {
  type: 'subagent';
  agentId: string;
  description: string;
  status: 'running' | 'done' | 'error';
  /** 此子 agent 产出的有序部分。 */
  parts: AssistantPart[];
  /** 每次变更递增，使 React 可订阅而无需全局 bump。 */
  version: number;
}

/** 计划审查卡片 — 渲染为全宽卡片，含 markdown 内容 + 批准/修改/拒绝按钮。 */
export interface PlanPart {
  type: 'plan';
  planId: string;
  planFilePath: string;
  content: string;
  options?: { label: string; description: string; outcome?: PlanOptionOutcome }[];
  status: 'pending' | 'approved' | 'revise' | 'rejected';
  /** 用户从多种方案中选择时的选项标签。 */
  selectedLabel?: string;
  /** 用户请求修改时的反馈文本。 */
  feedback?: string;
  /** 解决审批的回调 — 创建时存储，用户点击按钮时调用。 */
  _callback?: (response: PlanApprovalResponse) => void;
}

/** 资产块 — Agent 生成的语义资产（show_asset / update_asset 通道，协议
 *  「Agent 资产块」design：docs/plans/agent-asset-blocks.md）。
 *  - assetId 是资产身份（会话内唯一），update 不换 assetId、不换 kind
 *  - presentation 是表现原语名（kind 白名单内；空串 = 渲染层回落 defaultPresentation）
 *  - payload 必须纯 JSON（回调不进 payload，加载时按 assetId 重绑）
 *  - finalised=true 前 payload 为 append 型字符串累加（AssetDelta 语义） */
export interface BlockPart {
  type: 'block';
  assetId: string;
  kind: string;
  presentation: string;
  title?: string;
  payload: unknown;
  finalised: boolean;
  /** 确认卡决议回调（confirm kind 实时卡；PlanPart._callback 同构）——瞬态
   *  函数不持久化（JSON 序列化自然丢弃），重载后历史确认卡只读态。 */
  _confirmCallback?: (response: import('../agent/agent-types').ConfirmCardResponse) => void;
  /** 确认卡已决议的终态（决议时写入；纯 JSON 随会话持久化）——重挂载/重载后
   *  卡片保持「已处理」态，不复挂操作钮。 */
  confirmResolution?: import('../agent/agent-types').ConfirmCardResponse;
}

export type AssistantPart = ReasonPart | TextPart | ToolCallPart | SubAgentPart | PlanPart | BlockPart;

// ── 消息 ─────────────────────────────────────────────

export interface UserMessage {
  role: 'user';
  _id: MessageId;
  text: string;
  files?: FileAttachment[];
  /** 附图引用（multimodal-image-plan D-1——与 files 并列，独立渲染/发送通道）。 */
  images?: ChatImageRef[];
  /** 发送时在 agent 会话数组中的索引（用于撤回）。 */
  sessionIndex: number;
}

export interface AssistantMessage {
  role: 'assistant';
  _id: MessageId;
  /** 有序部分 — 工具调用穿插在推理/文本之间。 */
  parts: AssistantPart[];
  /** 此助手回合的整体状态。 */
  status: 'streaming' | 'done' | 'error';
  /** 此助手回复的用户回合。 */
  respondingTo: MessageId;
  /** 本回合消耗的总 token 数（跨步骤累积）。 */
  tokensUsed?: number;
  /** 状态为 'error' 时的错误信息。 */
  errorMessage?: string;
}

export interface NoticeMessage {
  role: 'notice';
  _id: MessageId;
  text: string;
  level: 'info' | 'warn' | 'error';
}

export type ChatMessage = UserMessage | AssistantMessage | NoticeMessage;

// ── 辅助函数 ──────────────────────────────────────────────

/** 创建新用户消息。 */
export function createUserMessage(text: string, files?: FileAttachment[], sessionIndex?: number): UserMessage {
  return {
    role: 'user',
    _id: nextMsgId(),
    text,
    files: files?.length ? files : undefined,
    sessionIndex: sessionIndex ?? -1,
  };
}

/** 创建新的流式助手消息。 */
export function createAssistantMessage(respondingTo: MessageId): AssistantMessage {
  return {
    role: 'assistant',
    _id: nextMsgId(),
    parts: [],
    status: 'streaming',
    respondingTo,
  };
}

/** 创建通知消息（info/warn/error 横幅）。 */
export function createNoticeMessage(text: string, level: NoticeMessage['level'] = 'info'): NoticeMessage {
  return { role: 'notice', _id: nextMsgId(), text, level };
}

/** 获取最后一个文本部分（如有），用于流式追加。 */
export function lastTextPart(parts: AssistantPart[]): TextPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'text') return parts[i] as TextPart;
  }
  return undefined;
}

/** 在部分数组中查找最后一个推理部分。 */
export function lastReasoningPart(parts: AssistantPart[]): ReasonPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'reasoning') return parts[i] as ReasonPart;
  }
  return undefined;
}

/** 按 toolId 查找工具部分。 */
export function findToolPart(parts: AssistantPart[], toolId: string): ToolCallPart | undefined {
  return parts.find((p): p is ToolCallPart => p.type === 'tool' && p.toolId === toolId);
}

/** 按 assetId 查找资产部分（从后往前——最新的优先）。 */
export function findBlockPart(parts: AssistantPart[], assetId: string): BlockPart | undefined {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const p = parts[i];
    if (p.type === 'block' && p.assetId === assetId) return p;
  }
  return undefined;
}
