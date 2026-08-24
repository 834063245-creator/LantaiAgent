// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 聊天面板 — 会话管理（CRUD、持久化、恢复）
// 从 chat.ts 的 ChatPanel 类中提取。
// 所有函数接收 SessionContext，而非访问 `this`。

import { agentSessionState, type OwnedAgentHandle, type TurnPair } from '../agent/agent-session-state';
import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import { createExecState, type ExecStateInstance } from '../agent/execution-state';
import type { Message } from '../provider/types';
import { typedJsonRpc, typedRpc } from '../rpc-contract';
import { getActiveProvider, loadSettings } from '../settings';
import { disposeMessagesStores, disposeSessionMessagesStore } from '../state/messages-store';
import {
  clearPaperSessions,
  getPaperSessionData,
  loadPaperSessionData,
  type PaperSessionData,
  removePaperSessionData,
} from '../state/paper-store';
import {
  type LedgerIo,
  loadLedger,
  openMetaOf,
  reconcileNextSessionId,
  recordOpenSetChange,
  type SessionLedgerDisk,
} from '../state/session-ledger';
import { getWorkspaceEpoch, isCurrentEpoch } from '../workspace-scope';
import { useAgentPanelStore } from './agent-panel-store';
import { bumpSession, getChatStore, msgStoreFor } from './chat-store';
import type { AssistantMessage, ChatMessage, MessageId, SubAgentPart, UserMessage } from './message-model';
import {
  createAssistantMessage,
  createNoticeMessage,
  createUserMessage,
  nextMsgId,
  resetMsgIdCounter,
} from './message-model';
import { isSubagentSpawnTool } from './tool-semantics';

// ── 模块级会话状态 ──
//
// 纯数据存放在 chat-store.ts（会话列表、activeIdx、token、nextId）。
// 不可序列化的句柄（Agent 实例、DOM 引用、回调）保留在此处。

export interface ChatSession {
  id: number;
  label: string;
  agent: ChatAgentHandle;
}

// ── 面板级模块状态（复合键：panelId:sessionId）──
// ponytail: 原为单例 Maps/数组 — 多个 ChatPanel 实例共享同一模块级状态
// 时导致跨面板泄漏。会话 ID 在不同面板间冲突（都从 1 开始），复合键
// 可防止错误的 agent / 错误的 execState / 错误的 turnPairs 等 bug。

/** Agent 在 session 中注入的内部上下文消息（非用户输入），恢复/导出时应跳过 */
const INTERNAL_PREFIXES = ['<system-reminder>', '<goal>', '<truncated-context>', '<compacted-context>'];
function isInternalMessage(content: string | undefined): boolean {
  if (!content) return false;
  return INTERNAL_PREFIXES.some((p) => content.startsWith(p));
}

// 模块级 Maps 已迁移到 AgentSessionState（agent/agent-session-state.ts）

// ── 辅助函数：将 store 会话桥接到 ChatSession（含 agent 句柄）──

function storeSessionsWithAgents(storeId: string): ChatSession[] {
  const { sessions } = getChatStore(storeId).sess.getState();
  // biome-ignore lint/style/noNonNullAssertion: 冻结文件——store 会话建立时 agent 槽位必已注册
  return sessions.map((s) => ({ ...s, agent: agentSessionState.getAgent(storeId, s.id)! }));
}

// ── 访问器（ChatPanel 用于桥接模块状态）──

export function getSessions(storeId: string): ChatSession[] {
  return storeSessionsWithAgents(storeId);
}
export function getActiveIdx(storeId: string): number {
  return getChatStore(storeId).sess.getState().activeIdx;
}
export function getActiveAgent(storeId: string): ChatAgentHandle | null {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  const s = sessions[activeIdx];
  return s ? (agentSessionState.getAgent(storeId, s.id) ?? null) : null;
}
export function getNextSessionId(storeId: string): number {
  return getChatStore(storeId).sess.getState().nextSessionId;
}
export function setNextSessionId(storeId: string, id: number): void {
  getChatStore(storeId).sess.setState({ nextSessionId: id });
}
/** 将活跃会话的 token 计数同步到会话级映射中。 */
export function syncActiveSessionTokens(storeId: string, count: number): void {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  const s = sessions[activeIdx];
  if (s) getChatStore(storeId).sess.getState().setSessionTokens(s.id, count);
}
export function getTurnPairs(storeId: string): TurnPair[] {
  return agentSessionState.getTurnPairs(storeId);
}
export function setTurnPairs(storeId: string, pairs: TurnPair[]): void {
  agentSessionState.setTurnPairs(storeId, pairs);
}
export function getAgentFactory(storeId: string) {
  return agentSessionState.getAgentFactory(storeId);
}
export function setAgentFactory(storeId: string, fn: (() => Promise<OwnedAgentHandle | null>) | null): void {
  agentSessionState.setAgentFactory(storeId, fn);
}

/** 获取或创建会话的 execState。 */
export function getSessionExecState(storeId: string, sessionId: number): ExecStateInstance {
  return agentSessionState.getOrCreateExec(storeId, sessionId);
}

/** 检查活跃会话以外的任何会话是否有运行中的 Agent。
 *  两个 Agent 同时流式输出会导致事件交错。 */
export function hasRunningBackgroundSession(storeId: string): boolean {
  const { sessions, activeIdx } = getChatStore(storeId).sess.getState();
  for (let i = 0; i < sessions.length; i++) {
    if (i === activeIdx) continue;
    const es = agentSessionState.getExec(storeId, sessions[i].id);
    if (es?.isRunning) return true;
  }
  return false;
}

/** 清理已关闭会话的 execState。 */
export function removeSessionExecState(storeId: string, sessionId: number): void {
  agentSessionState.removeExec(storeId, sessionId);
}

/** 拆除面板全部 Agent 句柄与 exec 状态（dispose）— ChatCore.setAgent(null) 用，
 *  API Key 清空后旧 provider/工厂不得继续服务会话。 */
export function clearPanelAgents(storeId: string): void {
  agentSessionState.clearPanelState(storeId);
}

/** 拆除面板全部消息 store（面板级 + 每会话级，M4 接线）— setAgent(null)
 *  会话列表清空后，各卷消息数组不得残留在注册表（同 storeId 跨工作区
 *  复用，撞号卷会短暂复活旧消息）。 */
export function disposePanelMessages(storeId: string): void {
  disposeMessagesStores(storeId);
}

/** 全量重置 — 用于 ChatPanel 中切换工作区时的 setAgent。 */
export function resetSessionState(storeId: string, ag: OwnedAgentHandle): void {
  const id = getChatStore(storeId).sess.getState().nextSessionId;
  const label = '案卷 1';
  // 仅清除本面板的 agent 句柄和 exec 状态
  agentSessionState.clearPanelState(storeId);
  // 工作区全量重置：纸面用户层（钉住块/纸条）一并清空——旧工作区摆放不得串入新工作区
  clearPaperSessions(storeId);
  // 工作区全量重置：旧工作区全部会话级消息 store（storeId:sessionId）一并移除
  //（M4：store 注册表跨工作区存活，旧卷不拆 = 无界增长 + 新工作区撞号卷读到旧消息）
  disposeMessagesStores(storeId);
  agentSessionState.setAgent(storeId, id, ag);
  // 静态绑定该 Agent 的 board 到此会话 — 此后不再随会话切换重定向
  ag.bindSession?.(String(id));
  agentSessionState.setExec(storeId, id, createExecState());
  getChatStore(storeId).sess.setState({
    sessions: [{ id, label }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: id + 1,
  });
  // 全新会话树 —— 清空一切旧草稿槽与 live 输入，会话 id 已变化
  getChatStore(storeId).input.getState().clearSessionDrafts();
  // ponytail: 创建会话级消息 store — 唯一数据源
  msgStoreFor(storeId, id).getState().setMessages([]);
  setTurnPairs(storeId, []);
}

/** 若活跃会话仍为默认标签（"案卷 N"，兼容旧 "会话 N"），则从第一条用户消息自动命名。
 *  在每轮对话完成后调用。 */
export function autoTitleSessionIfDefault(storeId: string): void {
  const st = getChatStore(storeId).sess.getState();
  const { sessions, activeIdx } = st;
  const s = sessions[activeIdx];
  if (!s) return;

  // 仅在标签仍为默认格式时自动命名（兰台术语：案卷；旧存档：会话）
  if (!/^(?:会话|案卷) \d+$/.test(s.label)) return;

  const agent = agentSessionState.getAgent(storeId, s.id);
  if (!agent) return;

  const msgs = agent.getSession();
  const firstUser = msgs.find((m) => m.role === 'user' && m.content && !m.content.startsWith('<compacted-context>'));
  if (!firstUser?.content) return;

  const derived = firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '');
  const updated = sessions.map((x, i) => (i === activeIdx ? { ...x, label: derived } : x));
  getChatStore(storeId).sess.setState({ sessions: updated });
}

// ── SessionContext — 独立会话函数与 ChatPanel 状态之间的桥接 ──

export interface SessionContext {
  storeId: string;

  // DOM 元素
  panel: HTMLElement;
  sessionTabs: HTMLElement;
  tabBar: HTMLElement;

  getProjectPath: () => string;

  // 流式辅助
  flushReasoning: () => void;
  flushText: () => void;
  clearPendingToolCards: () => void;

  // 运行状态
  getRunning: () => boolean;
  abort: () => void;

  // 通知与底栏
  addNotice: (text: string, level?: 'info' | 'warn' | 'error') => void;
  updateFooter: () => void;

  // Token 用量
  getTotalTokensUsed: () => number;
  setTotalTokensUsed: (n: number) => void;
  clearToolUsage: () => void;
  clearToolHistory: () => void;

  getLastUsageText: () => string;
  setLastUsageText: (s: string) => void;
  getLastAgentDiag: () => string;

  clearInputHistory: () => void;
  getStarGraph: () => import('./graph').StarGraph | null;

  /** 运行时访问，用于会话级 board 切换 */
  getRuntime?: () => import('../agent/runtime/types').RuntimePort | null;
}

// ── 辅助函数 ──

/** djb2 哈希，用于项目路径 → localStorage 键隔离。 */
export function hashProjectPath(projectPath: string): number {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = (hash << 5) - hash + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/** 去除 read_file_content 的 cat -n 行号。Rust 后端始终返回
 *  "{:>6}\t{content}" 格式。会话 JSON 文件在解析前需去除行号。 */
export function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

// ── 会话 CRUD ──

export function switchSession(ctx: SessionContext, idx: number): void {
  const storeId = ctx.storeId;
  const st = getChatStore(storeId).sess.getState();
  const { sessions, activeIdx } = st;
  if (idx === activeIdx || idx < 0 || idx >= sessions.length) return;

  // 先把当前活跃会话的输入草稿存回其会话槽，再把目标会话的草稿恢复到输入框。
  // 输入框 live 状态始终只属于活跃会话 —— 这样切 tab 时未发送的文字留在原会话，
  // 不会"漂移"到另一个会话的输入框。
  if (activeIdx >= 0) {
    getChatStore(storeId).sess.getState().setSessionTokens(sessions[activeIdx].id, ctx.getTotalTokensUsed());
    getChatStore(storeId).input.getState().saveSessionDraft(sessions[activeIdx].id);
  }
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  getChatStore(storeId).sess.setState({ activeIdx: idx });
  getChatStore(storeId).input.getState().restoreSessionDraft(sessions[idx].id);

  // 切换会话级 board 到新会话
  const newSessionId = String(sessions[idx].id);
  const runtime = ctx.getRuntime?.();
  if (runtime) {
    runtime.setCurrentSession(newSessionId);
    useAgentPanelStore.getState().setCurrentSessionId(newSessionId);
  }

  // 恢复目标会话的 token 计数
  ctx.setTotalTokensUsed(st.sessionTokens[sessions[idx].id] || 0);
  ctx.setLastUsageText('');
  ctx.updateFooter();
  // 账本记账（L0）：活跃指针变更 → 总目投影落盘
  recordOpenSetChange(ctx.storeId, ctx.getProjectPath(), ledgerIo);
  // L0 惰性水合：切到无句柄的卷 → 按需补建（fire-and-forget；失败留
  // sendMessage 的同步唤起兜底，这里不拦换卷交互）
  const switchedSid = sessions[idx].id;
  if (!agentSessionState.getAgent(ctx.storeId, switchedSid)) {
    void ensureSessionAgent(ctx).then((ok) => {
      if (!ok) ctx.addNotice('卷的 Agent 未就绪（API Key 未配置？）——拟文时会再试', 'warn');
    });
  }
}

/** L0 惰性水合（session-ledger）：重启恢复后惰性卷的 Agent 句柄缺席。
 *  本卷被切到/拟文时按需补建：factory 现调 + 会话内容从会话级 msgStore
 *  回填 + exec/board 绑定。已有句柄 = no-op（返回 true）。
 *  返回 false = 无法补建（无工厂/工厂返回空——调用方走「Agent 未就绪」提示）。
 *  代际防护（H5）：补建在途切工作区 → 丢弃不写 store。 */
export async function ensureSessionAgent(ctx: SessionContext): Promise<boolean> {
  const st = getChatStore(ctx.storeId).sess.getState();
  const sid = st.sessions[st.activeIdx]?.id;
  if (sid == null) return false;
  if (agentSessionState.getAgent(ctx.storeId, sid)) return true;

  const factory = getAgentFactory(ctx.storeId);
  if (!factory) return false;
  const epoch = getWorkspaceEpoch();
  const agent = await factory();
  if (!agent) return false;
  if (!isCurrentEpoch(epoch)) return false;

  // 会话内容回填：msgStore 的 ChatMessage 不是 provider 消息——从磁盘卷文件
  // 取原始会话（readVolumeData 与恢复路径同源：磁盘权威 + localStorage 较新
  // 回退 + 已删/空卷过滤）。projectPath=''（零目录会话）同样回填——
  // sessionFile('') 路由用户级目录（Phase B）。
  let conv: Message[] = [];
  try {
    const data = await readVolumeData(ctx.getProjectPath(), sid);
    if (data) {
      conv = (data.messages as Message[])?.filter((m) => m.role !== 'system') ?? [];
    }
  } catch {
    /* 卷文件缺失/读失败 → 空会话起步（新卷语义） */
  }
  if (!isCurrentEpoch(epoch)) return false;

  const freshSys = agent.getSession().filter((m: Message) => m.role === 'system');
  agent.setSession([...freshSys, ...conv]);

  // 二次校验句柄仍缺席（在途期间可能被并行的另一路径补建/移除）
  if (agentSessionState.getAgent(ctx.storeId, sid)) {
    agent.dispose();
    return true;
  }
  agentSessionState.setAgent(ctx.storeId, sid, agent);
  agent.bindSession?.(String(sid));
  agentSessionState.setExec(ctx.storeId, sid, createExecState());
  // turnPairs 与 UI 消息已由 restoreFromLedger 的 rebuildMessagesFromMessages
  // 预填——无需重建（惰性卷内容层恢复时已做）。
  return true;
}

export function closeSession(ctx: SessionContext, idx: number): void {
  const st = getChatStore(ctx.storeId).sess.getState();
  if (st.sessions.length <= 1) {
    ctx.addNotice('至少保留一卷案卷', 'info');
    return;
  }
  const s = st.sessions[idx];
  // C8 合卷自动存：被合卷在 agent dispose 前同步捕获快照、异步落盘（用户拍板）。
  // 数据捕获必须在 removeAgent 之前（句柄消亡后 getSession 不可再得）；
  // 写入目标路径在捕获时固定，无跨工作区串写风险（与 scheduleAutoSave 的
  // epoch 守卫防护面不同——那是延迟重读 store 的风险，这里快照即定局）。
  {
    const agent = agentSessionState.getAgent(ctx.storeId, s.id);
    const messages = agent?.getSession();
    const hasContent = !!messages?.some((m) => m.role !== 'system');
    if (agent && messages && hasContent) {
      const projectPath = ctx.getProjectPath();
      const tokensUsed = idx === st.activeIdx ? ctx.getTotalTokensUsed() : (st.sessionTokens[s.id] ?? 0);
      // 纸面用户层快照与消息同点捕获（合卷后 paper store 该卷数据随即清除）
      const paper = getPaperSessionData(ctx.storeId, s.id);
      writeSessionSnapshot(projectPath, {
        id: s.id,
        label: s.label,
        savedAt: new Date().toISOString(),
        messages,
        tokensUsed,
        paper,
      }).catch(() => ctx.addNotice(`合卷落盘失败：${s.label}`, 'error'));
    }
  }
  removeSessionExecState(ctx.storeId, s.id);
  agentSessionState.removeAgent(ctx.storeId, s.id);
  // 合卷 = 卷消亡：paper store 该卷数据随之清除（快照已在上方捕获落盘）
  removePaperSessionData(ctx.storeId, s.id);
  // 合卷 = 卷消亡：该卷会话级消息 store 一并移除（M4——落盘快照已在上方
  // 从 agent 数据同步捕获，此处拆的是注册表项；续开该卷走磁盘恢复重建）
  disposeSessionMessagesStore(ctx.storeId, s.id);
  // 若关闭的是活跃会话，先把它未发送的文字存入其槽再清空，稍后换入新活跃会话的草稿
  const closingActive = idx === st.activeIdx;
  if (closingActive) {
    getChatStore(ctx.storeId).input.getState().saveSessionDraft(s.id);
  }
  // 丢弃被关闭会话的输入草稿槽 —— 关闭后不应再残留其未发送文字
  getChatStore(ctx.storeId).input.getState().clearSessionDraft(s.id);

  const newSessions = [...st.sessions];
  newSessions.splice(idx, 1);
  // 调整 activeIdx：若关闭的会话在活跃会话之前，则左移；
  // 若关闭的是活跃会话，则下一个会话变为活跃（或钳制）。
  let newIdx = st.activeIdx;
  if (idx < st.activeIdx) newIdx = st.activeIdx - 1;
  if (newIdx >= newSessions.length) newIdx = newSessions.length - 1;
  if (newIdx < 0) newIdx = 0;

  // 在销毁旧 board 之前将面板指向新活跃会话 —
  // 已关闭会话的 Agent 已在上方 dispose（removeAgent），其 proxies 随句柄消亡；
  // 静态绑定下不存在指向已销毁 board 的残留 proxy，destroy 不会复活文件。
  const runtime = ctx.getRuntime?.();
  const newSessionId = String(newSessions[newIdx].id);
  if (runtime) {
    runtime.setCurrentSession(newSessionId);
    useAgentPanelStore.getState().setCurrentSessionId(newSessionId);
  }

  getChatStore(ctx.storeId).sess.setState({ sessions: newSessions, activeIdx: newIdx });
  // 关闭的是原活跃会话 → 新的活跃会话换其草稿到输入框（s.id 槽已被清空，不会留下旧文字）
  if (closingActive) {
    getChatStore(ctx.storeId).input.getState().restoreSessionDraft(newSessions[newIdx].id);
  }
  // ponytail: 无需 restoreMessages — React 自动从会话级 store 读取
  ctx.updateFooter();

  // 现在销毁已关闭会话的 board（尽力而为，异步触发）
  if (runtime) {
    runtime.destroySessionBoards(String(s.id)).catch(() => {});
  }

  const projectPath = ctx.getProjectPath();
  if (projectPath) {
    scheduleAutoSave(ctx, projectPath);
  }
  // 账本记账（L0）：open 集缩减 → 总目投影落盘（在 scheduleAutoSave 之后，
  // 避免与活跃卷快照写盘交错——总目只记开合，无字段竞争）
  recordOpenSetChange(ctx.storeId, projectPath, ledgerIo);
}

export async function createNewSession(ctx: SessionContext): Promise<void> {
  const factory = getAgentFactory(ctx.storeId);
  if (!factory) {
    const extra = ctx.getLastAgentDiag() ? `\n诊断: ${ctx.getLastAgentDiag()}` : '';
    ctx.addNotice(`请先配置 API Key（设置 → Provider）${extra}`, 'info');
    return;
  }
  const newAgent = await factory();
  if (!newAgent) {
    ctx.addNotice('无法创建案卷: Agent 工厂返回空', 'error');
    return;
  }
  const st = getChatStore(ctx.storeId).sess.getState();
  // ponytail: 消息在会话级 store 中 — 无需保存/恢复。
  // 只需保存旧会话的 token 计数。
  if (st.activeIdx >= 0) {
    const oldSid = st.sessions[st.activeIdx].id;
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(oldSid, ctx.getTotalTokensUsed());
    // 把旧会话的输入草稿存回其会话槽 —— 新建会话后切回旧 tab 时文字仍在
    getChatStore(ctx.storeId).input.getState().saveSessionDraft(oldSid);
  }
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  const id = st.nextSessionId;
  const label = `案卷 ${st.sessions.length + 1}`;
  agentSessionState.setAgent(ctx.storeId, id, newAgent);
  // 静态绑定该 Agent 的 board 到新会话（id 在 factory 之后才确定）
  newAgent.bindSession?.(String(id));
  agentSessionState.setExec(ctx.storeId, id, createExecState());
  getChatStore(ctx.storeId).sess.setState({
    sessions: [...st.sessions, { id, label }],
    activeIdx: st.sessions.length,
    nextSessionId: id + 1,
  });
  // ponytail: 创建会话级消息 store — 唯一数据源
  msgStoreFor(ctx.storeId, id).getState().setMessages([]);
  resetMsgIdCounter();
  ctx.clearInputHistory();
  // 新会话无草稿槽 → 清空 live 输入，避免沿用上一会话未发送的文字
  getChatStore(ctx.storeId).input.getState().restoreSessionDraft(id);
  setTurnPairs(ctx.storeId, []);
  ctx.setTotalTokensUsed(0);
  getChatStore(ctx.storeId).sess.getState().setSessionTokens(id, 0);

  // 切换会话级 board 到新会话
  const runtime = ctx.getRuntime?.();
  if (runtime) {
    runtime.setCurrentSession(String(id));
    useAgentPanelStore.getState().setCurrentSessionId(String(id));
  }

  ctx.addNotice(`新案卷已创建 — 案卷 ${st.sessions[st.activeIdx]?.label ?? ''} 仍在后台运行`, 'info');
  ctx.setLastUsageText('');
  ctx.updateFooter();
  // 账本记账（L0）：摊开集变更 → 总目投影落盘（尽力而为，失败可见于 console）
  recordOpenSetChange(ctx.storeId, ctx.getProjectPath(), ledgerIo);
}

// ── 会话持久化 — 每个会话一个文件，localStorage 备份 ──

/** 会话文件的持久化形状（磁盘 JSON / localStorage 备份）。
 *  paper（钉住块坐标 + 纸条，2026-08-24 收尾）：可选字段，旧存档无此字段 = 空纸面。 */
interface StoredSession {
  id: number;
  label?: string;
  savedAt?: string;
  messages?: Message[];
  tokensUsed?: number;
  paper?: PaperSessionData;
  deleted?: boolean;
  /** _active.json 跟踪文件字段（与单个会话文件形状不同） */
  lastId?: number;
  nextId?: number;
}

/** list_directory 返回的目录项。 */
interface DirectoryEntry {
  name: string;
  path: string;
  is_dir?: boolean;
}

/** 读取会话文件并解析为 JSON。处理 read_file_content 的行号。 */
async function readSessionJSON(filePath: string): Promise<StoredSession> {
  const raw = await typedRpc('read_file_content', { file_path: filePath });
  return JSON.parse(stripLineNumbers(raw)) as StoredSession;
}

function lsKey(projectPath: string, id: number): string {
  return `hologram_session_${hashProjectPath(projectPath).toString(36)}_${id}`;
}

// ── 零目录会话路由（workspace-flip 批 2，D-W1-1/D-W1-2）─────────────
// 占位工作区 projectPath='' 的会话落盘到用户级目录（~/.lantai/sessions/
// ——get_user_sessions_dir RPC 真源）。缓存经 ensureUserSessionsDir()
// 解析（setupPlaceholderAgent / SessionsHome 装配点调用）；未解析时的
// 兜底路径 '/.lantai/sessions' 与旧行为一致（写入失败可见于 console）。
let _userSessionsDir: string | null = null;

/** 解析用户级会话目录（幂等；零目录会话装配点调用一次）。 */
export async function ensureUserSessionsDir(): Promise<void> {
  if (_userSessionsDir !== null) return;
  try {
    _userSessionsDir = await typedRpc('get_user_sessions_dir', {});
  } catch (e) {
    console.error('[chat] get_user_sessions_dir 解析失败（零目录会话不落盘）:', e);
    _userSessionsDir = '/.lantai/sessions'; // 显式兜底（与旧行为一致——不静默改道）
  }
}

/** 测试复位（生产不调用）。 */
export function _resetUserSessionsDirForTests(): void {
  _userSessionsDir = null;
}

function sessionsDir(projectPath: string): string {
  if (projectPath === '') {
    // 零目录会话：路由用户级目录（缓存未就绪 = 旧兜底路径，ensure 已在装配点调用）
    return _userSessionsDir ?? '/.lantai/sessions';
  }
  return `${projectPath.replace(/\\/g, '/')}/.lantai/sessions`;
}

function sessionFile(projectPath: string, id: number): string {
  return `${sessionsDir(projectPath)}/${id}.json`;
}

function trackerFile(projectPath: string): string {
  return `${sessionsDir(projectPath)}/_active.json`;
}

/** 账本 IO 适配器：把 typedRpc 通道装进 session-ledger（依赖注入——
 *  账本模块不得反向 import 本文件，避免循环依赖）。 */
const ledgerIo: LedgerIo = {
  readFile: async (path) => typedRpc('read_file_content', { file_path: path }),
  writeFile: async (path, content) => {
    await typedRpc('write_file_content', { file_path: path, content });
  },
};

/** 扫描会话目录，查找最大的数字会话 ID。无会话时返回 0。 */
export async function scanMaxSessionId(projectPath: string): Promise<number> {
  try {
    const parsed: unknown = await typedJsonRpc('list_directory', {
      path: sessionsDir(projectPath),
      filter_ignored: false,
    });
    if (!Array.isArray(parsed)) return 0;
    const entries = parsed as DirectoryEntry[];
    let maxId = 0;
    for (const e of entries) {
      if (e.is_dir || !e.name || e.name === '_active.json') continue;
      const sid = parseInt(String(e.name).replace(/\.json$/, ''), 10);
      if (!Number.isNaN(sid) && sid > maxId) maxId = sid;
    }
    return maxId;
  } catch {
    return 0;
  }
}

/** 会话快照的磁盘形状（C8：saveActiveSession 与合卷落盘共用）。
 *  paper：纸面用户层状态（钉住块 + 纸条）——2026-08-24 收尾接入持久化。 */
interface SessionSnapshotData {
  id: number;
  label: string;
  savedAt: string;
  messages: Message[];
  tokensUsed: number;
  paper?: PaperSessionData;
}

/** 将已捕获的会话快照写入盘（localStorage 同步备份 + 原子磁盘写）。
 *  C8 合卷自动存从 saveActiveSession 离体出来的共享写盘函数——调用方负责
 *  在 agent 句柄消亡前完成数据捕获（messages 属引用，序列化在首次 await 前）。
 *  失败：console.error 后上抛——调用方决定可见等级（autosave 容忍、合卷告警）。 */
async function writeSessionSnapshot(projectPath: string, data: SessionSnapshotData): Promise<void> {
  const json = JSON.stringify(data);
  // 1) 同步 localStorage 备份 — 可在 beforeunload 超时/进程被杀时存活
  try {
    if (typeof localStorage !== 'undefined') {
      // P0-9：配额共 5~10MB 且与设置等键共享——超大会话备份直接跳过，
      // 磁盘写入（下一步）才是真正的兜底，localStorage 只是加速器
      if (json.length < 1024 * 1024) {
        localStorage.setItem(lsKey(projectPath, data.id), json);
      }
    }
  } catch {
    /* 超出配额 — 磁盘写入作为兜底 */
  }

  // 2) 异步磁盘写入（原子操作：tmp → rename）
  try {
    await typedRpc('write_file_content', {
      file_path: sessionFile(projectPath, data.id),
      content: json,
    });
  } catch (e) {
    console.error('[chat] 会话落盘失败:', e);
    throw e;
  }
}

/** 将活跃会话保存到其独立文件。
 *  同时写入同步 localStorage 备份，确保会话在应用崩溃/强制关闭后仍可恢复。
 *  projectPath=''（零目录会话，单槽统一 2026-08-24）合法——sessionsDir('')
 *  路由用户级目录，与 loadSessionFromDisk(projectPath='') 的读取侧同构。
 *  L3（session-ledger）：_active.json 跟踪器写入退役——总目 _ledger.json
 *  已接任（四动词 recordOpenSetChange 维护；发号对账 max(mem, ledger, scan)）。
 *  旧 tracker 仅作无总目冷启动的迁移源读一次，不再更新。 */
export async function saveActiveSession(ctx: SessionContext, projectPath: string): Promise<void> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  if (activeIdx < 0) return;
  const sMeta = sessions[activeIdx];
  if (!sMeta) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sMeta.id);
  if (!agent) return;

  const messages = agent.getSession();
  // 不持久化空会话（仅系统提示，无用户消息）
  if (!messages.some((m) => m.role !== 'system')) return;

  // ponytail: 消息已在会话级 store 中 — 无需 saveCurrentMessages
  getChatStore(ctx.storeId).sess.getState().setSessionTokens(sMeta.id, ctx.getTotalTokensUsed());

  const data: SessionSnapshotData = {
    id: sMeta.id,
    label: sMeta.label,
    savedAt: new Date().toISOString(),
    messages,
    tokensUsed: ctx.getTotalTokensUsed(),
    // 纸面用户层（钉住块 + 纸条）随卷落盘——快照捕获与 messages 同步时点
    paper: getPaperSessionData(ctx.storeId, sMeta.id),
  };

  try {
    await writeSessionSnapshot(projectPath, data);
  } catch {
    /* 落盘失败已由 writeSessionSnapshot 记日志——autosave 链容忍（原行为） */
  }

  // L3：tracker 写入退役（见函数头注释）——开合与发号归总目
}

/** 按 id 落盘指定会话（C8 改名即存）：不要求是活跃卷，不动 _active.json
 *  （跟踪器只记「冷启动恢复谁」，与单卷落盘无关）。projectPath='' 零目录
 *  会话路由用户级目录（sessionsDir 真源）。空卷跳过（与 saveActiveSession 同规）。 */
export async function saveSessionById(ctx: SessionContext, projectPath: string, sid: number): Promise<void> {
  const st = getChatStore(ctx.storeId).sess.getState();
  const sMeta = st.sessions.find((x) => x.id === sid);
  if (!sMeta) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sid);
  if (!agent) return;
  const messages = agent.getSession();
  if (!messages.some((m) => m.role !== 'system')) return;

  const isActive = st.sessions[st.activeIdx]?.id === sid;
  const tokensUsed = isActive ? ctx.getTotalTokensUsed() : (st.sessionTokens[sid] ?? 0);
  try {
    await writeSessionSnapshot(projectPath, {
      id: sMeta.id,
      label: sMeta.label,
      savedAt: new Date().toISOString(),
      messages,
      tokensUsed,
      // 纸面用户层随卷落盘（改名即存路径与活跃卷同构）
      paper: getPaperSessionData(ctx.storeId, sid),
    });
  } catch {
    /* 已记日志——改名即存是尽力而为（合卷路径另有告警） */
  }
}

// ═══════════════════════════════════════════════════════════════
// 防抖自动保存 — 将密集的保存触发合并为
// 每 500ms 窗口内一次写入。显式保存（失活、设置
// 重新初始化）应直接调用 saveActiveSession。
// ═══════════════════════════════════════════════════════════════

const _autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AUTO_SAVE_DELAY_MS = 500;

export function scheduleAutoSave(ctx: SessionContext, projectPath: string): void {
  const existing = _autoSaveTimers.get(ctx.storeId);
  if (existing) clearTimeout(existing);
  // 代际防护（H5）：延迟触发时若已切换工作区则不写 — 堵「新会话写进旧项目目录」。
  const epoch = getWorkspaceEpoch();
  const timer = setTimeout(() => {
    _autoSaveTimers.delete(ctx.storeId);
    if (!isCurrentEpoch(epoch)) return;
    saveActiveSession(ctx, projectPath).catch(() => {});
  }, AUTO_SAVE_DELAY_MS);
  _autoSaveTimers.set(ctx.storeId, timer);
}

/** 增量追加最后一条用户/助手消息到后端 NDJSON。
 *  在 chat:turn-done 时调用 — 确保大部分消息在 beforeunload 触发前
 *  已写入磁盘，减少对同步 localStorage 保存的依赖。
 *  projectPath=''（零目录会话）在此早退——Rust session_append 对空路径会
 *  写出相对路径（.lantai/sessions 落到进程 CWD），零目录会话的增量链由
 *  scheduleAutoSave → saveActiveSession 的全量快照承担。 */
export async function appendLastMessage(ctx: SessionContext, projectPath: string): Promise<void> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  if (!projectPath || activeIdx < 0) return;
  const sMeta = sessions[activeIdx];
  if (!sMeta) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sMeta.id);
  if (!agent) return;
  const messages = agent.getSession();
  // 查找最后一条非系统消息
  const last = [...messages].reverse().find((m) => m.role !== 'system');
  if (!last?.content) return;
  if (isInternalMessage(last.content)) return;
  try {
    await typedRpc('session_append', {
      path: projectPath,
      session_id: String(sMeta.id),
      message: {
        role: last.role,
        content: typeof last.content === 'string' ? last.content : JSON.stringify(last.content),
      },
    });
  } catch {
    /* best-effort — saveActiveSession 兜底 */
  }
}

/** 内容层兜底卷（Phase B，2026-08-24 工作区归属根治）：无历史可恢复时建一卷
 *  无句柄的「案卷 N」——会话列表恒非空（会话存在性脱离 Agent 装配），句柄由
 *  ensureSessionAgent 在拟文时补建。已有卷在案则 no-op（不清用户现场）。 */
function ensureBaselineSession(ctx: SessionContext): void {
  const st = getChatStore(ctx.storeId).sess.getState();
  if (st.sessions.length > 0) return;
  const id = Math.max(1, st.nextSessionId);
  getChatStore(ctx.storeId).sess.setState({
    sessions: [{ id, label: `案卷 ${id}` }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: id + 1,
  });
  msgStoreFor(ctx.storeId, id).getState().setMessages([]);
  setTurnPairs(ctx.storeId, []);
}

/** 恢复项目打开时最后活跃的会话。
 *  优先读总目（L0：多卷工作集恢复——摊开集整回，活跃卷按总目指针），
 *  无总目时回退旧单卷逻辑（_active.json / localStorage，行为不变）。
 *  Phase B（2026-08-24 工作区归属根治）：会话存在性脱离 Agent 装配——不再以
 *  工厂在场为前置（恢复内容层不需要 Agent），projectPath=''（零目录会话）
 *  同样恢复（sessionsDir('') 路由用户级目录）。所有卷只恢复内容层，句柄由
 *  ensureSessionAgent 在拟文/换卷时按需补建。 */
export async function autoRestoreLastSession(ctx: SessionContext, projectPath: string): Promise<void> {
  // 代际防护（H5）：恢复在途期间可能切换工作区 — 写入前校验，过期整段放弃，
  // 防把旧项目的会话状态写进新项目面板。
  const epoch = getWorkspaceEpoch();

  // ── L0 总目路径：有账本 → 多卷工作集恢复；无账本 → 旧单卷路径
  //    （恢复成功后 recordOpenSetChange 写出首份总目，迁移自然完成）
  const { ledger } = await loadLedger(projectPath, ledgerIo);
  if (ledger && ledger.open.length > 0) {
    await restoreFromLedger(ctx, projectPath, ledger, epoch);
    return;
  }

  let curNextId = getChatStore(ctx.storeId).sess.getState().nextSessionId;

  // ── 解析最后会话 ID ──
  let lastId = 0;
  // 1) 跟踪文件
  try {
    const t = await readSessionJSON(trackerFile(projectPath));
    lastId = t.lastId || 0;
    const trackerNextId = t.nextId || lastId + 1 || 1;
    curNextId = Math.max(curNextId, trackerNextId);
  } catch {
    /* 跟踪文件缺失 — 尝试下方 localStorage 扫描 */
  }

  // 2) 若跟踪文件缺失，扫描 localStorage 中本工作区最新的会话
  if (!lastId && typeof localStorage !== 'undefined') {
    const wsPrefix = lsKey(projectPath, 0).replace(/_0$/, '_');
    let newestTs = '';
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(wsPrefix)) continue;
      try {
        // biome-ignore lint/style/noNonNullAssertion: 冻结文件——key 由 localStorage 枚举而来，读取必命中
        const d = JSON.parse(localStorage.getItem(key)!);
        if (d.id && !d.deleted && d.savedAt > newestTs) {
          newestTs = d.savedAt;
          lastId = d.id;
        }
      } catch {
        /* 跳过损坏条目 */
      }
    }
    if (lastId) {
      // P1-14: 复活守卫 — localStorage 候选必须对应磁盘上存在的未删除会话。
      // 已删会话的磁盘文件是 {deleted:true, savedAt:''}，仅剩 localStorage 残留时
      // 旧代码会选中它 → 已删会话「复活」。磁盘是权威，localStorage 只是加速器。
      const candidateId = lastId;
      let diskValid = false;
      try {
        const disk = await readSessionJSON(sessionFile(projectPath, candidateId));
        diskValid = !!disk && !disk.deleted;
      } catch {
        /* 磁盘文件不存在 */
      }
      if (!diskValid) {
        lastId = 0;
        // 顺手清理残留备份，避免下次打开再次选中
        try {
          localStorage.removeItem(lsKey(projectPath, candidateId));
        } catch {
          /* 忽略 */
        }
      }
    }
    if (lastId) curNextId = lastId + 1;
  }
  if (!lastId) {
    getChatStore(ctx.storeId).sess.setState({ nextSessionId: 1 });
    ctx.addNotice('未找到历史案卷，已新建案卷', 'info');
    // Phase B：真的建卷（旧版只提示——它依赖 setAgent 已预建「案卷 1」的前提，
    // 该前提随会话存在性解耦退役）
    ensureBaselineSession(ctx);
    return;
  }

  // ── 加载会话数据（优先文件，回退 localStorage）──
  let data: StoredSession | null = null;
  // 1) 尝试磁盘文件
  try {
    data = await readSessionJSON(sessionFile(projectPath, lastId));
  } catch {
    /* 文件缺失 — 尝试 localStorage */
  }

  // 2) localStorage 回退（若 beforeunload 保存未完成，可能比文件更新）
  if (typeof localStorage !== 'undefined') {
    const lsRaw = localStorage.getItem(lsKey(projectPath, lastId));
    if (lsRaw) {
      try {
        const lsData = JSON.parse(lsRaw) as StoredSession;
        // P1-14: 复活守卫 — 仅当磁盘文件有效（存在且未标记删除）时才允许
        // localStorage 覆盖。已删会话磁盘文件是 {deleted:true, savedAt:''}，
        // 旧代码因 !data?.savedAt 采纳 localStorage 残留 → 会话复活。
        if (data && !data.deleted && (!data.savedAt || (lsData.savedAt && lsData.savedAt > data.savedAt))) {
          data = lsData;
        }
      } catch {
        /* localStorage 条目损坏 */
      }
    }
  }
  if (!data?.messages || data.messages.length === 0) {
    ctx.addNotice('历史案卷数据为空，已新建案卷', 'info');
    // Phase B：真的建卷（同上——内容层兜底，句柄拟文时补建）
    ensureBaselineSession(ctx);
    return;
  }

  // ponytail: 若跟踪的会话无用户消息（仅有系统提示），
  // 扫描 localStorage 查找有实际对话的会话（不依赖后端）
  {
    const convMsgs = data.messages.filter((m) => m.role !== 'system');
    if (convMsgs.length === 0 && typeof localStorage !== 'undefined') {
      const wsPrefix = lsKey(projectPath, 0).replace(/_0$/, '_');
      let bestId = 0;
      let bestTs = '';
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(wsPrefix)) continue;
        try {
          // biome-ignore lint/style/noNonNullAssertion: 冻结文件——key 由 localStorage 枚举而来，读取必命中
          const d = JSON.parse(localStorage.getItem(key)!) as StoredSession;
          if (d.id && !d.deleted && (d.savedAt ?? '') > bestTs) {
            // 快速检查：是否有非系统消息？
            const hasConv = (d.messages ?? []).some((m) => m.role !== 'system');
            if (hasConv) {
              bestTs = d.savedAt ?? '';
              bestId = d.id;
            }
          }
        } catch {
          /* 跳过 */
        }
      }
      if (bestId > 0 && bestId !== lastId) {
        // P1-14: 复活守卫 — localStorage 中的会话必须对应磁盘上的未删除文件，
        // 否则已删会话（仅剩 localStorage 残留）会在此复活。
        try {
          const disk = await readSessionJSON(sessionFile(projectPath, bestId));
          if (disk && !disk.deleted) {
            const lsRaw = localStorage.getItem(lsKey(projectPath, bestId));
            if (lsRaw) {
              data = JSON.parse(lsRaw) as StoredSession;
              lastId = bestId;
            }
          }
        } catch {
          /* 磁盘文件不存在 → 不采纳 */
        }
      }
    }
  }

  // 代际防护（H5）：恢复在途期间已切换工作区 — 丢弃本次恢复，不写任何 store。
  if (!isCurrentEpoch(epoch)) return;

  const conv = (data.messages as Message[]).filter((m) => m.role !== 'system');
  const curSt = getChatStore(ctx.storeId).sess.getState();
  // ponytail: 消息在会话级 store 中 — 无需 saveCurrentMessages
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();

  const label = data.label || '已恢复的案卷';
  agentSessionState.clearPanelState(ctx.storeId);
  getChatStore(ctx.storeId).sess.setState({
    sessions: [{ id: data.id, label }],
    activeIdx: 0,
    sessionTokens: { [data.id]: data.tokensUsed ?? 0 },
    nextSessionId: Math.max(curNextId, curSt.nextSessionId),
  });
  // 恢复会话是全新会话树 —— 清空残留草稿与 live 输入（未发送文字不跨重启保留）
  getChatStore(ctx.storeId).input.getState().clearSessionDrafts();
  // Phase B：内容层直接从恢复数据重建（msgStore + turnPairs）——恢复不依赖
  // Agent 句柄；句柄留给 ensureSessionAgent 按需补建（拟文/换卷时）
  rebuildMessagesFromMessages(conv, ctx.storeId, data.id);
  // 纸面用户层（钉住块 + 纸条）随卷恢复——旧存档无 paper 字段 = 空纸面
  loadPaperSessionData(ctx.storeId, data.id, data.paper ?? null);

  ctx.setLastUsageText('');
  ctx.updateFooter();
  // 活跃卷句柄后台补建（保持「活跃卷有句柄」的既有 UX——导出/改名即存等
  // 消费路径需要；失败可见但不清会话，拟文时 sendMessage 兜底再试）
  void ensureSessionAgent(ctx).then((ok) => {
    if (!ok) ctx.addNotice('卷的 Agent 未就绪（API Key 未配置？）——拟文时会再试', 'warn');
  });
  // 自然迁移收尾（L0）：旧单卷路径恢复成功 → 首次写总目（此后 _active.json 退休）
  recordOpenSetChange(ctx.storeId, projectPath, ledgerIo);
}

// ── L0 总目多卷恢复（session-ledger-plan §3.3）─────────────────────

/** 恢复路径的卷数据（磁盘优先，localStorage 回退——与旧单卷路径同规）。 */
async function readVolumeData(projectPath: string, id: number): Promise<StoredSession | null> {
  let data: StoredSession | null = null;
  try {
    data = await readSessionJSON(sessionFile(projectPath, id));
  } catch {
    /* 文件缺失 — 尝试 localStorage */
  }
  if (typeof localStorage !== 'undefined') {
    const lsRaw = localStorage.getItem(lsKey(projectPath, id));
    if (lsRaw) {
      try {
        const lsData = JSON.parse(lsRaw) as StoredSession;
        // P1-14 复活守卫同规：localStorage 仅在磁盘文件有效时可采纳
        if (data && !data.deleted && (!data.savedAt || (lsData.savedAt && lsData.savedAt > data.savedAt))) {
          data = lsData;
        }
      } catch {
        /* localStorage 条目损坏 */
      }
    }
  }
  if (!data || data.deleted) return null;
  // 空卷（无任何非系统消息）不进摊开集——与「空卷不落盘」同规，
  // 避免重启后摊开集里出现只有系统提示的尸体卷。
  if (!data.messages?.some((m) => m.role !== 'system')) return null;
  return data;
}

/** 卷名候选：卷文件 label 优先，总目 label 兜底，都无 → 案卷 N。 */
function restoredLabel(data: StoredSession, fallback: string | undefined, ordinal: number): string {
  if (
    data.label &&
    !/^(?:会话|案卷) \d+$/.test(data.label) &&
    data.label !== '已恢复的会话' &&
    data.label !== '已恢复的案卷'
  ) {
    return data.label;
  }
  if (fallback) return fallback;
  return `案卷 ${ordinal}`;
}

/**
 * 总目多卷恢复（L0 核心）：摊开集整回，全部卷惰性。
 *
 * Phase B（2026-08-24 工作区归属根治）：**所有卷（含活跃卷）只恢复「内容层」**
 * （messages 重建到会话级 msgStore + 纸面摆放 + 元数据入 sess store），不建
 * Agent 句柄——恢复不再依赖工厂在场/工厂成功。活跃卷句柄在内容恢复后由
 * ensureSessionAgent 后台补建（保持「活跃卷有句柄」的既有 UX）；其余卷在
 * 该卷被切到/拟文时按需补建（factory 现调，会话内容从磁盘回填）。
 * 摊开集大时避免「摊 20 卷 = 起 20 个 Agent」。
 *
 * 失败容忍：单个卷文件损坏 → 跳过该卷（console.error 可见），不炸整个恢复；
 * 全部卷都读不出来 → 清空摊开集回退新建（与旧行为同构）。
 */
async function restoreFromLedger(
  ctx: SessionContext,
  projectPath: string,
  ledger: SessionLedgerDisk,
  epoch: number,
): Promise<void> {
  // 逐卷读数据（活跃卷优先不必要——顺序即总目 open 序）
  const metas = openMetaOf(ledger);
  const volumes: Array<{ id: number; label: string; data: StoredSession }> = [];
  for (const meta of metas) {
    const data = await readVolumeData(projectPath, meta.id);
    if (!data) {
      console.error(`[chat] 总目卷 ${meta.id} 恢复失败（缺失/已删/空卷）——跳过`);
      continue;
    }
    volumes.push({ id: meta.id, label: restoredLabel(data, meta.label, volumes.length + 1), data });
  }

  if (volumes.length === 0) {
    // 总目里全是死卷 → 清账新建（与旧路径「未找到历史案卷」同构）
    getChatStore(ctx.storeId).sess.setState({ nextSessionId: 1 });
    ctx.addNotice('总目摊开集已无可用案卷，已新建案卷', 'info');
    // Phase B：真的建卷（内容层兜底）
    ensureBaselineSession(ctx);
    return;
  }

  // 代际防护（H5）：恢复在途期间已切换工作区 — 丢弃本次恢复，不写任何 store。
  if (!isCurrentEpoch(epoch)) return;

  // 活跃卷定位（Phase B：真句柄创建退役——活跃卷也只恢复内容层）
  const activeId = volumes.some((v) => v.id === ledger.activeId) ? (ledger.activeId as number) : volumes[0].id;
  const activeVol = volumes.find((v) => v.id === activeId) ?? volumes[0];

  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();

  // 全量重建摊开集（清面板旧态——与旧路径 clearPanelState 同构）
  agentSessionState.clearPanelState(ctx.storeId);
  const curSt = getChatStore(ctx.storeId).sess.getState();
  const activeIdx = volumes.findIndex((v) => v.id === activeVol.id);
  // 发号对账（L0/F5）：max(内存, 总目, 磁盘最大档号+1)——撞号裂缝在此闭合
  const scanMax = await scanMaxSessionId(projectPath);
  const nextId = reconcileNextSessionId(ctx.storeId, ledger, scanMax);

  agentSessionState.setExec(ctx.storeId, activeVol.id, createExecState());

  getChatStore(ctx.storeId).sess.setState({
    sessions: volumes.map((v) => ({ id: v.id, label: v.label })),
    activeIdx,
    sessionTokens: Object.fromEntries(volumes.map((v) => [v.id, v.data.tokensUsed ?? 0])),
    nextSessionId: Math.max(nextId, curSt.nextSessionId),
  });
  getChatStore(ctx.storeId).input.getState().clearSessionDrafts();

  // 逐卷恢复内容层（rebuildMessagesFromMessages 是纯数据函数）+ 纸面恢复。
  // 活跃卷最后重建——rebuild 会重置 turnPairs，活跃卷的 turnPairs 必须是终态。
  for (const v of volumes) {
    if (v.id === activeVol.id) continue;
    const convs = (v.data.messages as Message[]).filter((m) => m.role !== 'system');
    rebuildMessagesFromMessages(convs, ctx.storeId, v.id);
    loadPaperSessionData(ctx.storeId, v.id, v.data.paper ?? null);
  }
  rebuildMessagesFromMessages(
    (activeVol.data.messages as Message[]).filter((m) => m.role !== 'system'),
    ctx.storeId,
    activeVol.id,
  );
  loadPaperSessionData(ctx.storeId, activeVol.id, activeVol.data.paper ?? null);

  ctx.setLastUsageText('');
  ctx.updateFooter();
  // 活跃卷句柄后台补建（「活跃卷有句柄」的既有 UX——导出/改名即存等消费路径
  // 需要；失败可见但不清会话，拟文时 sendMessage 兜底再试）
  void ensureSessionAgent(ctx).then((ok) => {
    if (!ok) ctx.addNotice('卷的 Agent 未就绪（API Key 未配置？）——拟文时会再试', 'warn');
  });
  ctx.addNotice(
    `已恢复案卷工作集：${volumes.length} 卷（活跃：${activeVol.label}${volumes.length > 1 ? '，其余惰性待唤' : ''}）`,
    'info',
  );
  // 恢复即记账：摊开集落盘（吸收迁移后的总目写入 + 死卷剔除）
  recordOpenSetChange(ctx.storeId, projectPath, ledgerIo);
}

/** 扫描会话目录 — 无需 Agent。 */
export async function listSavedSessions(
  _ctx: SessionContext,
  projectPath: string,
): Promise<Array<{ id: number; label: string; msgCount: number; savedAt: string }>> {
  const dirPath = sessionsDir(projectPath);
  let entries: DirectoryEntry[];
  try {
    entries = await typedJsonRpc<DirectoryEntry[]>('list_directory', { path: dirPath, filter_ignored: false });
  } catch (e) {
    console.error('[chat] listSavedSessions: list_directory failed', e);
    return [];
  }

  if (!Array.isArray(entries)) {
    console.error('[chat] listSavedSessions: unexpected result', typeof entries);
    return [];
  }

  // 过滤有效的 JSON 会话文件（跳过目录、_active.json、非 json）
  const targets = entries.filter(
    (e) =>
      !e.is_dir &&
      e.name.endsWith('.json') &&
      e.name !== '_active.json' &&
      !Number.isNaN(parseInt(e.name.replace('.json', ''), 10)),
  );

  // ── 并行读取所有会话文件，超时 10 秒 ──
  const TIMEOUT_MS = 10_000;
  type SessionEntry = { id: number; label: string; msgCount: number; savedAt: string };
  const readPromises: Promise<SessionEntry | null>[] = targets.map(async (e) => {
    try {
      const d = await readSessionJSON(e.path);
      if (d.deleted) return null;
      const sid = parseInt(e.name.replace('.json', ''), 10);
      return {
        id: d.id || sid,
        label: d.label || `案卷 ${sid}`,
        msgCount: (d.messages ?? []).filter((m) => m.role !== 'system').length,
        savedAt: d.savedAt || '',
      };
    } catch (err) {
      console.error(`[chat] listSavedSessions: failed to read ${e.name}`, err);
      return null;
    }
  });

  const timeout: Promise<null[]> = new Promise((resolve) =>
    setTimeout(() => {
      console.warn('[chat] listSavedSessions: timed out after 10s');
      resolve([]);
    }, TIMEOUT_MS),
  );

  const results = await Promise.race([Promise.all(readPromises), timeout]);
  if (!Array.isArray(results)) return [];

  const result = results.filter((r) => r !== null) as SessionEntry[];
  result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return result;
}

/** 从磁盘加载已保存的会话到新标签页。回退到 localStorage。 */
export async function loadSessionFromDisk(ctx: SessionContext, projectPath: string, sessionId: number): Promise<void> {
  // 续开查重（L1/F2）：该卷已在案头摊开 → 直接换卷不克隆（旧行为：无条件
  // append → 同号双脊，旧句柄被顶掉未 dispose，合卷即变死卷）。
  {
    const st0 = getChatStore(ctx.storeId).sess.getState();
    const openIdx = st0.sessions.findIndex((s) => s.id === sessionId);
    if (openIdx >= 0) {
      if (openIdx !== st0.activeIdx) switchSession(ctx, openIdx);
      ctx.addNotice(`案卷 ${sessionId} 已在案头——已换卷`, 'info');
      return;
    }
  }
  if (!getAgentFactory(ctx.storeId)) {
    const extra = ctx.getLastAgentDiag() ? `\n诊断: ${ctx.getLastAgentDiag()}` : '';
    ctx.addNotice(`请先配置 API Key${extra}`, 'error');
    return;
  }

  let data: StoredSession | null = null;
  // 1) 尝试磁盘文件
  try {
    data = await readSessionJSON(sessionFile(projectPath, sessionId));
  } catch {
    /* 尝试 localStorage */
  }

  // 2) localStorage 回退
  if (!data && typeof localStorage !== 'undefined') {
    const lsRaw = localStorage.getItem(lsKey(projectPath, sessionId));
    if (lsRaw) {
      try {
        data = JSON.parse(lsRaw) as StoredSession;
      } catch {
        /* 损坏 */
      }
    }
  }
  if (!data) {
    ctx.addNotice('案卷文件读取失败', 'error');
    return;
  }

  const newAgent = await getAgentFactory(ctx.storeId)?.();
  if (!newAgent) {
    ctx.addNotice('无法创建 Agent', 'error');
    return;
  }

  const freshSys = newAgent.getSession().filter((m: Message) => m.role === 'system');
  const conv = (data.messages as Message[]).filter((m) => m.role !== 'system');
  newAgent.setSession([...freshSys, ...conv]);

  const firstUser = conv.find((m: Message) => m.role === 'user' && !isInternalMessage(m.content));
  const st1 = getChatStore(ctx.storeId).sess.getState();
  const label =
    data.label && !/^(?:会话|案卷) /.test(data.label) && data.label !== '已恢复的会话' && data.label !== '已恢复的案卷'
      ? data.label
      : firstUser
        ? firstUser.content?.slice(0, 28) + (firstUser.content?.length > 28 ? '…' : '')
        : `案卷 ${st1.sessions.length + 1}`;

  // ponytail: 消息在会话级 store 中 — 无需 saveCurrentMessages
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();

  const sid = data.id || sessionId;
  agentSessionState.setAgent(ctx.storeId, sid, newAgent);
  // 静态绑定该 Agent 的 board 到加载的会话
  newAgent.bindSession?.(String(sid));
  getChatStore(ctx.storeId).sess.setState({
    sessions: [...st1.sessions, { id: sid, label }],
    activeIdx: st1.sessions.length,
    // 发号下限（L0/F5）：续开大号卷后，另起一卷不得发出 ≤ 已存在档号的号
    nextSessionId: Math.max(st1.nextSessionId, sid + 1),
  });
  // ponytail: 创建会话级消息 store
  msgStoreFor(ctx.storeId, sid).getState().setMessages([]);
  // 纸面用户层（钉住块 + 纸条）随卷恢复——旧存档无 paper 字段 = 空纸面
  loadPaperSessionData(ctx.storeId, sid, data.paper ?? null);
  if (typeof data.tokensUsed === 'number') {
    ctx.setTotalTokensUsed(data.tokensUsed);
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(sid, data.tokensUsed);
  } else {
    ctx.setTotalTokensUsed(0);
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(sid, 0);
  }

  try {
    renderRestoredSession(ctx);
  } catch (e) {
    console.error('[chat] loadSessionFromDisk: render 崩溃', e);
    ctx.addNotice(`案卷已加载但渲染失败: ${label}`, 'error');
  }

  ctx.setLastUsageText('');
  ctx.updateFooter();
  ctx.addNotice(`已加载: ${label}`, 'info');
  // 账本记账（L0）：续开摊开一卷 → 总目投影落盘
  recordOpenSetChange(ctx.storeId, projectPath, ledgerIo);
}

/** 将磁盘上的会话文件标记为已删除。 */
export async function deleteSessionFile(ctx: SessionContext, projectPath: string, sessionId: number): Promise<void> {
  // 用删除标记覆盖 — listSavedSessions 会过滤掉这些
  try {
    await typedRpc('write_file_content', {
      file_path: sessionFile(projectPath, sessionId),
      content: JSON.stringify({ id: sessionId, deleted: true, label: '', messages: [], savedAt: '' }),
    });
  } catch (e) {
    console.error('[chat] deleteSessionFile failed:', e);
    ctx.addNotice('删除案卷文件失败', 'error');
    return; // 写入失败则不关闭标签页
  }
  // 清理 localStorage 备份
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(lsKey(projectPath, sessionId));
  } catch {
    /* 忽略 */
  }
  // 清理内存中的纸面用户层（卷已删，摆放数据无主）
  removePaperSessionData(ctx.storeId, sessionId);
  // 若该会话在标签页中打开，则关闭该标签页
  const idx = getChatStore(ctx.storeId)
    .sess.getState()
    .sessions.findIndex((s) => s.id === sessionId);
  if (idx >= 0) closeSession(ctx, idx);
}

// ── 会话恢复（内部辅助函数）──

/** 遍历活跃 agent 的会话数组，构建 ChatMessage[] + turnPairs。 */
function renderRestoredSession(ctx: SessionContext): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sid);
  if (!agent) return;
  _rebuildMessagesFromSession(ctx);
  bumpSession(ctx.storeId, sid);
  ctx.addNotice(`已恢复 ${sessions.length} 个会话`, 'info');
}

/** 从 agent 的 getSession() 原始消息填充活跃会话的会话级消息 store + turnPairs。
 *  纯数据重建 — 无 DOM 操作，无通知。 */
export function rebuildMessagesFromMessages(msgs: Message[], storeId: string, sessionId: number): void {
  const rebuilt: ChatMessage[] = [];

  // 保留按助手消息序号索引的活跃 SubAgentPart 对象。
  // 子 Agent 汇持持有这些对象的引用并持续流式写入 —
  // 仅从 provider 消息重建会丢弃卡片并使汇持孤立
  // （冻结的卡片、丢失的输出）。同样的对象会在
  // 下方重新附加到重建的消息中。
  const preservedSubAgents = new Map<number, SubAgentPart[]>();
  {
    const existing = msgStoreFor(storeId, sessionId).getState().messages;
    let aIdx = 0;
    for (const m of existing) {
      if (m.role !== 'assistant') continue;
      const subs = (m as AssistantMessage).parts.filter((p): p is SubAgentPart => p.type === 'subagent');
      if (subs.length > 0) preservedSubAgents.set(aIdx, subs);
      aIdx++;
    }
  }

  resetMsgIdCounter();
  setTurnPairs(storeId, []);

  const toolResults = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === 'tool' && m.tool_call_id) {
      toolResults.set(m.tool_call_id, m.content || '');
    }
  }

  let pendingUserText: string | null = null;
  let pendingUserId: MessageId | null = null;
  let pendingSessionIdx = -1;
  let sessionIdx = 0;

  for (const m of msgs) {
    const idx = sessionIdx++;

    if (m.role === 'system') continue;

    if (m.role === 'user') {
      if (isInternalMessage(m.content)) {
        if (m.content?.startsWith('<compacted-context>')) {
          rebuilt.push(createNoticeMessage('📋 上下文已压缩', 'info'));
        }
        continue;
      }
      if (pendingUserText && pendingUserId) {
        getTurnPairs(storeId).push({
          userText: pendingUserText,
          userBubble: null,
          assistantBubble: null,
          sessionIndex: pendingSessionIdx,
        });
      }
      pendingUserText = m.content || '';
      pendingUserId = nextMsgId();
      pendingSessionIdx = idx;
      const um = createUserMessage(m.content || '', undefined, idx);
      rebuilt.push(um);
      pendingUserId = um._id;
      continue;
    }

    if (m.role === 'tool') continue;

    if (m.role === 'assistant') {
      const am = createAssistantMessage(pendingUserId || '');
      am.status = 'done';

      if (m.reasoning_content) {
        am.parts.push({ type: 'reasoning', text: m.reasoning_content });
      }

      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          // 子 Agent spawn 调用由 SubAgentBlock 呈现（实时会话的 SubAgentPart 在上方
          // preservedSubAgents 中保留并重新挂载）— 不重建 ToolCard，
          // 否则恢复/撤回重建后同一 spawn 会同时出现两种卡片。
          if (isSubagentSpawnTool(tc.name, tc.arguments || undefined)) continue;
          am.parts.push({
            type: 'tool',
            toolId: tc.id,
            name: tc.name,
            args: tc.arguments || '',
            label: tc.name,
            readOnly: false,
            status: 'done',
            output: toolResults.get(tc.id),
          });
        }
      }

      if (m.content) {
        am.parts.push({ type: 'text', text: m.content, finalised: true });
      }

      rebuilt.push(am);

      if (pendingUserText) {
        getTurnPairs(storeId).push({
          userText: pendingUserText,
          userBubble: null,
          assistantBubble: null,
          sessionIndex: pendingSessionIdx,
        });
        pendingUserText = null;
        pendingUserId = null;
      }
    }
  }

  if (pendingUserText) {
    getTurnPairs(storeId).push({
      userText: pendingUserText,
      userBubble: null,
      assistantBubble: null,
      sessionIndex: pendingSessionIdx,
    });
  }

  // 按助手消息序号重新附加保留的子 Agent 部件。
  // 超出重建范围的序号（如仍在流式输出但尚未出现在
  // provider 消息中的轮次）回退到最后一条重建的助手消息。
  if (preservedSubAgents.size > 0) {
    const rebuiltAssistants = rebuilt.filter((m): m is AssistantMessage => m.role === 'assistant');
    for (const [ordinal, subs] of preservedSubAgents) {
      const target = rebuiltAssistants[ordinal] ?? rebuiltAssistants[rebuiltAssistants.length - 1];
      if (target) target.parts.push(...subs);
    }
  }

  // ponytail: 写入会话级 store — 唯一数据源
  msgStoreFor(storeId, sessionId).getState().setMessages(rebuilt);
  bumpSession(storeId, sessionId);
}

/** 包装器：解析活跃 agent 的会话并委托给 rebuildMessagesFromMessages。 */
export function _rebuildMessagesFromSession(ctx: SessionContext): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sid);
  if (!agent) return;

  rebuildMessagesFromMessages(agent.getSession(), ctx.storeId, sid);
}

// ── 轮次撤回 ──

/** 从 DOM 和 agent 会话中撤回一轮对话。返回 userText 或 null。 */
export function retractTurn(ctx: SessionContext, idx: number): string | null {
  const tp = getTurnPairs(ctx.storeId);
  const pair = tp[idx];
  if (!pair) return null;
  // ⚡ React 处理 DOM 移除，只需清理模型
  // 从 agent 会话中移除 — 若索引已过期（运行中插入），按内容搜索
  let sessIdx = pair.sessionIndex;
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const agent = agentSessionState.getAgent(ctx.storeId, sessions[activeIdx]?.id ?? -1);
  if (sessIdx < 0 && agent) {
    const agentSession = agent.getSession();
    for (let i = 0; i < agentSession.length; i++) {
      if (agentSession[i].role === 'user' && agentSession[i].content === pair.userText) {
        sessIdx = i;
        break;
      }
    }
  }
  if (sessIdx >= 0) agent?.retractTurnAt(sessIdx);
  // 从 turnPairs 中移除
  tp.splice(idx, 1);
  // 从实际会话中重新索引剩余配对的 sessionIndex
  if (agent) {
    const agentSession = agent.getSession();
    const userMsgIndices: number[] = [];
    for (let i = 0; i < agentSession.length; i++) {
      if (agentSession[i].role === 'user') userMsgIndices.push(i);
    }
    for (let i = 0; i < tp.length && i < userMsgIndices.length; i++) {
      tp[i].sessionIndex = userMsgIndices[i];
    }
  }
  return pair.userText;
}

/** 从模型中撤回单条用户消息（及其助手回复）。 */
export function _retractUserMessage(ctx: SessionContext, msg: UserMessage): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return;

  const msgs = msgStoreFor(ctx.storeId, sid).getState().messages;
  const idx = msgs.indexOf(msg);
  if (idx >= 0) {
    const toRemove: number[] = [idx];
    for (let i = idx + 1; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'assistant' && (m as AssistantMessage).respondingTo === msg._id) {
        toRemove.push(i);
        break;
      } else if (m.role === 'user') {
        break;
      }
    }
    for (const i of toRemove.reverse()) {
      msgs.splice(i, 1);
    }
    msgStoreFor(ctx.storeId, sid)
      .getState()
      .setMessages([...msgs]);
    bumpSession(ctx.storeId, sid);
  }
  if (msg.sessionIndex >= 0) {
    agentSessionState.getAgent(ctx.storeId, sid)?.retractTurnAt(msg.sessionIndex);
  }
}

// ── 对话导出 ──

export async function exportSession(ctx: SessionContext): Promise<void> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const agent = agentSessionState.getAgent(ctx.storeId, sessions[activeIdx]?.id ?? -1);
  if (!agent) {
    ctx.addNotice('没有可导出的案卷', 'info');
    return;
  }

  const msgs = agent.getSession();
  const settings = loadSettings();
  const active = getActiveProvider(settings);
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  let md = `# 兰台 · 案卷 — ${dateStr}\n`;
  md += `> 模型: ${active?.model || 'unknown'} · 总 token: ${ctx.getTotalTokensUsed().toLocaleString()}\n\n`;

  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (isInternalMessage(m.content)) {
        if (m.content?.startsWith('<compacted-context>')) {
          md += `> *[上下文压缩]*\n\n`;
        }
        continue;
      }
      md += `## 用户\n${m.content || ''}\n\n`;
    }
    if (m.role === 'assistant') {
      md += `## Agent\n${m.content || ''}\n`;
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          md += `\n### 工具调用: ${tc.name}\n`;
          md += `> 参数: \`${tc.arguments || ''}\`\n`;
        }
      }
      md += '\n';
    }
  }

  // 尝试 Tauri 保存对话框，回退到浏览器下载
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const filePath = await save({
      defaultPath: `hologram-session-${now.toISOString().slice(0, 10)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (filePath) {
      await typedRpc('write_file_content', { file_path: filePath, content: md });
      ctx.addNotice(`案卷已导出: ${filePath}`, 'info');
    }
  } catch {
    // 浏览器回退
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hologram-session-${now.toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    ctx.addNotice('案卷已下载', 'info');
  }
}
