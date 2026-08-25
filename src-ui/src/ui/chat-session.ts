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
import { sessionScopeStore } from '../state/session-scope';
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
export function resetSessionState(storeId: string): void {
  // Agent 装配时序归位（2026-08-25，DSH 形态）：装配不再预造句柄、不铺卷。
  // 启动/切工作区只做两件事：挂工厂（工厂 = 「知道怎么造」，零成本）+
  // 清理旧工作区残留（句柄/exec/纸面/消息 store/草稿）。句柄的生命周期
  // 完全跟随卷——拟文时经 ensureSessionAgent 惰性现造（Phase B 链路）。
  // 发号下限保留（nextSessionId 不回退）——发号对账由 autoRestoreLastSession 承担。
  const nextId = getChatStore(storeId).sess.getState().nextSessionId;
  agentSessionState.clearPanelState(storeId);
  // 工作区全量重置：纸面用户层（钉住块/纸条）一并清空——旧工作区摆放不得串入新工作区
  clearPaperSessions(storeId);
  // 工作区全量重置：旧工作区全部会话级消息 store（storeId:sessionId）一并移除
  //（M4：store 注册表跨工作区存活，旧卷不拆 = 无界增长 + 新工作区撞号卷读到旧消息）
  disposeMessagesStores(storeId);
  getChatStore(storeId).sess.setState({
    sessions: [],
    activeIdx: -1,
    sessionTokens: {},
    nextSessionId: nextId,
  });
  // 全新会话树 —— 清空一切旧草稿槽与 live 输入，会话 id 已变化
  getChatStore(storeId).input.getState().clearSessionDrafts();
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

  // L1 数据上下文：焦点会话切换（UI 投影锚 + 引擎决议链「会话→焦点」源头）。
  // sessionScope 供 agentInvoke 注入 _session_id；session_focus 供 Rust 侧
  // 焦点回退。fire-and-forget——换卷交互不被 RPC 阻塞。
  sessionScopeStore.getState().setCurrentSessionId(sessions[idx].id);
  void typedRpc('session_focus', { session_id: sessions[idx].id }).catch(() => {
    /* 后端未就绪/占位工作区：投影推导回退，不阻断换卷 */
  });

  // 恢复目标会话的 token 计数
  ctx.setTotalTokensUsed(st.sessionTokens[sessions[idx].id] || 0);
  ctx.setLastUsageText('');
  ctx.updateFooter();
  // U4/Q1-B：总目记账退役——摊开集重启由磁盘扫描推导，运行时真相 = sess store
  // L0 惰性水合：切到无句柄的卷 → 按需补建（fire-and-forget；失败留
  // sendMessage 的同步唤起兜底，这里不拦换卷交互）
  const switchedSid = sessions[idx].id;
  if (!agentSessionState.getAgent(ctx.storeId, switchedSid)) {
    hydrateSessionAgentVisible(ctx);
  }
}

/** 卷句柄的 fire-and-forget 补建——失败可见（Phase D，2026-08-24 工作区归属
 *  根治）：工厂返 null → warn 提示拟文再试；工厂抛错（装配失败）→ console +
 *  error 通知，不静默吞（宪法「错误不静默」）。 */
function hydrateSessionAgentVisible(ctx: SessionContext): void {
  void ensureSessionAgent(ctx)
    .then((ok) => {
      if (!ok) ctx.addNotice('卷的 Agent 未就绪（API Key 未配置？）——拟文时会再试', 'warn');
    })
    .catch((e) => {
      console.error('[chat] 卷句柄补建失败:', e);
      ctx.addNotice(`卷的 Agent 补建失败: ${e instanceof Error ? e.message : String(e)}`, 'error');
    });
}

/** L0 惰性水合（摊开集恢复后续语义）：重启恢复后惰性卷的 Agent 句柄缺席。
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
  // 取原始会话（readVolumeData 与恢复路径同源：全局位单读 + 已删/空卷过滤）。
  // projectPath=''（零目录会话）同样回填——全局位即用户级目录。
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
  // U4/Q1-B：总目记账退役（摊开集重启由磁盘扫描推导）
}

export async function createNewSession(ctx: SessionContext): Promise<void> {
  // DSH 形态（2026-08-25）：信封先行——建卷是纯数据操作，立即摊开可见；
  // 句柄不是建卷的前置条件（拟文时 ensureSessionAgent 惰性现造）。
  // 工厂在场时顺手现造一个句柄（首次拟文的常见路径提前就绪）；
  // 工厂缺席/返空/抛错 → 无句柄建卷（拟文时提示配 Key——Phase B 契约）。
  let newAgent: OwnedAgentHandle | null = null;
  const factory = getAgentFactory(ctx.storeId);
  if (factory) {
    try {
      newAgent = await factory();
    } catch {
      /* 装配失败 = 句柄缺席，内容层照常（错误由拟文路径可见） */
    }
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
  if (newAgent) {
    agentSessionState.setAgent(ctx.storeId, id, newAgent);
    // 静态绑定该 Agent 的 board 到新会话（id 在 factory 之后才确定）
    newAgent.bindSession?.(String(id));
    agentSessionState.setExec(ctx.storeId, id, createExecState());
  }
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
  // U4/Q1-B：总目记账退役（摊开集重启由磁盘扫描推导）
  // L1 数据上下文：新生会话声明绑定（DSH 出生与绑定分离——卷未落盘，
  // workspace 事实源暂为当前工作区；首笔落盘后重开以卷为准）。
  const claimWs = ctx.getProjectPath();
  sessionScopeStore.getState().setCurrentSessionId(id);
  void (async () => {
    try {
      await typedRpc('session_attach', {
        session_id: id,
        workspace: claimWs || undefined,
      });
      await typedRpc('session_focus', { session_id: id });
    } catch (e) {
      console.warn('[chat] 新生会话 attach 失败（Ungrouped 继续）:', e);
    }
  })();
}

// ── 会话持久化 — 每个会话一个文件（全局位唯一存储位）──

/** 会话文件的持久化形状（磁盘 JSON）。
 *  paper（钉住块坐标 + 纸条，2026-08-24 收尾）：可选字段，旧存档无此字段 = 空纸面。
 *  workspace（会话统一 U1，2026-08-24）：卷归属的工作区（正斜杠归一）或
 *  null（零目录卷）。 */
interface StoredSession {
  id: number;
  label?: string;
  savedAt?: string;
  messages?: Message[];
  tokensUsed?: number;
  paper?: PaperSessionData;
  workspace?: string | null;
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

// ── 会话统一 U1（2026-08-24）→ 归零重建（2026-08-25，用户拍板）────────────
// 全局位 ~/.lantai/sessions/{id}.json 是**唯一**存储位：写只写这里、读只读这里、
// 归属只认卷内 workspace 字段。历史 171 卷 + ledger 残留已整包归档
// （sessions.bak-20260825），双读/撞号回退/旧目录加扫/legacy_root 全部拆除——
// 代码里从此只有一条路径，单一事实源是物理事实。

/** 路径归一：反斜杠 → 正斜杠，去尾斜杠（workspace 字段写入与匹配统一此规）。 */
function normWs(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 全局会话目录（唯一权威存储位；缓存未就绪时的兜底路径与旧行为一致）。 */
function globalSessionsDir(): string {
  return _userSessionsDir ?? '/.lantai/sessions';
}

/** 读卷文件，缺失/坏文件返回 null（不抛——双读与存在性探测共用）。 */
async function readSessionJSONOrNull(filePath: string): Promise<StoredSession | null> {
  try {
    return await readSessionJSON(filePath);
  } catch {
    return null;
  }
}

/** 读卷：全局位单一路径。缺失/坏文件/归属不符均返回 null——归零重建后
 *  不存在回退面，卷不在全局位就等于不存在。 */
async function readVolumeJSON(projectPath: string, id: number): Promise<StoredSession | null> {
  const global = await readSessionJSONOrNull(`${globalSessionsDir()}/${id}.json`);
  if (!global) return null;
  // 归属校验保留：同号卷若归属别的工作区，对当前请求而言等同于不存在。
  // （归零后全局位发号单调递增，撞号本不该发生；校验是防御，不是兼容。）
  const vw = typeof global.workspace === 'string' && global.workspace ? normWs(global.workspace) : '';
  return vw === normWs(projectPath) ? global : null;
}

/** 扫描全局位，查找最大的数字会话 ID。无会话时返回 0。
 *  归零重建：单目录（全局位）扫描——旧目录已归档，不存在第二个扫描面。 */
export async function scanMaxSessionId(_projectPath: string): Promise<number> {
  let maxId = 0;
  try {
    const parsed: unknown = await typedJsonRpc('list_directory', {
      path: globalSessionsDir(),
      filter_ignored: false,
    });
    if (!Array.isArray(parsed)) return maxId;
    const entries = parsed as DirectoryEntry[];
    for (const e of entries) {
      if (e.is_dir || !e.name || e.name === '_active.json') continue;
      const sid = parseInt(String(e.name).replace(/\.json$/, ''), 10);
      if (!Number.isNaN(sid) && sid > maxId) maxId = sid;
    }
  } catch {
    /* 目录缺席/读失败 = 空（首启常态） */
  }
  return maxId;
}

/** 会话快照的磁盘形状（C8：saveActiveSession 与合卷落盘共用）。
 *  paper：纸面用户层状态（钉住块 + 纸条）——2026-08-24 收尾接入持久化。
 *  workspace：卷归属工作区（U1 起写入；正斜杠归一，零目录卷 = null）。 */
interface SessionSnapshotData {
  id: number;
  label: string;
  savedAt: string;
  messages: Message[];
  tokensUsed: number;
  paper?: PaperSessionData;
  workspace?: string | null;
}

/** 将已捕获的会话快照写入盘（原子磁盘写：tmp → rename）。
 *  C8 合卷自动存从 saveActiveSession 离体出来的共享写盘函数——调用方负责
 *  在 agent 句柄消亡前完成数据捕获（messages 属引用，序列化在首次 await 前）。
 *  归零重建（2026-08-25）：落盘目标 = 全局位单一路径（workspace 字段随卷
 *  写入；无撞号回退）；localStorage 备份已拆除（用户拍板 A——磁盘是唯一
 *  事实源，可重建的派生态不持久化）。
 *  失败：console.error 后上抛——调用方决定可见等级（autosave 容忍、合卷告警）。 */
async function writeSessionSnapshot(projectPath: string, data: SessionSnapshotData): Promise<void> {
  const payload: SessionSnapshotData = { ...data, workspace: normWs(projectPath) || null };
  const json = JSON.stringify(payload);
  // 原子磁盘写入（tmp → rename；目标 = 全局位）
  try {
    await typedRpc('write_file_content', {
      file_path: `${globalSessionsDir()}/${data.id}.json`,
      content: json,
    });
  } catch (e) {
    console.error('[chat] 会话落盘失败:', e);
    throw e;
  }
}

/** 将活跃会话保存到其独立文件。
 *  projectPath=''（零目录会话，单槽统一 2026-08-24）合法——全局位即用户级
 *  目录，与 loadSessionFromDisk(projectPath='') 的读取侧同构。
 *  U4/Q1-B：tracker（_active.json）与总目（_ledger.json）均已退役——
 *  摊开集重启由磁盘扫描推导，落盘只写卷文件本身。 */
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

  // U4/Q1-B：无 tracker 写入（见函数头注释）——落盘只写卷文件
}

/** 按 id 落盘指定会话（C8 改名即存）：不要求是活跃卷。projectPath='' 零目录
 *  会话路由全局位（U1 起所有卷统一落全局位；workspace 字段随卷写入）。
 *  空卷跳过（与 saveActiveSession 同规）。 */
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
 *  在 chat:turn-done 时调用 — 在 beforeunload 前确保大部分消息已落盘。
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

/** Q-B（2026-08-24 用户拍板）：重启/装配不自动摊开任何卷，落点为案卷首页
 *  （用户从全局列表自选要开的卷；“最近 3 卷”是总目退役后无语义的猜测，弃）。
 *  本函数退化为发号对账：扫描全局位 + 旧目录推导 nextSessionId（避免新建撞号），
 *  不写 sess store 摊开集、不建兜底卷。崩溃加速语义不受影响：
 *  loadSessionFromDisk 打开时从全局位读全量快照。 */
export async function autoRestoreLastSession(ctx: SessionContext, projectPath: string): Promise<void> {
  // 代际防护（H5）：对账在途期间可能切换工作区 — 写入前校验，过期丢弃。
  const epoch = getWorkspaceEpoch();

  const sessions = await listSavedSessions(ctx, projectPath);
  // 发号对账：next = max(内存, 磁盘最大档号 + 1)——撞号裂缝闭合（F5 语义承继）
  const scanMax = sessions.reduce((m, r) => Math.max(m, r.id), 0);
  const memNext = getChatStore(ctx.storeId).sess.getState().nextSessionId;
  const next = Math.max(memNext, scanMax + 1);
  if (!isCurrentEpoch(epoch)) return;
  getChatStore(ctx.storeId).sess.setState({ nextSessionId: next });
}

// ── 摊开集多卷恢复（扫描推导；session-ledger L0 语义承继面）─────────────

/** 恢复路径的卷数据（归零重建：全局位单读 + 墓碑/空卷过滤；localStorage
 *  覆盖已拆——磁盘是唯一事实源）。 */
async function readVolumeData(projectPath: string, id: number): Promise<StoredSession | null> {
  const data = await readVolumeJSON(projectPath, id);
  if (!data || data.deleted) return null;
  // 空卷（无任何非系统消息）不进摊开集——与「空卷不落盘」同规，
  // 避免重启后摊开集里出现只有系统提示的尸体卷。
  if (!data.messages?.some((m) => m.role !== 'system')) return null;
  return data;
}

/** 扫描全局位卷目录 — 无需 Agent。归零重建：单目录（全局位），归属只认
 *  卷内 workspace 字段（缺/空 = 零目录卷）；墓碑与坏卷过滤。恢复推导与
 *  发号对账共用。 */
export async function listSavedSessions(
  _ctx: SessionContext,
  projectPath: string,
): Promise<Array<{ id: number; label: string; msgCount: number; savedAt: string; workspace: string }>> {
  type SessionEntry = { id: number; label: string; msgCount: number; savedAt: string; workspace: string };
  let entries: DirectoryEntry[];
  try {
    entries = await typedJsonRpc<DirectoryEntry[]>('list_directory', {
      path: globalSessionsDir(),
      filter_ignored: false,
    });
  } catch (e) {
    console.error('[chat] listSavedSessions: list_directory failed', e);
    return [];
  }
  if (!Array.isArray(entries)) {
    console.error('[chat] listSavedSessions: unexpected result', typeof entries);
    return [];
  }

  // 过滤有效的 JSON 会话文件（跳过目录与下划线开头的保留名）
  const targets = entries.filter(
    (e) =>
      !e.is_dir &&
      e.name.endsWith('.json') &&
      !e.name.startsWith('_') &&
      !Number.isNaN(parseInt(e.name.replace('.json', ''), 10)),
  );

  // 归属过滤：只列「本工作区 + 零目录」的卷（他工作区卷不在本列表——
  // 首页全局列表由 Rust user_sessions_list 承担，此函数服务恢复推导/发号）
  const norm = normWs(projectPath);
  const TIMEOUT_MS = 10_000;
  const readPromises: Promise<SessionEntry | null>[] = targets.map(async (e) => {
    try {
      const d = await readSessionJSON(e.path);
      if (d.deleted) return null;
      const sid = parseInt(e.name.replace('.json', ''), 10);
      const ws = typeof d.workspace === 'string' && d.workspace ? normWs(d.workspace) : '';
      if (ws !== '' && ws !== norm) return null; // 他工作区卷：不属于本列表
      return {
        id: d.id || sid,
        label: d.label || `案卷 ${sid}`,
        msgCount: (d.messages ?? []).filter((m) => m.role !== 'system').length,
        savedAt: d.savedAt || '',
        workspace: ws,
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
  const settled = await Promise.race([Promise.all(readPromises), timeout]);
  const result = (Array.isArray(settled) ? settled : []).filter((r): r is SessionEntry => r !== null);
  result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return result;
}

/** 从磁盘加载已保存的会话到新标签页。 */
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
  let data: StoredSession | null = null;
  // 读卷：全局位单读 + 墓碑/空卷过滤。
  // Q-B 后 autoRestore 不再恢复内容，本契约由打开路径（首页点卷）承担。
  data = await readVolumeData(projectPath, sessionId);
  if (!data) {
    ctx.addNotice('案卷文件读取失败', 'error');
    return;
  }

  // Phase B 对齐（Q-B 后「从首页点开历史卷」即此入口）：句柄是惰性资源——
  // 工厂在场时现造（首次拟文常见路径提前就绪）；无 Key（返 null）/抛错时
  // 摊开内容层照常（历史卷可见不依赖装配），句柄留由 ensureSessionAgent
  // 在拟文时补建；无工厂同样摊开（拟文时提示配 Key）。
  let newAgent: OwnedAgentHandle | null = null;
  try {
    newAgent = (await getAgentFactory(ctx.storeId)?.()) ?? null;
  } catch {
    /* 装配失败 = 句柄缺席，内容层照常（错误由拟文路径可见） */
  }

  const conv = (data.messages as Message[]).filter((m) => m.role !== 'system');
  const freshSys = newAgent?.getSession().filter((m: Message) => m.role === 'system') ?? [];
  if (newAgent) newAgent.setSession([...freshSys, ...conv]);

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
  if (newAgent) {
    agentSessionState.setAgent(ctx.storeId, sid, newAgent);
    // 静态绑定该 Agent 的 board 到加载的会话
    newAgent.bindSession?.(String(sid));
    agentSessionState.setExec(ctx.storeId, sid, createExecState());
  }
  getChatStore(ctx.storeId).sess.setState({
    sessions: [...st1.sessions, { id: sid, label }],
    activeIdx: st1.sessions.length,
    // 发号下限（F5）：续开大号卷后，另起一卷不得发出 ≤ 已存在档号的号
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

  if (newAgent) {
    try {
      renderRestoredSession(ctx);
    } catch (e) {
      console.error('[chat] loadSessionFromDisk: render 崩溃', e);
      ctx.addNotice(`案卷已加载但渲染失败: ${label}`, 'error');
    }
  } else {
    // 无句柄：纯数据重建内容层（历史卷可见；句柄拟文时补建）
    rebuildMessagesFromMessages(conv, ctx.storeId, sid);
    bumpSession(ctx.storeId, sid);
    // 后台补建句柄：无 Key → 可见 warn（契约②：缺 Key = 提示不是会话消失）；
    // 配 Key → 拟文时 ensureSessionAgent 直接可用
    hydrateSessionAgentVisible(ctx);
  }

  ctx.setLastUsageText('');
  ctx.updateFooter();
  ctx.addNotice(`已加载: ${label}`, 'info');
  // U4/Q1-B：总目记账退役（摊开集重启由磁盘扫描推导）
  // L1 数据上下文：开卷 = attach（事实校验——Rust 读卷快照 workspace 字段）
  // + 焦点。fire-and-forget：attach 失败 = Ungrouped（会话照常可用），
  // 不阻断开卷交互。归零重建后无 legacy_root（回退面已拆，attach 只信卷）。
  sessionScopeStore.getState().setCurrentSessionId(sid);
  void (async () => {
    try {
      await typedRpc('session_attach', {
        session_id: sid,
        workspace: projectPath || undefined,
      });
      await typedRpc('session_focus', { session_id: sid });
    } catch (e) {
      console.warn('[chat] session_attach/focus 失败（Ungrouped 继续）:', e);
    }
  })();
}

/** 将磁盘上的会话文件标记为已删除。归零重建：墓碑写全局位（唯一存储位）
 *  并携带 workspace 归属。 */
export async function deleteSessionFile(ctx: SessionContext, projectPath: string, sessionId: number): Promise<void> {
  // 用删除标记覆盖 — listSavedSessions 会过滤掉这些
  try {
    await typedRpc('write_file_content', {
      file_path: `${globalSessionsDir()}/${sessionId}.json`,
      content: JSON.stringify({
        id: sessionId,
        deleted: true,
        label: '',
        messages: [],
        savedAt: '',
        workspace: normWs(projectPath) || null,
      }),
    });
  } catch (e) {
    console.error('[chat] deleteSessionFile failed:', e);
    ctx.addNotice('删除案卷文件失败', 'error');
    return; // 写入失败则不关闭标签页
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
