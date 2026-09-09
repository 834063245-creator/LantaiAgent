// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Stream — 流式渲染管线
// ponytail: 消息存放在会话级 store 中（getMessagesStore(`${storeId}:${sid}`)）。
// 无面板级消息数组，无 sessionMessageModels 缓存，无手动同步。
// 流式写入直接指向会话的 store — 无论哪个标签页活跃都始终正确。

import type { TurnPair } from '../agent/agent-session-state';
import type { AgentEvent, AssetEventData } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import { getAssetTableStore } from '../state/asset-store';
import { refreshPinnedAssetSnapshots } from '../state/canvas-store';
import { showToast, TOAST_HOLD_MS, TOAST_LONG_HOLD_MS } from '../state/toast-store';
import { autoTitleSessionIfDefault } from './chat-session';
import { bumpChat, getChatStore, msgStoreFor } from './chat-store';
import type { AssistantMessage, ChatMessage, FileAttachment, MessageId, PlanPart, UserMessage } from './message-model';
import { createAssistantMessage, createUserMessage } from './message-model';
import { applyAssetUpdateToExistingParts, applyEventToParts } from './part-mutator';
import { isSubagentSpawnTool } from './tool-semantics';

// ── 轮次配对类型 ──
// （权威定义在 agent/agent-session-state.ts——此处只引用，防双源漂移）

// ── StreamContext ──────────────────────────────────────────

export interface StreamContext {
  storeId: string;

  /** 本事件流所属会话（并发会话，2026-08-26）：工厂装配时绑定进 eventSink
   *  闭包——事件路由的权威身份，不再靠 streamingTargetSid 猜测。
   *  null = 无身份的遗留路径（用户主动作/恢复），按活跃卷兜底。 */
  sessionId: number | null;

  // ── 会话级消息 store（ponytail: 唯一数据源）──
  getSessionMessages: (sid: number) => ChatMessage[];
  getActiveMessages: () => ChatMessage[];
  setSessionMessages: (sid: number, msgs: ChatMessage[]) => void;
  bumpSessionMessages: (sid: number) => void;

  // ── 流式状态（会话级 — 每卷一个流式助手；并发会话互不覆盖）──
  getStreamingAssistantId: () => MessageId | null;
  setStreamingAssistantId: (id: MessageId | null) => void;
  getUserScrolledUp: () => boolean;
  setUserScrolledUp: (v: boolean) => void;
  getSyncRafId: () => number | null;
  setSyncRafId: (id: number | null) => void;

  // ── turnPairs ──
  getTurnPairs: () => TurnPair[];

  // ── Agent ──
  getAgent: () => ChatAgentHandle | null;

  // ── 回调 ──
  updateFooter: () => void;
  setLastUsageText: (s: string) => void;
  saveActiveSession: (path: string) => Promise<void>;
  scheduleAutoSave: (path: string) => void;
  bumpPillBadge: () => void;
  animateBubbleIn: (el: HTMLElement, delay?: number) => void;
  setRunning: (r: boolean) => void;
  abort: () => void;
  _updateStatusBar: (state: 'idle' | 'thinking' | 'running' | 'error', detail?: string) => void;
  _recordToolUsage: (toolName: string, args: string) => void;
  sendMessage: () => Promise<void>;
  _updateTokens: (tokensUsed: number) => void;

  getProjectPath: () => string;
  getRunning: () => boolean;
  getAbortCtrl: () => AbortController | null;
  setAbortCtrl: (c: AbortController | null) => void;
  getExpandedReasoning: () => Set<number>;
}

// ── 会话路由 ───────────────────────────────────────
// ponytail: 解析哪个会话拥有流式助手。
// 策略：
//   1. 若 assistantId 已知 → 扫描会话 store 查找（O(sessions)，≤10）
//   2. 若尚无 assistant → 检查 pendingStreamingSession（由 sendMessage 在 agent.run 前设置）
//   3. 兜底 → 活跃会话
// 防止用户在 sendMessage 后、第一个文本事件到达前切换标签页的竞态
// （此时 streamingAssistantId 仍为 null）。
// 并发会话改造（2026-08-26）：策略 0 = ctx.sessionId（工厂绑定的 eventSink
// 闭包携带）直达，取代原 pendingStreamingSession 猜测。

interface SessionTarget {
  sessionId: number;
  messages: ChatMessage[];
  isActive: boolean;
}

function _resolveSessionTarget(ctx: StreamContext, assistantId: MessageId | null): SessionTarget | null {
  const sessStore = getChatStore(ctx.storeId).sess;
  const { sessions, activeIdx } = sessStore.getState();
  const activeSid = sessions[activeIdx]?.id;

  // 0) 事件流身份直达 — 工厂装配时绑定的 sink 携带所属卷，并发流互不串扰
  if (ctx.sessionId != null) {
    const msgs = ctx.getSessionMessages(ctx.sessionId);
    return { sessionId: ctx.sessionId, messages: msgs, isActive: ctx.sessionId === activeSid };
  }

  // 1) 遗留路径（无身份）：已知 assistant → 查找其所属会话
  if (assistantId) {
    for (const s of sessions) {
      const msgs = ctx.getSessionMessages(s.id);
      if (msgs.some((m) => m._id === assistantId)) {
        return { sessionId: s.id, messages: msgs, isActive: s.id === activeSid };
      }
    }
  }

  // 2) 兜底：活跃会话
  if (activeSid != null) {
    return {
      sessionId: activeSid,
      messages: ctx.getActiveMessages(),
      isActive: true,
    };
  }
  return null;
}

// ── 流式助手辅助函数 ─────────────────────────────

function _streamingAssistant(ctx: StreamContext): AssistantMessage {
  const id = ctx.getStreamingAssistantId();
  const target = _resolveSessionTarget(ctx, id);
  if (!target) {
    // ponytail: 无会话 → 无法渲染。不应发生（面板始终有 ≥1 个会话）。
    return createAssistantMessage('');
  }

  const msgs = target.messages;

  if (id) {
    const found = msgs.find((m) => m.role === 'assistant' && m._id === id) as AssistantMessage | undefined;
    if (found) return found;
  }

  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const assistant = createAssistantMessage(lastUser?._id ?? '');
  msgs.push(assistant);
  ctx.setStreamingAssistantId(assistant._id);

  // 持久化 + 递增会话的 store
  ctx.setSessionMessages(target.sessionId, [...msgs]);
  ctx.bumpSessionMessages(target.sessionId);
  // ponytail: assistant ID 已确立 — 后续事件通过会话 store 找到它
  //（并发会话改造：streamingAssistantId 已按会话隔离，无需再清流式目标）。
  return assistant;
}

/** 回合墓碑（2026-08-31 贴黄拆迁）：把终止失败/暂停写入当前回合的
 *  assistant 消息（status='error' + errorMessage）。finishTurn 尊重
 *  error 状态不覆盖——墓碑跨流式收尾存活（translate 渲染为 turn-error
 *  块，贴在该回合正文尾部）。无流式助手/回合消息缺席（装配期错误）：
 *  退化为 toast，错误不静默。 */
export function markTurnError(ctx: StreamContext, text: string, level: 'warn' | 'error' = 'error'): void {
  const sid = ctx.getStreamingAssistantId();
  const target = _resolveSessionTarget(ctx, sid);
  const msgs = target ? target.messages : ctx.getActiveMessages();
  const assistant = sid
    ? (msgs.find((m) => m.role === 'assistant' && m._id === sid) as AssistantMessage | undefined)
    : undefined;
  if (assistant) {
    assistant.status = 'error';
    assistant.errorMessage = text;
    const idx = msgs.indexOf(assistant);
    if (idx >= 0) msgs[idx] = { ...assistant };
    if (target) {
      ctx.setSessionMessages(target.sessionId, [...msgs]);
      ctx.bumpSessionMessages(target.sessionId);
    } else {
      bumpChat(ctx.storeId);
    }
    return;
  }
  // 回合缺席（装配期/第一个 token 前崩溃）：toast 兜底，错误不静默
  showToast(text, level === 'warn' ? 'warn' : 'error', level === 'warn' ? TOAST_HOLD_MS : TOAST_LONG_HOLD_MS);
}

/** Agent 层系统通知（EventKind.Notice）分流（2026-08-31 贴黄拆迁）：
 *  - error → 回合墓碑（贴当前回合尾）
 *  - warn  → toast 长显（说完即走）
 *  - info  → 丢弃。agent 侧日志已记；goal 轮播/操作反馈是噪音，且 goal
 *            终结结果由 UI 层 _notifyGoalResult 单独播报，不重复。 */
export function handleAgentNotice(ctx: StreamContext, text: string, level: string): void {
  if (level === 'error') {
    markTurnError(ctx, text || '未知错误', 'error');
  } else if (level === 'warn') {
    showToast(text, 'warn', TOAST_LONG_HOLD_MS);
  }
}

// ═══════════════════════════════════════════════════════════
// _finaliseStreamingAssistant
// ═══════════════════════════════════════════════════════════

/** 标记当前流式助手为完成。 */
function _finaliseStreamingAssistant(ctx: StreamContext): void {
  const sid = ctx.getStreamingAssistantId();
  const target = _resolveSessionTarget(ctx, sid);
  const msgs = target ? target.messages : ctx.getActiveMessages();

  const assistant = msgs.find((m) => m.role === 'assistant' && m._id === sid) as AssistantMessage | undefined;
  if (assistant) {
    // 回合墓碑（2026-08-31）：status='error' 是终止失败/暂停——finishTurn 不
    // 覆盖成 done，墓碑跨流式收尾存活（translate 据此渲染 turn-error 块）。
    if (assistant.status !== 'error') assistant.status = 'done';
    for (const part of assistant.parts) {
      if (part.type === 'text') part.finalised = true;
      if (part.type === 'tool' && (part.status === 'running' || part.status === 'pending')) {
        part.status = 'error';
      }
    }
    // 替换为新的消息对象：AssistantBubble 的 memo 比较器在
    // prev.msg === next.msg 时直接跳过，因此仅原地修改永远不会
    // 渲染流式→完成的转换（卡住的旋转器/光标）。
    // 浅拷贝共享 parts 数组 — 实时的 part 修改保持可见。
    const idx = msgs.indexOf(assistant);
    if (idx >= 0) msgs[idx] = { ...assistant };
  }

  // 刷新待渲染
  const timerId = ctx.getSyncRafId();
  if (timerId !== null) {
    clearTimeout(timerId);
    ctx.setSyncRafId(null);
  }

  // 在 streamingAssistantId 仍设置时做最终递增
  if (sid && target) {
    ctx.setSessionMessages(target.sessionId, [...msgs]);
    ctx.bumpSessionMessages(target.sessionId);
  } else if (sid) {
    bumpChat(ctx.storeId);
  }

  ctx.setStreamingAssistantId(null);
  // ponytail（并发会话改造）：streamingAssistantId 按会话隔离（get/set 路由
  // 到本 ctx 所属卷的 store），TurnStarted 提前触发本函数不会误伤其它卷的流。
}

// ═══════════════════════════════════════════════════════════
// 流式递增 — 触发流式会话的重新渲染
// ═══════════════════════════════════════════════════════════

function _streamingBump(ctx: StreamContext): void {
  const sid = ctx.getStreamingAssistantId();
  const target = _resolveSessionTarget(ctx, sid);
  if (target) {
    // 单一写入路径：替换流式消息的引用，使 memoized 的
    // 气泡能观察到原地 part 修改（见 messages-store.ts）。
    if (sid) {
      const idx = target.messages.findIndex((m) => m._id === sid);
      if (idx >= 0) target.messages[idx] = { ...target.messages[idx] };
    }
    ctx.setSessionMessages(target.sessionId, [...target.messages]);
    ctx.bumpSessionMessages(target.sessionId);
  } else {
    // ponytail: 兜底 — 递增活跃会话的 store（React 订阅的是
    // 会话级 store，而非 bumpChat 所针对的面板级 msg store）。
    const sessStore = getChatStore(ctx.storeId).sess;
    const { sessions, activeIdx } = sessStore.getState();
    const activeSid = sessions[activeIdx]?.id;
    if (activeSid != null) {
      ctx.bumpSessionMessages(activeSid);
    } else {
      bumpChat(ctx.storeId);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// _scheduleSync
// ═══════════════════════════════════════════════════════════

// ponytail: 使用 setTimeout(16) 防抖替代 requestAnimationFrame。
// rAF 在 Tauri WebView 中（后台/最小化标签页）可能被暂停/节流，
// 导致 syncRafId 守卫永久阻塞后续流式渲染。
// setTimeout 总会触发 — 无卡死标志 bug，无需安全超时。
// （复发 bug：相同的 rAF 守卫模式也曾冻结 graph-scene；
// 在 a231b89 中用 15 秒安全超时修复。）
export function _scheduleSync(ctx: StreamContext): void {
  if (ctx.getSyncRafId() !== null) return;
  const timerId = window.setTimeout(() => {
    ctx.setSyncRafId(null);
    _streamingBump(ctx);
  }, 16);
  ctx.setSyncRafId(timerId);
}

// ═══════════════════════════════════════════════════════════
// Asset 广播（WO-5/A7）：update_asset 原位替换所有引用 + pinned 孤儿快照刷新
// ═══════════════════════════════════════════════════════════

function _applyAssetBroadcast(ctx: StreamContext, asset: AssetEventData): void {
  const target = _resolveSessionTarget(ctx, ctx.getStreamingAssistantId());
  if (!target) return;
  const sid = target.sessionId;
  const store = msgStoreFor(ctx.storeId, sid);
  const assetTable = getAssetTableStore(`${ctx.storeId}:${sid}`);
  const existed = assetTable.getState().get(asset.assetId) !== undefined;

  const touched: MessageId[] = [];
  let found = false;
  for (const msg of target.messages) {
    if (msg.role !== 'assistant') continue;
    if (applyAssetUpdateToExistingParts(msg.parts, asset)) {
      found = true;
      touched.push(msg._id);
    }
  }
  for (const id of touched) store.getState().touchMessage(id);

  // 全新资产（show_asset）且会话中还没有任何引用：沿用原路径 append 到当前流式助手。
  // 若资产表已有记录却找不到消息引用 = 源 part 已被压缩/清理的 orphan-only 更新，
  // 不新增块，只刷 pinned 孤儿快照。
  if (!found && !existed) {
    applyEventToParts(_streamingAssistant(ctx).parts, { kind: EventKind.Asset, asset });
    _streamingBump(ctx);
  }

  assetTable.getState().upsert(asset);
  refreshPinnedAssetSnapshots(ctx.storeId, asset);
}

// ═══════════════════════════════════════════════════════════
// renderEvent — Agent 事件分发
// ═══════════════════════════════════════════════════════════

export function renderEvent(ctx: StreamContext, ev: AgentEvent): void {
  switch (ev.kind) {
    case EventKind.TurnStarted:
      _finaliseStreamingAssistant(ctx);
      ctx.getExpandedReasoning().clear();
      break;

    case EventKind.Reasoning:
    case EventKind.Text:
    case EventKind.Message:
      if (ev.text || ev.kind === EventKind.Message) {
        applyEventToParts(_streamingAssistant(ctx).parts, ev);
        _scheduleSync(ctx);
      }
      break;

    case EventKind.ToolDispatch:
      if (ev.tool) {
        const t = ev.tool;
        ctx._recordToolUsage(t.name, t.args || '');
        ctx._updateStatusBar('running', `执行 ${t.name}`);
        // agent_spawn（旧名）与 agent(spawn)（领域工具）都通过 SubAgentBlock 渲染 — 跳过 ToolCard
        if (!isSubagentSpawnTool(t.name, t.args, t.partial)) {
          applyEventToParts(_streamingAssistant(ctx).parts, ev);
        }
        _streamingBump(ctx);
      }
      break;

    case EventKind.ToolProgress:
      if (ev.tool) {
        applyEventToParts(_streamingAssistant(ctx).parts, ev);
        _scheduleSync(ctx);
      }
      break;

    case EventKind.ToolResult:
      if (ev.tool) {
        applyEventToParts(_streamingAssistant(ctx).parts, ev);
        _streamingBump(ctx);
        ctx._updateStatusBar('thinking', '分析中…');
      }
      break;

    case EventKind.Usage:
      if (ev.usage?.total_tokens) {
        ctx._updateTokens(ev.usage.total_tokens);
        const u = ev.usage;
        const total = u.total_tokens ?? 0;
        const cached = u.cache_hit_tokens ?? 0;
        const missTokens = u.cache_miss_tokens ?? 0;
        const inputTokens = cached + missTokens;
        const hitRate = inputTokens > 0 ? (cached / inputTokens) * 100 : 0;
        let label = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
        label += ' tok';
        if (cached > 0) label += ` · ${cached >= 1000 ? (cached / 1000).toFixed(1) + 'k' : cached} cache`;
        if (cached > 0) label += ` · ${hitRate.toFixed(0)}% 命中`;
        ctx.setLastUsageText(label);
        ctx.updateFooter();
        _streamingBump(ctx);
      }
      break;

    case EventKind.Notice:
      handleAgentNotice(ctx, ev.text || '', ev.level || 'info');
      break;

    case EventKind.SessionChanged:
      _streamingBump(ctx);
      break;

    case EventKind.PlanReview:
      if (ev.plan) {
        const p = ev.plan;
        const planPart: PlanPart = {
          type: 'plan',
          planId: `plan-card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          planFilePath: p.planFilePath,
          content: p.planContent,
          options: p.options,
          status: 'pending',
          _callback: p.callback,
        };
        const assistant = _streamingAssistant(ctx);
        assistant.parts.push(planPart);
        _streamingBump(ctx);
      }
      break;

    case EventKind.Asset:
      if (ev.asset) _applyAssetBroadcast(ctx, ev.asset);
      break;

    case EventKind.AssetDelta:
      if (ev.assetDelta) {
        applyEventToParts(_streamingAssistant(ctx).parts, ev);
        _scheduleSync(ctx);
      }
      break;

    default:
      console.warn('[chat] renderEvent: unknown event kind', ev.kind);
      break;
  }
}

// ═══════════════════════════════════════════════════════════
// 气泡辅助函数（数据驱动模型）
// ═══════════════════════════════════════════════════════════

export function appendUserBubble(
  ctx: StreamContext,
  text: string,
  files?: { path: string; name: string; size: number }[],
  _skipActions?: boolean,
  images?: import('../provider/types').ChatImageRef[],
): UserMessage {
  const fileAttachments: FileAttachment[] = (files || []).map((f) => ({
    path: f.path,
    name: f.name,
    size: f.size,
  }));
  const userMsg = createUserMessage(text, fileAttachments.length > 0 ? fileAttachments : undefined, undefined, images);

  const msgs = ctx.getActiveMessages();
  msgs.push(userMsg);
  const sessStore = getChatStore(ctx.storeId).sess;
  const st = sessStore.getState();
  const activeSid = st.sessions[st.activeIdx]?.id;
  if (activeSid != null) {
    ctx.setSessionMessages(activeSid, [...msgs]);
    // ponytail: 通过 bumpSession 递增，使 React（订阅会话级 store）重新渲染
    if (ctx.bumpSessionMessages) ctx.bumpSessionMessages(activeSid);
  }

  const pair = ctx.getTurnPairs()[ctx.getTurnPairs().length - 1];
  if (pair) pair.userBubble = null;
  return userMsg;
}
// （2026-08-04 清理：addTurnSep 空操作导出已删 — 视觉分隔由 CSS 处理）

// ═══════════════════════════════════════════════════════════
// 轮次生命周期
// ═══════════════════════════════════════════════════════════

function finishCurrentTurn(ctx: StreamContext): void {
  _finaliseStreamingAssistant(ctx);
  _streamingBump(ctx);
}

export function finishTurn(ctx: StreamContext): void {
  finishCurrentTurn(ctx);
  // 并发会话：自动命名跟着轮次所属卷走（ctx.sessionId），后台卷跑完
  // 只命名自己，不再误改活跃卷标题。
  autoTitleSessionIfDefault(ctx.storeId, ctx.sessionId ?? undefined);
  const pp = ctx.getProjectPath();
  if (pp) {
    ctx.scheduleAutoSave(pp);
  }
}
