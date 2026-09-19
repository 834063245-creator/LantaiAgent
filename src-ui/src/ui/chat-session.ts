// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 聊天面板 — 会话管理（CRUD、持久化、恢复）
// 从 chat.ts 的 ChatPanel 类中提取。
// 所有函数接收 SessionContext，而非访问 `this`。

import { agentSessionState, type OwnedAgentHandle, type TurnPair } from '../agent/agent-session-state';
import type { ChatAgentHandle } from '../agent/chat-agent-handle';
import { createExecState, type ExecStateInstance } from '../agent/execution-state';
import { log } from '../agent/logger';
import type { TokenLedgerSnapshot } from '../agent/token-meter/types';
import {
  detachSessionLogStore,
  inheritedMessageCount,
  openSessionLog,
  readVolumeLogMessages,
} from '../app/chat/session-log-store';
import { sessionExecute } from '../composition/session-persistence-service';
import type { Message } from '../provider/types';
import { kernelWriteFile } from '../rpc-contract';
import { getActiveProvider, loadSettings } from '../settings';
import { disposeAssetSessionStore, disposeAssetTables, rebuildAssetTableFromMessages } from '../state/asset-store';
import { getCanvasStore } from '../state/canvas-store';
import { type ComposeSessionPrefs, getComposeStore } from '../state/compose-store';
import { disposeMessagesStores, disposeSessionMessagesStore } from '../state/messages-store';
import { bumpSessionVolumes } from '../state/session-volumes-store';
import { showToast, TOAST_LONG_HOLD_MS } from '../state/toast-store';
import { deriveVolumeLabel, isUnnamedVolumeLabel, volumeDisplayName } from '../state/volume-name';
import { getWorkspaceEpoch, isCurrentEpoch } from '../workspace-scope';
import { useAgentPanelStore } from './agent-panel-store';
import { bumpSession, getChatStore, msgStoreFor } from './chat-store';
import type { AssistantMessage, BlockPart, ChatMessage, MessageId, SubAgentPart, UserMessage } from './message-model';
import {
  adoptRestoredMessages,
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
/** 轮次对（并发会话 2026-08-26：按卷键控——sessionId 缺省 = 活跃卷，
 *  null 显式传 = 面板级遗留键，仅在重置面使用）。 */
export function getTurnPairs(storeId: string, sessionId?: number): TurnPair[] {
  const sid = sessionId ?? getChatStore(storeId).sess.getState().sessions[getActiveIdx(storeId)]?.id ?? null;
  return agentSessionState.getTurnPairs(storeId, sid ?? null);
}
export function setTurnPairs(storeId: string, sessionId: number | null, pairs: TurnPair[]): void {
  agentSessionState.setTurnPairs(storeId, sessionId, pairs);
}
/** 按 id 取指定卷的 Agent 句柄（并发会话：事件流 ctx 的 getAgent 消费）。 */
export function getSessionAgent(storeId: string, sessionId: number): ChatAgentHandle | null {
  return agentSessionState.getAgent(storeId, sessionId);
}
export function getAgentFactory(storeId: string) {
  return agentSessionState.getAgentFactory(storeId);
}
export function setAgentFactory(
  storeId: string,
  fn: ((sessionId: number) => Promise<OwnedAgentHandle | null>) | null,
): void {
  agentSessionState.setAgentFactory(storeId, fn);
}

/** 获取或创建会话的 execState。 */
export function getSessionExecState(storeId: string, sessionId: number): ExecStateInstance {
  return agentSessionState.getOrCreateExec(storeId, sessionId);
}

/** 清理已关闭会话的 execState。 */
export function removeSessionExecState(storeId: string, sessionId: number): void {
  agentSessionState.removeExec(storeId, sessionId);
}

/** 装配收尾：给本卷装一本**新** exec 账，并把**同一实例**交给句柄——运行态
 *  单一权威源（2026-09-17「偶发：会话在跑而运行态丢失」根治）。
 *
 *  两个读账方必须是同一个对象：
 *  - UI 全域读注册表实例（chat-core._activeExec / useRunningSessions /
 *    ComposerDock / TocStrip）；
 *  - Agent 自起的轮次（`_onMessageDelivered`：异步子 Agent 回件 / 后台任务 bg /
 *    通信族消息）走句柄内部账本 `agent._execState`。
 *
 *  此前三条装配路径（createNewSession / ensureSessionAgent / loadSessionFromDisk）
 *  都在**工厂返回之后**才往注册表塞新实例，而工厂（workspace.ts:920
 *  `getSessionExecState`）早已把**旧实例**交给了 Agent ⇒ 同卷两本账。后果只落在
 *  Agent 自起的轮次上：卷里事件照流、模型照跑，UI 却认为空闲（呼吸线不亮、书眉无
 *  「行卷中」、停止钮按不动——chat-core.abort() 读注册表实例，`!isRunning` 直接
 *  return）；UI 发起的轮次反而看不出问题，所以病象是「偶发」。
 *
 *  装账 + 交账同处发生、紧邻 setAgent：并发装配竞态下「最后注册的句柄」与
 *  「最后装的账」仍是同一对（拆开就会在竞态里重新错位）。
 *  句柄无 `setExecState` 能力位（旧实现/测试桩）= 只有注册表一本账，降级不炸。 */
function bindSessionExec(ctx: SessionContext, sid: number, agent: OwnedAgentHandle): void {
  const exec = createExecState();
  agentSessionState.setExec(ctx.storeId, sid, exec);
  agent.setExecState?.(exec);
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
  disposeAssetTables(storeId);
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
  // 工作区全量重置：画布状态（摊开集合 + 公共物钉/纸条）一并清空——
  // 旧工作区摆放不得串入新工作区（Stage-5：state/canvas-store 工作区级）
  getCanvasStore(storeId).getState().clearCanvas();
  // 工作区全量重置：旧工作区全部会话级消息 store（storeId:sessionId）一并移除
  //（M4：store 注册表跨工作区存活，旧卷不拆 = 无界增长 + 新工作区撞号卷读到旧消息）
  disposeMessagesStores(storeId);
  disposeAssetTables(storeId);
  getChatStore(storeId).sess.setState({
    sessions: [],
    activeIdx: -1,
    sessionTokens: {},
    nextSessionId: nextId,
  });
  // 全新会话树 —— 清空一切旧草稿槽与 live 输入，会话 id 已变化
  getChatStore(storeId).input.getState().clearSessionDrafts();
  // 创作坞每会话偏好（模型/思考）同属工作区级状态——一并清空防串味
  getComposeStore(storeId).getState().clearAll();
  // 面板级遗留轮次对清空（会话级键由 clearPanelState 随面板全清）
  setTurnPairs(storeId, null, []);
}

/** 若会话**尚未命名**（空名，或旧存档遗留的默认名「案卷 N」/"会话 N"），则从第一
 *  条用户消息自动命名。在每轮对话完成后调用。sid 指定轮次所属卷（并发会话：后台卷
 *  跑完只命名自己）；缺省 = 活跃卷（遗留调用语义）。
 *  判据与派生都是 state/volume-name 的**同一把尺子**（与读盘路径同判——收口前
 *  这里严「\d+$」、读盘路径松「案卷␣前缀」，同一个名两条路答得不一样）。
 *  **枝卷只认自己的首条来文**（`inheritedMessageCount`）：继承来的前缀是父卷的复制，
 *  拿它起名 = 子卷顶着父卷的名（真机验收报的「卷名乱套」）。 */
export function autoTitleSessionIfDefault(storeId: string, sid?: number): void {
  const st = getChatStore(storeId).sess.getState();
  const { sessions, activeIdx } = st;
  const targetSid = sid ?? sessions[activeIdx]?.id;
  if (targetSid == null) return;
  const idx = sessions.findIndex((x) => x.id === targetSid);
  if (idx < 0) return;
  const s = sessions[idx];
  if (!s) return;

  // 仅在**未命名**时自动命名（判据单一真源：state/volume-name）
  if (!isUnnamedVolumeLabel(s.label)) return;

  const agent = agentSessionState.getAgent(storeId, s.id);
  if (!agent) return;

  const msgs = agent.getSession();
  const own = msgs.slice(inheritedMessageCount(agent.sessionLog));
  const firstUser = own.find((m) => m.role === 'user' && m.content && !m.content.startsWith('<compacted-context>'));
  if (!firstUser?.content) return;

  const derived = deriveVolumeLabel(firstUser.content);
  if (!derived) return;
  const updated = sessions.map((x, i) => (i === idx ? { ...x, label: derived } : x));
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

  /** 运行时访问，用于会话级 board 切换 */
  getRuntime?: () => import('../agent/runtime/types').RuntimePort | null;
}

// ── 辅助函数 ──

// （stripLineNumbers 已随 2026-09 fs(read) 行号默认翻转退役——kernelReadFile
//  缺省返回原文，行号格式仅 lineNumbers:true 显式请求，无消费者需要剥。）

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
      if (!ok) showToast('卷的 Agent 未就绪（API Key 未配置？）——拟文时会再试', 'warn');
    })
    .catch((e) => {
      console.error('[chat] 卷句柄补建失败:', e);
      showToast(`卷的 Agent 补建失败: ${e instanceof Error ? e.message : String(e)}`, 'error', TOAST_LONG_HOLD_MS);
    });
}

/** 会话卷的事件日志接线（换轨唯一入口）。
 *  在句柄刚到手、本轮尚未产生事件的窗口里调用：读盘 → 置回真源（+断尾修复+
 *  补悬空工具调用）→ 接到盘上。返回 `adopted` = 日志里有磁盘历史（调用方据此走
 *  `adoptSessionLog` 而不是整段 setSession）。
 *  句柄无 `sessionLog` 能力位（旧实现/测试桩）或工作区路径为空 = no-op（降级不炸）。
 *  头行**不写卷名**（2026-09-18 命名收口）：头行是 append-only 的物化一次，改名永不
 *  回写 ⇒ 那一份 label 总是陈旧副本（三份落地副本之一）。卷名的家 = 卷快照 `label`。 */
async function seedVolumeLog(ctx: SessionContext, sid: number, agent: OwnedAgentHandle): Promise<{ adopted: boolean }> {
  const logInstance = agent.sessionLog;
  if (!logInstance) return { adopted: false };
  const projectPath = ctx.getProjectPath();
  if (!projectPath) return { adopted: false };
  try {
    const opened = await openSessionLog(logInstance, {
      root: workspaceSessionsDir(projectPath),
      sessionId: sid,
      header: {
        type: 'session',
        version: 1,
        id: sid,
        createdAt: new Date().toISOString(),
        ...(agent.presetId ? { presetId: agent.presetId } : {}),
        cwd: projectPath,
      },
    });
    return { adopted: opened.adopted };
  } catch (e) {
    // 接线失败不挡会话（日志降级为「本轮不落盘」可见化）——但绝不静默。
    // 格式版本拒读（SessionLogFormatUnsupportedError）也走这里：会话照常打开
    // （内容退回快照面），「日志由更新版本写入」的事实已进 warn。
    log.warn('chat', `案卷 ${sid} 事件日志接线失败（本轮事件不落盘）`, { error: String(e) });
    return { adopted: false };
  }
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
  const agent = await factory(sid);
  if (!agent) return false;
  if (!isCurrentEpoch(epoch)) return false;

  // 事件日志接线（换轨 Phase 1）：在**任何本轮事件产生之前**把日志置回磁盘真源
  // （openSessionLog：有日志→restoreInPlace+append；无日志→materialize），
  // 否则本轮 append 会与上一次运行的 seq 撞号（重放面判损坏）。
  const seed = await seedVolumeLog(ctx, sid, agent);
  if (!isCurrentEpoch(epoch)) return false;

  // 会话内容回填：msgStore 的 ChatMessage 不是 provider 消息——从磁盘卷文件
  // 取原始会话（readVolumeData 与恢复路径同源：工作区会话根单读 + 已删/空卷过滤）。
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
  if (seed.adopted) {
    // **权威翻转（Phase 3b）**：日志已含磁盘历史 → 采用（一条头部重设事件），
    // 不再把历史整段写回事件日志（那会每次开卷 +1 份全文）。
    agent.adoptSessionLog?.(freshSys.map((m) => m.content ?? '').join('\n'));
  } else {
    agent.setSession([...freshSys, ...conv]);
  }

  // 二次校验句柄仍缺席（在途期间可能被并行的另一路径补建/移除）
  if (agentSessionState.getAgent(ctx.storeId, sid)) {
    agent.dispose();
    return true;
  }
  agentSessionState.setAgent(ctx.storeId, sid, agent);
  agent.bindSession?.(String(sid));
  bindSessionExec(ctx, sid, agent);
  // turnPairs 与 UI 消息已由 restoreFromLedger 的 rebuildMessagesFromMessages
  // 预填——无需重建（惰性卷内容层恢复时已做）。
  return true;
}

export function closeSession(ctx: SessionContext, idx: number): void {
  const st = getChatStore(ctx.storeId).sess.getState();
  const s = st.sessions[idx];
  if (!s) return;
  // C8 合卷自动存：被合卷在 agent dispose 前同步捕获快照、异步落盘（用户拍板）。
  // 数据捕获必须在 removeAgent 之前（句柄消亡后 getSession 不可再得）；
  // 写入目标路径在捕获时固定，无跨工作区串写风险（与 scheduleAutoSave 的
  // epoch 守卫防护面不同——那是延迟重读 store 的风险，这里快照即定局）。
  // uiMessages/compose 同步捕获（2026-09-09 修复）：C8 此前只落 provider
  // 消息——重开该卷被迫走降采样重建（工具 err/output 丢、_id 重发号），
  // 快照保真链（WO-7）在合卷口断裂。msgStore 在函数尾部才拆，此处可安全读。
  {
    const agent = agentSessionState.getAgent(ctx.storeId, s.id);
    const messages = agent?.getSession();
    const hasContent = !!messages?.some((m) => m.role !== 'system');
    if (agent && messages && hasContent) {
      const projectPath = ctx.getProjectPath();
      const tokensUsed = idx === st.activeIdx ? ctx.getTotalTokensUsed() : (st.sessionTokens[s.id] ?? 0);
      const uiMessages = msgStoreFor(ctx.storeId, s.id).getState().messages;
      const compose = getComposeStore(ctx.storeId).getState().getPrefs(String(s.id));
      writeSessionSnapshot(projectPath, {
        id: s.id,
        label: s.label,
        savedAt: new Date().toISOString(),
        messages,
        uiMessages: uiMessages.length > 0 ? uiMessages : undefined,
        tokensUsed,
        // token 账本 + 投影新鲜度随卷落盘（2026-09-18 修）：本条此前只写 tokensUsed
        // ——合卷后重开该卷，`tokens` 字段缺席 ⇒ 墨量册四桶全 0、缓存命中显示「—」，
        // 而合计走 tokensUsed 兜底（真机实测：合计 3,950,056 配四桶 0，看着像命中率坏了）。
        // 另两条落盘路径（saveActiveSession / saveSessionById）一直带着这三个字段
        // ——同一份卷快照形状，三条写路不许漂移。
        tokens: agent.snapshotTokenLedger?.() ?? undefined,
        seq: agent.sessionLog?.lastSeq ?? 0,
        ver: SESSION_CACHE_VERSION,
        compose,
      }).catch(() => showToast(`合卷落盘失败：${volumeDisplayName(s.label, s.id)}`, 'error', TOAST_LONG_HOLD_MS));
    }
  }
  removeSessionExecState(ctx.storeId, s.id);
  // 事件日志摘除（换轨 Phase 1）：先排空队列再随句柄消亡——否则签卷那一刻
  // 仍在 200ms 窗口里的尾事件会随 Agent 一起消失（DSH retirement drain 的兰台形）。
  {
    const closing = agentSessionState.getAgent(ctx.storeId, s.id);
    const logInstance = closing?.sessionLog;
    if (logInstance) void detachSessionLogStore(logInstance);
  }
  agentSessionState.removeAgent(ctx.storeId, s.id);
  // 合卷 = 流区从纸面退场（Stage-5）：摊开集合移除该卷位置（位置释放不重排）；
  // 公共物（钉住块/纸条）是工作区级宿主，不随卷退场——钉到拔为止。
  getCanvasStore(ctx.storeId).getState().removeRegion(String(s.id));
  // 合卷 = 卷消亡：该卷会话级消息 store 一并移除（M4——落盘快照已在上方
  // 从 agent 数据同步捕获，此处拆的是注册表项；续开该卷走磁盘恢复重建）
  disposeSessionMessagesStore(ctx.storeId, s.id);
  disposeAssetSessionStore(ctx.storeId, s.id);
  // 若关闭的是活跃会话，先把它未发送的文字存入其槽再清空，稍后换入新活跃会话的草稿
  const closingActive = idx === st.activeIdx;
  if (closingActive) {
    getChatStore(ctx.storeId).input.getState().saveSessionDraft(s.id);
  }
  // 丢弃被关闭会话的输入草稿槽 —— 关闭后不应再残留其未发送文字
  getChatStore(ctx.storeId).input.getState().clearSessionDraft(s.id);
  // 创作坞每会话偏好随卷消亡一并清理（Stage-4）
  getComposeStore(ctx.storeId).getState().removePrefs(String(s.id));

  const newSessions = [...st.sessions];
  newSessions.splice(idx, 1);

  // 合卷最后一卷 → 空画布（2026-08-28 会话管理专项延展）：空画布是合法态
  // （新工作区即空画布）。合卷语义 = 数据保留落盘，卷仍可从侧边栏
  // 「未摊开·已存卷」再摊开。旧「至少保留一卷案卷」守卫是标签页聊天时代
  // 的遗留——画布模型下收回全部卷不再有意义，删除/合卷统一允许清空画布。
  if (newSessions.length === 0) {
    getChatStore(ctx.storeId).sess.setState({ sessions: [], activeIdx: -1 });
    const runtime = ctx.getRuntime?.();
    if (runtime) {
      runtime.destroySessionBoards(String(s.id)).catch(() => {});
    }
    ctx.updateFooter();
    return;
  }

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

/** 建卷选项（S6 P4 程序入口）——`presetId` 指定本卷组合：在发号之后、调工厂
 *  **之前**写入卷级登记 ⇒ 该卷**出生即按此组合装配一次**（不白装配、不写全局
 *  设置）。缺省 = 今天语义（工厂读 null → 全局默认）。 */
export interface CreateSessionOptions {
  presetId?: string;
}

/** 建卷。返回新卷 id（`null` = 未建：无工作区 / 在途切走工作区被代际丢弃）。
 *  S6 P4 起返回 id 供**程序入口**判成败——此前返回 `void`，调用方只能事后读
 *  `sessions[activeIdx].id`，而静默失败路径会把**旧活跃卷的 id** 当成新卷。 */
export async function createNewSession(ctx: SessionContext, opts: CreateSessionOptions = {}): Promise<number | null> {
  // 零目录退役（Stage-5 拍板 a）：创建必须要有目录——无工作区（projectPath 空）
  // 不造零目录会话，改由首页选/建工作区。与「创建工作区必须要有目录」一致。
  const claimWs = ctx.getProjectPath();
  if (!claimWs) {
    showToast('新建案卷需要先有工作区——请在首页新建或指定工作区', 'warn');
    return null;
  }
  // 代际防护（H1 跨工作区串卷，2026-09-02）：与 loadSessionFromDisk 同款——
  // 工厂装配在途期间切走工作区，迟到的 append 不得落进新工作区 sess store。
  const epoch = getWorkspaceEpoch();
  // DSH 形态（2026-08-25）：信封先行——建卷是纯数据操作，立即摊开可见；
  // 句柄不是建卷的前置条件（拟文时 ensureSessionAgent 惰性现造）。
  // 工厂在场时顺手现造一个句柄（首次拟文的常见路径提前就绪）；
  // 工厂缺席/返空/抛错 → 无句柄建卷（拟文时提示配 Key——Phase B 契约）。
  //
  // 发号同步占位（2026-09-09 建卷竞态修复）：id 在任何 await 之前解析并推高
  // nextSessionId——并发建卷（案头双回车）不再铸同号卷（同号 = 两卷共享同一
  // msgStore/agent 槽位）；sessions 写回改函数式——工厂在途期间其它路径
  // （续开/批量恢复/并发建卷）对 sess store 的变更不再被陈旧快照整体覆写
  // （旧实现整表写回 [...st.sessions]，在途变更全被挤掉——「续开的卷从
  // 案头消失」的 lost-update 根因）。占号不回退：epoch 丢弃路径烧一个空号，
  // 与「发号下限保留」纪律一致。
  const id = getChatStore(ctx.storeId).sess.getState().nextSessionId;
  getChatStore(ctx.storeId).sess.setState({ nextSessionId: id + 1 });
  // S6 P4 程序入口：显式指定的组合在**工厂调用之前**落卷级登记——工厂按卷登记
  // 决定组合（workspace 工厂读 getRecordedPresetId），登记先于装配 ⇒ 出生即一次
  // 装配到位。（「出生后拨组合」是另一条语义，见 app/chat/session-composition。）
  if (opts.presetId) agentSessionState.setRecordedPresetId(ctx.storeId, id, opts.presetId);
  let newAgent: OwnedAgentHandle | null = null;
  const factory = getAgentFactory(ctx.storeId);
  if (factory) {
    try {
      // 方案甲：新卷句柄按「出生时刻的组合」装配——程序入口给了 presetId 就按上一步
      // 的卷级登记；否则此刻尚无会话覆盖，工厂读 null ⇒ 全局默认（裸 live）。
      newAgent = await factory(id);
    } catch {
      /* 装配失败 = 句柄缺席，内容层照常（错误由拟文路径可见） */
    }
  }
  // 在途期间已切走工作区 → 丢弃（同 loadSessionFromDisk：句柄就地 dispose，
  // 旧区新建卷不得 append 进新工作区）
  if (!isCurrentEpoch(epoch)) {
    newAgent?.dispose();
    return null;
  }
  // ponytail: 消息在会话级 store 中 — 无需保存/恢复。
  // 只需保存旧会话的 token 计数。
  {
    const stNow = getChatStore(ctx.storeId).sess.getState();
    if (stNow.activeIdx >= 0) {
      const oldSid = stNow.sessions[stNow.activeIdx].id;
      getChatStore(ctx.storeId).sess.getState().setSessionTokens(oldSid, ctx.getTotalTokensUsed());
      // 把旧会话的输入草稿存回其会话槽 —— 新建会话后切回旧 tab 时文字仍在
      getChatStore(ctx.storeId).input.getState().saveSessionDraft(oldSid);
    }
  }
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();
  if (newAgent) {
    // 事件日志接线（换轨 Phase 1）：新卷 = 无日志文件 → materialize
    // （首批把「头行 + 当时全部事件」原子物化；构造期的 reset/preset 一并落盘）。
    await seedVolumeLog(ctx, id, newAgent);
    agentSessionState.setAgent(ctx.storeId, id, newAgent);
    // 静态绑定该 Agent 的 board 到新会话（id 在 factory 之后才确定）
    newAgent.bindSession?.(String(id));
    bindSessionExec(ctx, id, newAgent);
  }
  getChatStore(ctx.storeId).sess.setState((s) => ({
    // 起卷 = **未命名**（2026-09-18 命名收口）：数字名不是写入值——显示兜底由
    // state/volume-name 的 volumeDisplayName 按档号给（旧实现写序数「案卷 N」，
    // 合卷 splice 之后再起一卷会与在案卷撞名）。首轮跑完由 autoTitleSessionIfDefault
    // 以首条来文命名。
    sessions: [...s.sessions, { id, label: '', createdAt: new Date().toISOString() }],
    activeIdx: s.sessions.length,
  }));
  // ponytail: 创建会话级消息 store — 唯一数据源
  msgStoreFor(ctx.storeId, id).getState().setMessages([]);
  resetMsgIdCounter();
  ctx.clearInputHistory();
  // 新会话无草稿槽 → 清空 live 输入，避免沿用上一会话未发送的文字
  getChatStore(ctx.storeId).input.getState().restoreSessionDraft(id);
  setTurnPairs(ctx.storeId, null, []);
  setTurnPairs(ctx.storeId, id, []);
  ctx.setTotalTokensUsed(0);
  getChatStore(ctx.storeId).sess.getState().setSessionTokens(id, 0);

  // 切换会话级 board 到新会话
  const runtime = ctx.getRuntime?.();
  if (runtime) {
    runtime.setCurrentSession(String(id));
    useAgentPanelStore.getState().setCurrentSessionId(String(id));
  }

  ctx.setLastUsageText('');
  ctx.updateFooter();
  // U4/Q1-B：总目记账退役（摊开集重启由磁盘扫描推导）
  return id;
}

// ── 会话持久化 — 每个工作区一个会话根，每卷一个文件（{ws}/.lantai/sessions/）──

/** 会话文件的持久化形状（磁盘 JSON）。
 *  Stage-5 起不再含 paper（钉住块/纸条/流区位置已升格工作区级——
 *  随 {workspace}/.lantai/canvas.json，不再随卷快照）。
 *  workspace-session-ownership-rework：不再写 workspace 字段——存储位置即归属。 */
export interface StoredSession {
  id: number;
  label?: string;
  savedAt?: string;
  /** 立卷时刻（ISO）——**不落快照**，读面每次取自卷日志头行（`SessionLogHeader.createdAt`，
   *  卷本体真源）。列在此处仅供 `readVolumeData` 的返回值携带（2026-09-16 卷首档行）。 */
  createdAt?: string;
  /** **父卷号**（会话树「枝」的血缘，2026-09-18）——同样**不落快照**：真源 = 卷日志
   *  头行 `SessionLogHeader.parent.id`（write-once），此处仅供 `readVolumeData` 的返回值
   *  携带（清单投影 `_index.json` 的血缘栏由它供数）。缺 = 根卷。 */
  parentId?: number;
  messages?: Message[];
  /** UI 消息副本（WO-7）：含 BlockPart 资产块；旧存档无此字段 = 仅 provider 消息。 */
  uiMessages?: ChatMessage[];
  tokensUsed?: number;
  /** token 账本快照（2026-09-13）：分桶用量/逐轮/压力/构成。
   *  `tokensUsed` 是它的总量投影（旧字段，坞在无句柄时用）；旧存档无
   *  `tokens` = 账本从空开始（不迁移，不编造历史）。 */
  tokens?: TokenLedgerSnapshot;
  /** 会话级创作坞覆盖（方案甲 2026-08-27）：旧存档无此字段 = 无覆盖。 */
  compose?: ComposeSessionPrefs;
  /** 本卷创建时点生效的组合 id（P0 记录闭环，2026-09-14）。
   *  「模型可见 ⟺ 已记录」：组合决定模型看到哪些工具/段落，卷必须能自证。
   *  旧存档无此字段 = 未知（不猜、不编造；恢复期不校验）。 */
  presetId?: string;
  /** 投影缓存新鲜度（Phase 3b 权威翻转）：写这份快照时事件日志的 lastSeq。
   *  读面 `cache.seq >= 日志 lastSeq` 才算新鲜；陈旧 = 当没有这份快照（重建 UI 面）。 */
  seq?: number;
  /** 缓存格式版本（与事件日志 `version` 分开——缓存可随时丢弃重建）。 */
  ver?: number;
  /** _active.json 跟踪文件字段（与单个会话文件形状不同） */
  lastId?: number;
  nextId?: number;
}

// ── 工作区会话根（workspace-session-ownership-rework 2026-08-27）────────────
// 会话**物理归属工作区**：唯一存储位 = {workspace}/.lantai/sessions/{id}.json。
// 归属 = 存储位置，无需 workspace 字段标签/路径归一匹配；零目录会话已退役，
// projectPath 恒为真实目录，不存在第二存储位。
//
// seam 接线（session-persistence-seam-wiring-plan C 定案，2026-09-05）：
// 卷 CRUD 全链经 sessionExecute 四动作（read_volume/list_volumes/save_volume/
// delete_volume）——默认 provider builtin/rust-sessions 内部转发 kernel* helper，
// 行为与今日直连逐字节一致（测试 mock 面零迁移）；换 provider（SQLite/远程仓）
// 即整链换存储，产品代码零改动。root = 本工作区会话根（下方唯一权威拼接点）。

/** 工作区会话目录（唯一权威存储位——消费方（chat-session/chat-core）一律
 *  经本导出拼 root，路径构造收敛单点）。
 *  P0（2026-09-15 存盘审计 M8）：空路径此前拼出 `/.lantai/sessions`——相对
 *  进程 CWD 解析（`ui.log` 实证落到 `D:\.lantai\sessions` 并被安全闸拒绝）。
 *  改为响亮报错：调用方各自的 catch 决定可见等级（读侧降级为「无卷」、写侧
 *  走落盘失败可见面），不再静默拼出工作区外路径。 */
export function workspaceSessionsDir(projectPath: string): string {
  const base = projectPath.replace(/[\\/]+$/, '');
  if (!base) {
    throw new Error('workspaceSessionsDir: 工作区路径为空——无法定位会话根（拒绝拼出 CWD 相对路径）');
  }
  return `${base}/.lantai/sessions`;
}

/** 读卷：工作区目录单一路径。缺失/坏文件返回 null——卷不在本工作区
 *  会话目录 = 不存在（无回退面）。read_volume 缺卷返回 'null'（判空语义与
 *  旧 readSessionJSONOrNull catch 等价——错误不静默在消费方 catch 面）。 */
async function readVolumeJSON(projectPath: string, id: number): Promise<StoredSession | null> {
  try {
    const raw = await sessionExecute('read_volume', {
      root: workspaceSessionsDir(projectPath),
      id: String(id),
    });
    if (raw === 'null') return null;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

/** 扫描本工作区会话目录，查找最大的数字会话 ID。无会话时返回 0。
 *  每工作区独立发号（workspace-session-ownership-rework 2026-08-27）——
 *  跨工作区撞号在结构上不可能（不同目录，天然隔离）。
 *  Phase 3b：**按 `.ndjson`（卷本体）认卷**；`.json` 只是投影缓存，不参与发号
 *  （否则缓存文件会让号段虚高或多算已删卷）。 */
export async function scanMaxSessionId(projectPath: string): Promise<number> {
  let maxId = 0;
  try {
    const root = workspaceSessionsDir(projectPath);
    const raw = await sessionExecute('list_volumes', { root });
    const names: unknown = JSON.parse(raw);
    if (!Array.isArray(names)) return maxId;
    for (const n of names) {
      const name = typeof n === 'string' ? n : '';
      if (!name || name.startsWith('_') || !name.endsWith('.ndjson')) continue;
      const sid = parseInt(name.replace(/\.ndjson$/, ''), 10);
      if (!Number.isNaN(sid) && sid > maxId) maxId = sid;
    }
  } catch {
    /* 目录缺席/读失败 = 空（首启常态） */
  }
  return maxId;
}

/** 会话快照的磁盘形状（C8：saveActiveSession 与合卷落盘共用）。
 *  compose：会话级创作坞覆盖（方案甲 2026-08-27）——只存显式改动过的卷，
 *  旧存档无此字段 = 无覆盖（实时跟随全局默认）。
 *  Stage-5：不再含 paper——布局/公共物已升格工作区级（canvas-store）。
 *  workspace-session-ownership-rework：不再写 workspace 字段——存储位置即归属。 */
interface SessionSnapshotData {
  id: number;
  label: string;
  savedAt: string;
  messages: Message[];
  /** UI 消息副本（WO-7）：见 StoredSession.uiMessages。 */
  uiMessages?: ChatMessage[];
  tokensUsed: number;
  /** token 账本快照（2026-09-13）：见 StoredSession.tokens。 */
  tokens?: TokenLedgerSnapshot;
  compose?: ComposeSessionPrefs;
  /** 组合身份（P0 记录闭环）：见 StoredSession.presetId。 */
  presetId?: string;
  /** 投影缓存新鲜度（Phase 3b）：见 StoredSession.seq。 */
  seq?: number;
  ver?: number;
}

/** 投影缓存的格式版本（与事件日志 version 分开——缓存可丢弃重建）。 */
const SESSION_CACHE_VERSION = 1;

/** 将已捕获的会话快照写入存储（save_volume——默认 provider 落工作区会话根
 *  {projectPath}/.lantai/sessions/{id}.json；替代 provider 自管存储）。
 *  C8 合卷自动存从 saveActiveSession 离体出来的共享写盘函数——调用方负责
 *  在 agent 句柄消亡前完成数据捕获（messages 属引用，序列化在首次 await 前）。
 *  workspace-session-ownership-rework（2026-08-27）：落盘目标 = 工作区会话根
 *  （workspace 字段标签退役；localStorage 备份早已拆除——磁盘是唯一事实源）。
 *  失败：console.error 后上抛——调用方决定可见等级（autosave 容忍、合卷告警）。 */
// ── 每卷写链（P0·2026-09-15 存盘审计 M4）────────────────────────────
//
// 同一卷的落盘串行化：后一写等前一写 settle 才发起。此前无串行——防抖写、
// 后台卷写、改名即存、合卷快照、失活写、退出 flush 可同时压向同一文件，
// 到达 Rust 的顺序无保证（`confined_fs::write_atomic` 非临界区），迟到的旧
// 快照会覆盖新快照（静默回滚）。写链把「谁最后写」钉成「谁最后被要求写」。
//
// 键 = 目标文件路径（同一文件 = 同一链，跨面板同号卷不互串）；失败不阻断链
// （下一条照常发起——写链不是门禁），错误照旧上抛给调用方。

const _volumeWriteChains = new Map<string, Promise<unknown>>();
/** drain 轮数上限（等写时若新写持续入链，避免无界等待）。 */
const VOLUME_WRITE_DRAIN_ROUNDS = 8;

function enqueueVolumeWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = _volumeWriteChains.get(key) ?? Promise.resolve();
  // 前一条无论成败都继续本条（写链不做门禁）
  const next = prev.then(task, task);
  _volumeWriteChains.set(key, next);
  const settle = (): void => {
    if (_volumeWriteChains.get(key) === next) _volumeWriteChains.delete(key);
  };
  next.then(settle, settle);
  return next;
}

// ── 卷目录：清单投影（持久化）──────────────────────────────────────
//
// 病灶（P0·2026-09-18 侧栏载入审计，两批）：listSavedSessions 一次清点 = 读**全部
// 卷体**（每卷：事件日志逐行 JSON.parse + 重放 + 重建消息 + 整份投影缓存），只为取
// label / savedAt / 块数三字段。实测本机 32 MB 目录 → 读 21.22 MB / 14 次文件读 /
// 240 ms（纯 JS，不含 IPC）出 7 行——**成本正比于历史总体量**：几百卷 = 几百 MB，
// 每次清点都是十几秒，10s 超时必爆（用户 2026-09-18：「几百条会话历史很正常」）。
//
// 解法：把清单投影**持久化**成 `{root}/_index.json`（走既有 seam 动作
// read_volume / save_volume，id = `_index`——**零契约变更、零 Rust 变更**；provider
// 只认「root + id → 不透明 JSON」，换 SQLite/远端 provider 同样成立）。此后每次
// 清点 = 目录枚举 + 一份小 JSON（几百卷 ≈ 20 KB），**一卷体都不读**。
//
// 失效面（谁能改变清单）：
//   · 本进程写面（自动存 / 改名 / 合卷 / 删除）→ 就地更**已建**行 + 落盘（写面自己
//     知道 label/savedAt/块数三栏真值；**血缘不在写面**——新建一律留给补建，见
//     `upsertCatalogRow` 注）；删除 → 摘行；
//   · 目录枚举逐次对账（**文件不在 = 卷不存在**）：目录里多出来的卷补建、少掉的摘掉；
//   · 事件日志 append（只发生在**已摊开**的卷上，其行由内存投影供数）：不在失效面。
// 补建（读该卷日志 + 投影缓存——老实现的全量读）**每卷一生只发生一次**：首次调用
// 阻塞到 CATALOG_BLOCK_BUDGET_MS 为止，其余转后台（并发 4）分批落盘，每批完成即广播
// （消费面自动刷新）；落盘是增量合并的，进程半途退出不丢已建部分。
//
// 边界（刻意不做，见 landmine-map S8 残留栏）：目录条目不带 size/mtime，故**外部**
// 对已知卷的内容改写（换机器拷回、另开一个应用实例并发写同一工作区）不被察觉——
// 本目录与每卷写链 / canvas.json 同款前提：由本进程独占写入。要真门禁需 Rust
// DirEntry 补 size/mtime + seam 新动作，属独立批次。
//
// 键 = 会话根（工作区各归各，切换天然隔离）。模块级可变态归属 CONVENTIONS §1.10
// 第 3 类（键控自清理：键 = 会话根，值 = 该根的投影 + 落盘状态，不持工作区资源所有权）。

/** 会话清单行（侧栏/书脊/签条共用形状——磁盘投影三字段 + 身份 + 血缘）。 */
export interface SavedSessionRow {
  id: number;
  /** **原样**卷名（空 = 未命名）——显示兜底按档号，走 state/volume-name。 */
  label: string;
  msgCount: number;
  savedAt: string;
  /** 父卷号（会话树「枝」——侧栏树形的那条边）。缺 = 根卷。
   *  真源 = 卷日志头行（`StoredSession.parentId`），故**只由补建（读头行）产生**：
   *  快照写面带不出血缘（见 `upsertCatalogRow` 注）。 */
  parentId?: number;
}

/** 目录文件 id（`{root}/_index.json`——下划线保留名，各消费方的卷集过滤天然跳过）。 */
const CATALOG_ID = '_index';
/** 目录文件版本（结构变更即 +1；版本不认 = 视为无目录重建）。
 *  v2（2026-09-18）：行加 `parentId`（会话树「枝」的血缘）——v1 行没有这一栏，
 *  不认版本即整份重建（补建读头行，血缘一次到位），不做就地补读。 */
const CATALOG_VERSION = 2;
/** 首次补建的**阻塞**预算（ms）：预算内补齐多少算多少，其余转后台（不吊死首屏）。 */
const CATALOG_BLOCK_BUDGET_MS = 2500;
/** 补建并发（每卷 = 日志 + 投影缓存两跳读；并发过高只是把 IPC 挤满）。 */
const CATALOG_BUILD_CONCURRENCY = 4;

interface VolumeCatalog {
  /** 已知行（内存真源：写面就地更行 + 补建填入 + 文件载入）。 */
  rows: Map<number, SavedSessionRow>;
  /** 目录文件是否已读入（每根每进程一次）。 */
  loaded: boolean;
  loading: Promise<void> | null;
  /** 补建在途的卷（防并发清点重复读同一卷）。 */
  hydrating: Set<number>;
  /** 本次运行内判过读失败的卷（不反复重试——下个运行周期再试）。 */
  failed: Set<number>;
  /** 首扫阻塞补建中（防重入——期间的并发清点直接返回已知行，不重复补建）。 */
  blocking: boolean;
  /** 后台补建中（防重入）。 */
  building: boolean;
  /** 落盘在途 / 待落盘（合并：一个在途 + dirty 标记，避免逐行写风暴）。 */
  flushing: boolean;
  dirty: boolean;
}

const _volumeCatalogs = new Map<string, VolumeCatalog>();

function catalogOf(root: string): VolumeCatalog {
  let cat = _volumeCatalogs.get(root);
  if (!cat) {
    cat = {
      rows: new Map(),
      loaded: false,
      loading: null,
      hydrating: new Set(),
      failed: new Set(),
      blocking: false,
      building: false,
      flushing: false,
      dirty: false,
    };
    _volumeCatalogs.set(root, cat);
  }
  return cat;
}

function catalogPath(root: string): string {
  return `${root}/${CATALOG_ID}.json`;
}

/** 目录文件落盘（构造读-改-写不需要：内存就是全量真源；写失败可见但不阻断——
 *  最坏结果是下次运行重读几卷补建，不是数据错）。 */
function flushCatalog(cat: VolumeCatalog, root: string): void {
  cat.dirty = true;
  if (cat.flushing) return;
  cat.flushing = true;
  const pump = (): void => {
    if (!cat.dirty) {
      cat.flushing = false;
      return;
    }
    cat.dirty = false;
    const rows: Record<string, { label: string; savedAt: string; msgCount: number; parentId?: number }> = {};
    for (const [id, r] of cat.rows) {
      rows[String(id)] = {
        label: r.label,
        savedAt: r.savedAt,
        msgCount: r.msgCount,
        // 缺 = 根卷（JSON 丢 undefined 键——缺席即无父，读面同判）
        ...(r.parentId != null ? { parentId: r.parentId } : {}),
      };
    }
    const data = JSON.stringify({ ver: CATALOG_VERSION, rows });
    void enqueueVolumeWrite(catalogPath(root), () => sessionExecute('save_volume', { root, id: CATALOG_ID, data }))
      .catch((e) => {
        // 落盘失败可见（不静默）——后果仅限「下次运行重读几卷补建」
        console.warn('[chat] 卷目录落盘失败（下次运行补建）:', e);
      })
      .finally(pump);
  };
  pump();
}

/** 目录文件载入（每根每进程一次）。坏档/版本不认 = 空目录 + 全量补建（自愈，可见）。 */
function loadCatalog(cat: VolumeCatalog, root: string): Promise<void> {
  if (cat.loaded) return Promise.resolve();
  if (cat.loading) return cat.loading;
  cat.loading = (async () => {
    try {
      const raw = await sessionExecute('read_volume', { root, id: CATALOG_ID });
      if (raw !== 'null') {
        const parsed = JSON.parse(raw) as { ver?: unknown; rows?: unknown };
        if (parsed?.ver !== CATALOG_VERSION) {
          console.warn(`[chat] 卷目录版本不认（${String(parsed?.ver)}）——按空目录重建`);
        } else if (parsed.rows && typeof parsed.rows === 'object') {
          for (const [key, v] of Object.entries(parsed.rows as Record<string, unknown>)) {
            const id = Number(key);
            const row = v as { label?: unknown; savedAt?: unknown; msgCount?: unknown; parentId?: unknown };
            if (!Number.isFinite(id) || typeof row?.label !== 'string') continue;
            // 本地写入优先（载入不得覆盖本次运行已更的行）
            if (cat.rows.has(id)) continue;
            cat.rows.set(id, {
              id,
              label: row.label,
              savedAt: typeof row.savedAt === 'string' ? row.savedAt : '',
              msgCount: typeof row.msgCount === 'number' ? row.msgCount : 0,
              // 血缘形状不对 = 当根卷（毒化容忍同 parseHeader：不让一栏脏数据毁掉整行）
              ...(Number.isInteger(row.parentId) && (row.parentId as number) > 0
                ? { parentId: row.parentId as number }
                : {}),
            });
          }
        }
      }
    } catch (e) {
      // 缺失是首启常态（provider 返 'null'）；这里只接坏 JSON/读失败——自愈重建，可见
      console.warn('[chat] 卷目录读取失败（按空目录重建）:', e);
    } finally {
      cat.loaded = true;
      cat.loading = null;
    }
  })();
  return cat.loading;
}

/** 单卷补建：读该卷日志 + 投影缓存（老实现的全量读，**每卷一生一次**）。 */
async function hydrateVolumeRow(projectPath: string, id: number): Promise<SavedSessionRow | null> {
  const data = await readVolumeData(projectPath, id);
  if (!data) return null;
  return {
    id: data.id || id,
    // 原样带出（空 = 未命名）——显示兜底是**呈现层**的事（state/volume-name），
    // 不在这里把「案卷 N」写进数据（那正是旧实现把显示值洗成真值的路径）。
    label: data.label ?? '',
    msgCount: (data.messages ?? []).filter((m) => m.role !== 'system').length,
    savedAt: data.savedAt || '',
    // 血缘 = 卷日志头行（`readVolumeData` 已从头行取；缺 = 根卷）
    ...(data.parentId != null ? { parentId: data.parentId } : {}),
  };
}

/** 补建一批（并发 CATALOG_BUILD_CONCURRENCY）：返回是否全部成功填入。 */
async function hydrateBatch(cat: VolumeCatalog, root: string, projectPath: string, ids: number[]): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      if (cat.hydrating.has(id)) return;
      cat.hydrating.add(id);
      try {
        const row = await hydrateVolumeRow(projectPath, id);
        if (row) cat.rows.set(row.id, row);
        else cat.failed.add(id); // 空卷/真删——不再重试
      } catch (err) {
        // 读面失败必须可见（M9：此前静默少一卷）
        console.error(`[chat] 卷目录补建: 卷 ${id} 读取失败（本轮不再重试）`, err);
        cat.failed.add(id);
      } finally {
        cat.hydrating.delete(id);
      }
    }),
  );
  flushCatalog(cat, root);
}

/** 补齐缺失行：预算内**阻塞**（首屏尽量给全），其余转后台分批补 + 每批广播。 */
async function buildMissingRows(
  cat: VolumeCatalog,
  root: string,
  projectPath: string,
  missing: number[],
): Promise<void> {
  const deadline = Date.now() + CATALOG_BLOCK_BUDGET_MS;
  const queue = [...missing];
  cat.blocking = true;
  try {
    while (queue.length > 0) {
      if (Date.now() >= deadline) break;
      const batch = queue.splice(0, CATALOG_BUILD_CONCURRENCY);
      // 单批护栏：读盘卡死也不吊死首屏（超时后这批的续体仍会自行落账——hydrateBatch
      // 内部逐卷 try/catch，不会 reject；护栏计时器必须清掉，否则每批留一根悬空 timer）
      let guard: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        hydrateBatch(cat, root, projectPath, batch),
        new Promise<void>((resolve) => {
          guard = setTimeout(resolve, CATALOG_BLOCK_BUDGET_MS);
        }),
      ]);
      if (guard) clearTimeout(guard);
      // 每批广播：消费面立即重读（并发清点因 blocking 旗标直接返回已知行）——
      // 首扫期间列表就渐进成形，不是「空等到补完」
      bumpSessionVolumes();
    }
  } finally {
    cat.blocking = false;
  }
  const complete = queue.length === 0;
  bumpSessionVolumes();
  if (complete || cat.building) return;
  cat.building = true;
  void (async () => {
    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, CATALOG_BUILD_CONCURRENCY);
        await hydrateBatch(cat, root, projectPath, batch);
        // 每批广播：消费面重读清单（写面已更行，重读零卷体 I/O）——列表渐进成形
        bumpSessionVolumes();
      }
    } finally {
      cat.building = false;
      flushCatalog(cat, root);
      bumpSessionVolumes();
    }
  })();
}

/** 写面就地更行（写完 = 该卷磁盘状态已知）+ 落盘。
 *
 *  **只更已建行，不新建**（2026-09-18 会话树「枝」）：写面（快照落盘）知道
 *  label/savedAt/块数三栏的真值，但**不知道血缘**——`parentId` 的真源是
 *  `.ndjson` 头行，快照里没有它（`rowFromSnapshot` 无此字段）。若在这里新建一行，
 *  那一行会永远缺 `parentId`（行一旦存在就不再补建）⇒ 侧栏树上「枝」的边静默丢失。
 *  故新建一律留给**补建**（`hydrateVolumeRow` 读头行，血缘一次到位）——代价是
 *  新卷首次清点多读它一次（与「每卷一生一次」的既有预算同族），换来的是
 *  「行 = 补建行」这条不变式：凡在场之行，血缘必已定。
 *  已建行照旧就地更三栏（parentId 是 write-once，不在更新面内）。 */
function upsertCatalogRow(root: string, row: SavedSessionRow): void {
  const cat = catalogOf(root);
  const prev = cat.rows.get(row.id);
  if (!prev) return;
  cat.rows.set(row.id, { ...row, ...(prev.parentId != null ? { parentId: prev.parentId } : {}) });
  cat.failed.delete(row.id);
  flushCatalog(cat, root);
}

/** 写面就地摘行（真删 / 写失败后状态未知——下次清点按需补建）。 */
function dropCatalogRow(root: string, id: number): void {
  const cat = catalogOf(root);
  if (!cat.rows.delete(id)) return;
  flushCatalog(cat, root);
}

/** 卷清单行由快照派生（写面就地更行的唯一形状来源——与补建同口径：
 *  块数 = 非 system 消息数）。快照无 messages（只改元数据的写）= 无行可更
 *  （调用方退回摘行——下次清点补建，不猜块数）。 */
function rowFromSnapshot(data: {
  id: number;
  label: string;
  savedAt: string;
  messages?: ReadonlyArray<{ role?: string }>;
}): SavedSessionRow | null {
  if (!Array.isArray(data.messages)) return null;
  return {
    id: data.id,
    label: data.label, // 原样（空 = 未命名；显示兜底在呈现层）
    msgCount: data.messages.filter((m) => m.role !== 'system').length,
    savedAt: data.savedAt,
  };
}

/** 清空卷目录内存态（跨用例隔离——模块级态不做测试间泄漏；磁盘上的目录文件
 *  由各用例的 mock 盘自理）。 */
export function resetSessionListCacheForTests(): void {
  _volumeCatalogs.clear();
}

/** 等在途卷写全部 settle（退出 flush 的 drain 点——保证「退出快照」最后落盘）。 */
export async function drainVolumeWrites(): Promise<void> {
  for (let round = 0; round < VOLUME_WRITE_DRAIN_ROUNDS; round++) {
    const pending = [..._volumeWriteChains.values()];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

/**
 * 会话落盘结果（P0·2026-09-15 存盘审计 M6）：调用方据此可见化。此前无句柄/
 * 空卷一律静默 `return`——退出收尾无法知道「哪些卷没落盘」，用户看到的是
 * 「卷还在但内容旧」。区分「本来就没内容」（正常）与「有内容但写不了」
 * （异常）是关键：前者静默、后者必须可见。
 */
export type SessionSaveOutcome = 'saved' | 'skipped-empty' | 'skipped-no-handle' | 'skipped-no-workspace' | 'failed';

/** 逐卷落盘汇总（退出 flush 的可见面——`shell/rows/persistence` 据此报「哪些卷没落盘」）。 */
export interface SessionSaveReport {
  total: number;
  saved: number;
  /** 跳过（空卷/无句柄/无工作区——含「有内容但写不了」的异常跳过，见 anomalies）。 */
  skipped: number;
  failed: number;
  /** 只记非 saved 的卷明细（正常空卷也在内——调用方按 outcome 判等级）。 */
  anomalies: Array<{ sid: number; outcome: SessionSaveOutcome }>;
  /** 退出 flush 专用：确有被取消的待防抖落盘（M7）。 */
  cancelledDebounce?: boolean;
}

export function summarizeSaveReport(results: Array<{ sid: number; outcome: SessionSaveOutcome }>): SessionSaveReport {
  const anomalies = results.filter((r) => r.outcome !== 'saved');
  return {
    total: results.length,
    saved: results.length - anomalies.length,
    skipped: anomalies.filter((r) => r.outcome !== 'failed').length,
    failed: anomalies.filter((r) => r.outcome === 'failed').length,
    anomalies,
  };
}

/** 落盘跳过/失败的一次性可见化（同键只 warn 一次——autosave 高频触发不刷屏）。 */
const _warnedSaveSkips = new Set<string>();
function warnSaveAnomaly(key: string, msg: string): void {
  if (_warnedSaveSkips.has(key)) return;
  _warnedSaveSkips.add(key);
  console.warn(msg);
  log.warn('chat', msg);
}

async function writeSessionSnapshot(projectPath: string, data: SessionSnapshotData): Promise<void> {
  // 序列化在入链前完成（快照语义 = 调用时刻的会话，不被前序写在途拖成旧值）
  const json = JSON.stringify(data);
  const root = workspaceSessionsDir(projectPath);
  const target = `${root}/${data.id}.json`;
  try {
    await enqueueVolumeWrite(target, () =>
      sessionExecute('save_volume', {
        root,
        id: String(data.id),
        data: json,
      }),
    );
  } catch (e) {
    // 写失败：该卷磁盘状态未知 → 摘掉它的目录行（下次清点按需补建，不猜）
    dropCatalogRow(root, data.id);
    console.error('[chat] 会话落盘失败:', e);
    throw e;
  }
  // 写成功：该卷磁盘状态已知 → 就地更**已建**行 + 落盘（清单消费面无需重扫——见
  // 「卷目录」头注）；行尚未建（新卷首次落盘）→ 留给补建读头行（写面不知道血缘，
  // 见 `upsertCatalogRow` 注）。快照无 messages（只改元数据的写）时无处更行 → 摘行
  // （下次清点补建，不猜块数）。
  // 最后广播「卷清单已变更」——消费面（侧栏/书脊）据此重读（零卷体 I/O 的投影取回）；
  // 顺序要紧：先更行再广播，订阅者读到的就是写后状态。
  const row = rowFromSnapshot(data);
  if (row) upsertCatalogRow(root, row);
  else dropCatalogRow(root, data.id);
  bumpSessionVolumes();
}

/** 将活跃会话保存到其独立文件（工作区会话根——归属即存储位置）。
 *  U4/Q1-B：tracker（_active.json）与总目（_ledger.json）均已退役——
 *  摊开集重启由磁盘扫描推导，落盘只写卷文件本身。 */
export async function saveActiveSession(ctx: SessionContext, projectPath: string): Promise<SessionSaveOutcome> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  if (activeIdx < 0) return 'skipped-empty';
  const sMeta = sessions[activeIdx];
  if (!sMeta) return 'skipped-empty';
  if (!projectPath) {
    warnSaveAnomaly(`no-workspace:${ctx.storeId}`, '会话未落盘：工作区路径为空（无工作区 = 无会话存储位）');
    return 'skipped-no-workspace';
  }
  const agent = agentSessionState.getAgent(ctx.storeId, sMeta.id);
  if (!agent) {
    // P0（M6）：此前静默 return —— 该卷在案头显示、内容却只在内存，退出即丢
    warnSaveAnomaly(
      `no-handle:${ctx.storeId}:${sMeta.id}`,
      `案卷 ${sMeta.id} 未落盘：Agent 句柄缺席（卷内容只在内存）——拟文或切回可补建句柄`,
    );
    return 'skipped-no-handle';
  }

  const messages = agent.getSession();
  // 不持久化空会话（仅系统提示，无用户消息）
  if (!messages.some((m) => m.role !== 'system')) return 'skipped-empty';

  // ponytail: 消息已在会话级 store 中 — 无需 saveCurrentMessages
  getChatStore(ctx.storeId).sess.getState().setSessionTokens(sMeta.id, ctx.getTotalTokensUsed());

  const data: SessionSnapshotData = {
    id: sMeta.id,
    label: sMeta.label,
    savedAt: new Date().toISOString(),
    messages,
    uiMessages: msgStoreFor(ctx.storeId, sMeta.id).getState().messages,
    tokensUsed: ctx.getTotalTokensUsed(),
    // token 账本随卷落盘（2026-09-13）：分桶/逐轮/构成/压力整本带走——
    // 重启后读数从卷文件恢复（空账本 = undefined，字段省略）。
    tokens: agent.snapshotTokenLedger?.() ?? undefined,
    // 方案甲：会话级创作坞覆盖随卷落盘（无覆盖 = undefined，字段省略）
    compose: getComposeStore(ctx.storeId).getState().getPrefs(String(sMeta.id)),
    // 组合身份随卷落盘（P0 记录闭环，2026-09-14）：真源 = 本卷 Agent 的 presetId
    // 能力位；句柄不实现（旧实现/测试桩）= **无记录**（字段省略）——不猜全局默认，
    // 「卷记录的是这一卷当时跑的组合」，不是别人的选择。
    presetId: agent.presetId,
    // 投影缓存新鲜度（Phase 3b）：写盘时刻的事件日志头序号——读面据此判陈旧
    seq: agent.sessionLog?.lastSeq ?? 0,
    ver: SESSION_CACHE_VERSION,
  };

  try {
    await writeSessionSnapshot(projectPath, data);
    return 'saved';
  } catch {
    /* 落盘失败已由 writeSessionSnapshot 记日志 + 上抛——autosave 链容忍（原行为） */
    return 'failed';
  }

  // U4/Q1-B：无 tracker 写入（见函数头注释）——落盘只写卷文件
}

/** 按 id 落盘指定会话（C8 改名即存）：不要求是活跃卷。落盘 = 工作区会话根。
 *  空卷跳过（与 saveActiveSession 同规）。 */
export async function saveSessionById(
  ctx: SessionContext,
  projectPath: string,
  sid: number,
): Promise<SessionSaveOutcome> {
  const st = getChatStore(ctx.storeId).sess.getState();
  const sMeta = st.sessions.find((x) => x.id === sid);
  if (!sMeta) return 'skipped-empty';
  if (!projectPath) {
    warnSaveAnomaly(`no-workspace:${ctx.storeId}`, '会话未落盘：工作区路径为空（无工作区 = 无会话存储位）');
    return 'skipped-no-workspace';
  }
  const agent = agentSessionState.getAgent(ctx.storeId, sid);
  if (!agent) {
    warnSaveAnomaly(
      `no-handle:${ctx.storeId}:${sid}`,
      `案卷 ${sid} 未落盘：Agent 句柄缺席（卷内容只在内存）——拟文或切回可补建句柄`,
    );
    return 'skipped-no-handle';
  }
  const messages = agent.getSession();
  if (!messages.some((m) => m.role !== 'system')) return 'skipped-empty';

  const isActive = st.sessions[st.activeIdx]?.id === sid;
  const tokensUsed = isActive ? ctx.getTotalTokensUsed() : (st.sessionTokens[sid] ?? 0);
  try {
    await writeSessionSnapshot(projectPath, {
      id: sMeta.id,
      label: sMeta.label,
      savedAt: new Date().toISOString(),
      messages,
      uiMessages: msgStoreFor(ctx.storeId, sid).getState().messages,
      tokensUsed,
      // token 账本随卷落盘（与活跃卷同构）
      tokens: agent.snapshotTokenLedger?.() ?? undefined,
      // 方案甲：会话级创作坞覆盖随卷落盘（与活跃卷同构）
      compose: getComposeStore(ctx.storeId).getState().getPrefs(String(sid)),
      // 组合身份随卷落盘（与活跃卷同构；能力位缺省 = 无记录）
      presetId: agent.presetId,
      // 投影缓存新鲜度（与活跃卷同构）
      seq: agent.sessionLog?.lastSeq ?? 0,
      ver: SESSION_CACHE_VERSION,
    });
    return 'saved';
  } catch {
    /* 已记日志——改名即存是尽力而为（合卷路径另有告警） */
    return 'failed';
  }
}

/** 全部在案卷显式落盘（退出 flush 的写面单点）：跨卷并发、单卷串行（每卷写链）
 *  ——逐卷结果汇总返回，不抛（可见性由汇总的 anomalies 承担）。
 *  只覆盖「案头摊开的卷」：已合卷/未摊开卷的落盘由各自收尾路径负责。 */
export async function saveAllSessions(ctx: SessionContext, projectPath: string): Promise<SessionSaveReport> {
  const { sessions } = getChatStore(ctx.storeId).sess.getState();
  const results = await Promise.all(
    sessions.map(async (s) => ({ sid: s.id, outcome: await saveSessionById(ctx, projectPath, s.id) })),
  );
  return summarizeSaveReport(results);
}

/** 改名未摊开的已存卷（Stage-3 侧边栏行操作）：磁盘直改 label，不要求
 *  句柄/不摊开卷。读取当前工作区会话根的卷文件 → 保留 messages/tokens
 *  原样 → 重写同一路径（归属 = 存储位置，无字段改写面）。 */
export async function renameSessionFile(projectPath: string, sessionId: number, label: string): Promise<void> {
  const data = await readVolumeJSON(projectPath, sessionId);
  if (!data) {
    showToast('案卷文件不存在，无法改名', 'error');
    return;
  }
  try {
    // ⚡ 连带修复（2026-09-14 审计）：改名此前**重建**卷对象（只写 6 个字面字段），
    // 于是 `tokens`（token 账本）与 `compose`（创作坞覆盖）被静默抹掉——改名即丢数据。
    // 现改为「展开原卷 → 只覆盖 label」：未知/后续新增字段天然保留（presetId 等）。
    await writeSessionSnapshot(projectPath, {
      ...data,
      id: data.id,
      label,
      savedAt: data.savedAt ?? new Date().toISOString(),
      messages: data.messages ?? [],
      tokensUsed: data.tokensUsed ?? 0,
    });
  } catch {
    /* writeSessionSnapshot 已记日志；此处不重复静默 */
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
    // Phase D（错误不静默，2026-08-28 会话管理专项）：自动保存失败此前
    // catch{} 静默吞——磁盘满/权限/路径错误时本轮对话静默丢失。可见化。
    saveActiveSession(ctx, projectPath).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[chat] 自动保存失败:', e);
      showToast(`⚠️ 案卷自动保存失败: ${msg}`, 'error', TOAST_LONG_HOLD_MS);
    });
  }, AUTO_SAVE_DELAY_MS);
  _autoSaveTimers.set(ctx.storeId, timer);
}

/** 取消防抖落盘（不重挂、不立即触发）——P0·2026-09-15 存盘审计 M7：退出钩子
 *  此前调 `scheduleAutoSave`（先 clear 再 setTimeout 500ms），等于把待落盘推迟
 *  到窗口消失之后。退出路径必须「取消防抖 + 立即显式落盘」，本函数是前半句。
 *  返回 true = 确有被取消的待落盘（调用方可据此记录）。 */
export function cancelScheduledAutoSave(storeId: string): boolean {
  const t = _autoSaveTimers.get(storeId);
  if (!t) return false;
  clearTimeout(t);
  _autoSaveTimers.delete(storeId);
  return true;
}

/** Q-B（2026-08-24 用户拍板）：重启/装配不自动摊开任何卷，落点为案卷首页
 *  （用户从全局列表自选要开的卷；“最近 3 卷”是总目退役后无语义的猜测，弃）。
 *  本函数退化为发号对账：扫描本工作区会话根推导 nextSessionId（避免新建撞号），
 *  不写 sess store 摊开集、不建兜底卷。崩溃加速语义不受影响：
 *  loadSessionFromDisk 打开时从工作区会话根读全量快照。
 *  workspace-session-ownership-rework（2026-08-27）：发号 = 本工作区独立
 *  （scanMax 只算本区目录）——跨工作区撞号在结构上不可能。 */
export async function autoRestoreLastSession(ctx: SessionContext, projectPath: string): Promise<void> {
  // 代际防护（H5）：对账在途期间可能切换工作区 — 写入前校验，过期丢弃。
  const epoch = getWorkspaceEpoch();

  // #5 修复：用 scanMaxSessionId（仅 list_directory，不读文件内容）替代
  // listSavedSessions（读全部卷文件）——避免与 restoreCanvasSpread 的
  // listSavedSessions 调用双倍 I/O。发号对账只需最大档号，不需读内容。
  const scanMax = await scanMaxSessionId(projectPath);
  const memNext = getChatStore(ctx.storeId).sess.getState().nextSessionId;
  const next = Math.max(memNext, scanMax + 1);
  if (!isCurrentEpoch(epoch)) return;
  getChatStore(ctx.storeId).sess.setState({ nextSessionId: next });
}

// ── 摊开集多卷恢复（扫描推导；session-ledger L0 语义承继面）─────────────

/** 恢复路径的卷数据（**Phase 3b 权威翻转**）：**事件日志 = 卷本体与内容真源**，
 *  `.json` 降级为 UI 投影缓存（`uiMessages`/tokens/compose/label）。
 *  · 无日志 = 卷不存在（旧 `.json` 卷不做兼容读——用户 2026-09-15 拍板）；
 *  · 缓存陈旧（`cache.seq < 日志 lastSeq`）→ **不采信快照**，UI 面走既有
 *    `rebuildMessagesFromMessages` 重建（DSH「possibly stale but never wrong」）。
 *  P0-3（2026-09-02）导出：restoreCanvasSpread 两阶段恢复的并行读面。 */
export async function readVolumeData(projectPath: string, id: number): Promise<StoredSession | null> {
  let logRead: Awaited<ReturnType<typeof readVolumeLogMessages>> = null;
  try {
    logRead = await readVolumeLogMessages(workspaceSessionsDir(projectPath), id);
  } catch (e) {
    console.error('[chat] readVolumeData: 事件日志读取失败', id, e);
    return null;
  }
  if (!logRead) return null;
  // 空卷（无任何非系统消息）不进摊开集——与「空卷不落盘」同规
  if (!logRead.messages.some((m) => m.role !== 'system')) return null;
  const cache = await readVolumeJSON(projectPath, id);
  const fresh = cache !== null && typeof cache.seq === 'number' && cache.seq >= logRead.lastSeq;
  return {
    id,
    // 卷名的家 = 投影缓存（2026-09-18 命名收口：事件日志头行不再带 label——那份
    // append-only 副本改名永不回写，只会在读面冒充真值）。缺缓存 = 未命名（空），
    // 显示兜底由呈现层按档号给；内容真源仍是事件日志。
    label: cache?.label ?? '',
    savedAt: cache?.savedAt ?? '',
    createdAt: logRead.header.createdAt,
    // 血缘取**头行**（write-once 真源），不取快照——快照里没有这一栏
    ...(logRead.header.parent ? { parentId: logRead.header.parent.id } : {}),
    messages: logRead.messages,
    uiMessages: fresh ? cache?.uiMessages : undefined,
    tokensUsed: cache?.tokensUsed,
    // 账本不受新鲜度门管（2026-09-18 修）：`tokens` 是**累计账**不是投影——陈旧
    // 快照只会「落后」（少记末尾几百 token），不会「说错」；而丢掉它才是错的
    // （重开卷账本从零起 = 历史读数凭空消失）。DSH 同判：possibly stale but never wrong。
    // uiMessages 仍按新鲜度取舍——那是内容投影，陈旧会如实说错。
    tokens: cache?.tokens,
    compose: cache?.compose,
    presetId: cache?.presetId ?? logRead.header.presetId,
    seq: logRead.lastSeq,
    ver: 1,
  };
}

/** 扫描本工作区会话根 — 无需 Agent。单目录（{workspace}/.lantai/sessions/），
 *  目录内文件天然属于本工作区（归属 = 存储位置，无 workspace 字段过滤）。
 *  Phase 3b：**卷集 = `.ndjson` 文件集**（卷本体）；label/savedAt 取投影缓存，
 *  msgCount 由事件日志派生（内容真源）——缓存缺失/陈旧不影响「卷存不存在」。
 *  读取失败的卷**可见化**（console.error + 明示原因），不再静默从列表消失。
 *
 *  成本与失效（P0·2026-09-18 侧栏载入审计）：清单投影**持久化**在 `{root}/_index.json`
 *  ——一次清点 = 目录枚举 + 一份小 JSON（几百卷 ≈ 20 KB），**不读任何卷体**；缺失行由
 *  目录对账发现并补建（首次调用阻塞至预算，其余后台分批 + 每批广播）。见「卷目录」头注。
 *  读盘**失败**不再伪装成空集：目录枚举失败一律上抛（调用方保留上次结果并明示），
 *  「工作区为空」才返回 []。 */
export async function listSavedSessions(_ctx: SessionContext, projectPath: string): Promise<SavedSessionRow[]> {
  // 无工作区 = 无卷（合法空态，不是失败——不抛）
  if (!projectPath) return [];
  const root = workspaceSessionsDir(projectPath);
  const ids = await listVolumeIds(projectPath);

  const cat = catalogOf(root);
  await loadCatalog(cat, root);

  // 目录对账（**文件不在 = 卷不存在**）：目录里没有的条目摘掉（外部删除可见化）
  const present = new Set(ids);
  let pruned = false;
  for (const id of [...cat.rows.keys()]) {
    if (!present.has(id)) {
      cat.rows.delete(id);
      pruned = true;
    }
  }
  if (pruned) flushCatalog(cat, root);

  // 目录里有、目录里没有 = 待补建（本轮失败的卷不反复重试；补建在途时并发清点
  // 直接返回已知行——不重复读盘）
  const missing = ids.filter((id) => !cat.rows.has(id) && !cat.failed.has(id));
  if (missing.length > 0 && !cat.building && !cat.blocking) {
    await buildMissingRows(cat, root, projectPath, missing);
  }

  const rows: SavedSessionRow[] = [];
  for (const id of ids) {
    const row = cat.rows.get(id);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return rows;
}

/** **本工作区卷号集**（目录枚举 = 卷集真源：文件不在 = 卷不存在）——清单之外的
 *  读面（会话树「枝」的血缘图重建）取材于此，**不信 `_index.json`**（它是投影，
 *  可陈旧；删除连坐是不可逆动作，见 `app/chat/session-branch.loadBranchLineage`）。 */
export async function listVolumeIds(projectPath: string): Promise<number[]> {
  const names = await listVolumeNames(workspaceSessionsDir(projectPath));
  // 卷集 = .ndjson（跳过下划线开头的保留名；provider 已滤目录）
  const ids: number[] = [];
  for (const name of names) {
    if (!name.endsWith('.ndjson') || name.startsWith('_')) continue;
    const sid = parseInt(name.replace(/\.ndjson$/, ''), 10);
    if (!Number.isNaN(sid)) ids.push(sid);
  }
  return ids;
}

/** 目录枚举（list_volumes）——失败**上抛**（旧实现返回空集，把「目录读不出来」
 *  显示成「没有卷」）。 */
async function listVolumeNames(root: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await sessionExecute('list_volumes', { root });
  } catch (e) {
    console.error('[chat] listSavedSessions: list_volumes failed', e);
    throw new Error(`案卷目录枚举失败（${root}）：${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    console.error('[chat] listSavedSessions: unexpected result', typeof parsed);
    throw new Error(`案卷目录枚举返回非数组（${typeof parsed}）`);
  }
  return parsed.filter((n): n is string => typeof n === 'string');
}

/** 从磁盘加载已保存的会话到新标签页（单卷打开路径——首页点卷/侧边栏续开）。
 *  批量摊开集恢复走 batchRestoreSessions（P3-1）——本函数不再承担恢复路径。
 *  ⚠ 返回「该卷是否已在案头摊开」（2026-09-10 收口）：true = 新摊开成功或本
 *  就已在案头（幂等分支）；false = 未摊开（卷文件缺失/墓碑、读失败、代际丢弃）。
 *  消费方 space-service.expand 依此决定要不要发起定位——失败卷永远不会进
 *  摊开集，照旧发定位只会留下永不兑现的悬空请求（见 expand 注）。 */
export async function loadSessionFromDisk(
  ctx: SessionContext,
  projectPath: string,
  sessionId: number,
): Promise<boolean> {
  // 代际防护（H1 跨工作区串卷，2026-09-02）：摊开是 fire-and-forget（space-service
  // .expand / 签条架续写），读盘 + 工厂装配在途期间用户可能已切走工作区——迟到的
  // append 会把旧区卷混进新工作区 sess store（PaperPanel 兜底落位还会把它写进
  // 新工作区 canvas.json，持久污染）。与 scheduleAutoSave 同款防护面（H5）。
  const epoch = getWorkspaceEpoch();
  // 续开查重（L1/F2）：该卷已在案头摊开 → 直接换卷不克隆（旧行为：无条件
  // append → 同号双脊，旧句柄被顶掉未 dispose，合卷即变死卷）。
  {
    const st0 = getChatStore(ctx.storeId).sess.getState();
    const openIdx = st0.sessions.findIndex((s) => s.id === sessionId);
    if (openIdx >= 0) {
      if (openIdx !== st0.activeIdx) switchSession(ctx, openIdx);
      return true;
    }
  }
  let data: StoredSession | null = null;
  // 读卷：工作区会话根单读 + 墓碑/空卷过滤。
  // Q-B 后 autoRestore 不再恢复内容，本契约由打开路径（首页点卷）承担。
  data = await readVolumeData(projectPath, sessionId);
  if (!data) {
    showToast('案卷文件读取失败', 'error');
    return false;
  }

  // Phase B 对齐（Q-B 后「从首页点开历史卷」即此入口）：句柄是惰性资源——
  // 工厂在场时现造（首次拟文常见路径提前就绪）；无 Key（返 null）/抛错时
  // 摊开内容层照常（历史卷可见不依赖装配），句柄留由 ensureSessionAgent
  // 在拟文时补建；无工厂同样摊开（拟文时提示配 Key）。
  let newAgent: OwnedAgentHandle | null = null;
  try {
    // 方案甲：续开卷的句柄按该卷的生效配置装配（有覆盖用覆盖——见下方
    // hydratePrefs 回填；无覆盖 = 全局默认）
    newAgent = (await getAgentFactory(ctx.storeId)?.(data.id || sessionId)) ?? null;
  } catch {
    /* 装配失败 = 句柄缺席，内容层照常（错误由拟文路径可见） */
  }

  // 在途期间已切走工作区 → 丢弃（已造句柄就地 dispose，不留孤儿；旧区卷
  // 不得 append 进新工作区——见函数头代际防护注释）
  if (!isCurrentEpoch(epoch)) {
    newAgent?.dispose();
    return false;
  }

  // 事件日志接线（换轨 Phase 1）：**必须先于 setSession** —— 把日志置回磁盘真源
  // （读 .ndjson → restoreInPlace + append 姿态），随后 setSession 的 session/reset
  // 才能以「新事实」接在旧事件之后（日志单调增长，崩溃尾巴不被覆写）。
  const seed = newAgent ? await seedVolumeLog(ctx, data.id || sessionId, newAgent) : { adopted: false };

  const conv = (data.messages as Message[]).filter((m) => m.role !== 'system');
  const freshSys = newAgent?.getSession().filter((m: Message) => m.role === 'system') ?? [];
  if (newAgent && seed.adopted) {
    // **权威翻转（Phase 3b）**：日志 = 内容真源 → 采用（头部重设一条事件），
    // conv（日志派生）不再整段写回日志；旧路径（无日志 = 新卷/空日志）才 setSession。
    newAgent.adoptSessionLog?.(freshSys.map((m) => m.content ?? '').join('\n'));
  } else if (newAgent) {
    newAgent.setSession([...freshSys, ...conv]);
  }

  // 卷名（与 autoTitleSessionIfDefault 同规）：有名卷直采；未命名 → **自己的**首条来文派生
  // （仍无名 = 留空，显示兜底由呈现层按档号给）。判据/派生 = state/volume-name 单一真源。
  // **枝卷只认自己的首条来文**（`inheritedMessageCount` 跳过继承来的前缀）：前缀是父卷的
  // 复制，拿它起名 = 子卷顶着父卷的名（真机验收报的「卷名乱套」）。句柄/日志缺席时边界
  // 不可知 ⇒ 有父即不起名（宁可显示档号，也不顶别人的名）。
  // ⚠ 切片必须在**全量**消息表上做：继承长度是**投影下标**（含 system 头），而 `conv`
  // 已滤掉 system——在 `conv` 上切会多切掉自己的首条来文（两套下标空间）。
  const inherited = inheritedMessageCount(newAgent?.sessionLog);
  const storedLabel = data.label ?? '';
  const ownFirstUser =
    inherited === 0 && data.parentId != null
      ? undefined
      : (data.messages as Message[])
          .slice(inherited)
          .find((m: Message) => m.role === 'user' && !isInternalMessage(m.content));
  const label = isUnnamedVolumeLabel(storedLabel)
    ? ownFirstUser?.content
      ? deriveVolumeLabel(ownFirstUser.content)
      : ''
    : storedLabel;

  // ponytail: 消息在会话级 store 中 — 无需 saveCurrentMessages
  ctx.flushReasoning();
  ctx.flushText();
  ctx.clearPendingToolCards();

  const sid = data.id || sessionId;
  if (newAgent) {
    agentSessionState.setAgent(ctx.storeId, sid, newAgent);
    // 静态绑定该 Agent 的 board 到加载的会话
    newAgent.bindSession?.(String(sid));
    bindSessionExec(ctx, sid, newAgent);
  }
  getChatStore(ctx.storeId).sess.setState((s) => ({
    sessions: [...s.sessions, { id: sid, label, createdAt: data.createdAt }],
    activeIdx: s.sessions.length,
    // 发号下限（F5）：续开大号卷后，另起一卷不得发出 ≤ 已存在档号的号
    nextSessionId: Math.max(s.nextSessionId, sid + 1),
  }));
  // ponytail: 创建会话级消息 store
  msgStoreFor(ctx.storeId, sid).getState().setMessages([]);
  // 恢复现场选择（2026-08-31 会话流专项）：带 UI 快照的卷直接采信快照渲染——
  // 运行时字段全保真（工具 err/output/折叠依赖的形状都在其上），不再按 provider
  // 消息重建（重建是降采样：err 丢弃、output 可能翻不到、_id 重发号，加载后
  // 与实时「有出入」）。旧存档无 uiMessages → 走 provider 重建兜底（WO-7）。
  // 采纳快照必须过 adoptRestoredMessages（2026-09-09 根治）：旧 id 是上一
  // 运行的发号产物，不垫发号器 → 重启后新消息撞号（消息消失/整流冲坏）。
  const uiSnapshot =
    Array.isArray(data.uiMessages) && data.uiMessages.length > 0 ? adoptRestoredMessages(data.uiMessages) : undefined;
  const hasUiSnapshot = uiSnapshot !== undefined;
  if (uiSnapshot) {
    msgStoreFor(ctx.storeId, sid).getState().setMessages(uiSnapshot);
  }
  // 方案甲（2026-08-27）：会话级创作坞覆盖随卷恢复——旧存档无 compose 字段
  // = 无覆盖（实时跟随全局默认）。回填在句柄创建之后（工厂装配时覆盖已在
  // compose-store：磁盘路径先于工厂读卷？否——见下方：磁盘数据在上、工厂
  // 在下同函数内，回填先于 handle 使用的下一条消息即可）。注意：句柄若已
  // 建（newAgent 非空），其 provider 覆盖需要热同步——hydratePrefs 落表后
  // 直接走 model-switched 信号面（applyAgentConfig 按会话解析覆盖）。
  if (data.compose) {
    getComposeStore(ctx.storeId).getState().hydratePrefs(String(sid), data.compose);
  }
  // 组合身份随卷恢复（P0 记录闭环，2026-09-14）：**只登记**「本卷落盘时记录的组合」
  // ——工厂（workspace 会话工厂）据此用该卷自己记录的那套组合重建它，而不是当前
  // 全局默认，这是「模型可见 ⟺ 已记录」的可重建半边；旧存档无此字段 = 未知
  // （不猜、不迁移，工厂退回全局默认）。
  // 校验与提示（不在册 / 行 id 不可解析）归**装配面**做（workspace 工厂）——本层
  // 不引组合层模块：ui/chat-session 与 composition 互相可达会成环（实测：
  // ReferenceError: Cannot access ... before initialization，整仓 46 个测试文件连坐）。
  agentSessionState.setRecordedPresetId(
    ctx.storeId,
    sid,
    typeof data.presetId === 'string' && data.presetId !== '' ? data.presetId : null,
  );
  // token 账本随卷恢复（2026-09-13）：句柄在场才回填（账本真源 = Agent）；
  // 旧存档无 tokens 字段 = 账本从空开始（不迁移）。
  if (newAgent && data.tokens) newAgent.restoreTokenLedger?.(data.tokens);
  if (typeof data.tokensUsed === 'number') {
    ctx.setTotalTokensUsed(data.tokensUsed);
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(sid, data.tokensUsed);
  } else {
    ctx.setTotalTokensUsed(0);
    getChatStore(ctx.storeId).sess.getState().setSessionTokens(sid, 0);
  }

  if (newAgent) {
    try {
      if (hasUiSnapshot && uiSnapshot) {
        // 现场即真相：消息不重建（完整保留磁盘快照字段），只补派生状态——
        // 轮次表（撤回/重发定位依赖）与资产表（钉住资产块广播依赖）。
        setTurnPairs(ctx.storeId, sid, rebuildTurnPairsFromProvider(newAgent.getSession()));
        rebuildAssetTableFromMessages(ctx.storeId, sid, uiSnapshot);
        bumpSession(ctx.storeId, sid);
      } else {
        renderRestoredSession(ctx);
      }
    } catch (e) {
      console.error('[chat] loadSessionFromDisk: render 崩溃', e);
      showToast(`案卷已加载但渲染失败: ${label}`, 'error', TOAST_LONG_HOLD_MS);
    }
  } else {
    // 无句柄：内容层照常摊开（历史卷可见；句柄拟文时补建）
    if (hasUiSnapshot && uiSnapshot) {
      // 同上有快照：直接采用 + 派生重建。无句柄时撤回/重发不可用（定位需要
      // agent 会话）——补建句柄后由沙盒映射尾对齐自愈（resolveUserTurnIndex）。
      setTurnPairs(ctx.storeId, sid, rebuildTurnPairsFromProvider(conv));
      rebuildAssetTableFromMessages(ctx.storeId, sid, uiSnapshot);
      bumpSession(ctx.storeId, sid);
    } else {
      rebuildMessagesFromMessages(conv, ctx.storeId, sid);
      bumpSession(ctx.storeId, sid);
    }
    // 后台补建句柄：无 Key → 可见 warn（契约②：缺 Key = 提示不是会话消失）；
    // 配 Key → 拟文时 ensureSessionAgent 直接可用
    hydrateSessionAgentVisible(ctx);
  }

  ctx.setLastUsageText('');
  ctx.updateFooter();
  // U4/Q1-B：总目记账退役（摊开集重启由磁盘扫描推导）
  return true;
}

// ── 摊开集批量恢复应用（P3-1，2026-09-02）──────────────────────────

/** 批量摊开已读卷：一次 setState 铺全部卷（sessions append + 发号合并 +
 *  activeIdx 保存），随后逐卷填内容层（msgStore / compose / tokens / 轮次表 /
 *  资产表）。替代恢复循环里逐卷 loadSessionFromDisk 的 N 次 setState——
 *  sess store 订阅（PaperPanel sessions 同步 + 消息订阅 effect 重建）从
 *  N 次降为 1 次。
 *  逐卷失败隔离：单卷应用抛错不影响其他卷，返回失败数（调用方可见化）。
 *  不造 Agent（同 loadSessionFromDisk restore 模式）；活跃卷的句柄由
 *  restoreCanvasSpread 末尾 switchSession 的惰性补建承担。 */
export async function batchRestoreSessions(
  ctx: SessionContext,
  items: Array<{ sid: number; data: StoredSession }>,
): Promise<number> {
  // 防御：读阶段在途时用户可能手动开卷——已开的跳过（不重复摊开）
  const openNow = new Set(
    getChatStore(ctx.storeId)
      .sess.getState()
      .sessions.map((s) => s.id),
  );
  const batch = items.filter(({ sid }) => !openNow.has(sid));
  if (batch.length === 0) return 0;

  // 卷名派生（与 loadSessionFromDisk / autoTitleSessionIfDefault 同规：有名卷直采 /
  // **自己的**首条来文截断 / 仍无名 = 留空由呈现层兜底）——单一真源 state/volume-name。
  // 批恢复不造句柄（本函数同 loadSessionFromDisk 的 restore 模式）⇒ 继承边界算不出来，
  // 故枝卷（`parentId`）一律不起名——宁可显示档号，也不让子卷顶着父卷的名。
  const labeled = batch.map(({ sid, data }) => {
    const conv = (data.messages as Message[]).filter((m) => m.role !== 'system');
    const logInstance = agentSessionState.getAgent(ctx.storeId, data.id || sid)?.sessionLog;
    const inherited = inheritedMessageCount(logInstance);
    // 切片在**全量**消息表上做（继承长度是含 system 头的投影下标——见 loadSessionFromDisk 注）
    const ownFirstUser =
      inherited === 0 && data.parentId != null
        ? undefined
        : (data.messages as Message[]).slice(inherited).find((m) => m.role === 'user' && !isInternalMessage(m.content));
    const storedLabel = data.label ?? '';
    const label = isUnnamedVolumeLabel(storedLabel)
      ? ownFirstUser?.content
        ? deriveVolumeLabel(ownFirstUser.content)
        : ''
      : storedLabel;
    return { sid: data.id || sid, label, data, conv };
  });

  // 一次 setState：全部卷 append + 发号合并 + activeIdx 保存（#8 语义）
  getChatStore(ctx.storeId).sess.setState((s) => {
    const sessions = [...s.sessions];
    let nextSessionId = s.nextSessionId;
    for (const { sid: id, label, data } of labeled) {
      sessions.push({ id, label, createdAt: data.createdAt });
      nextSessionId = Math.max(nextSessionId, id + 1);
    }
    return { sessions, activeIdx: s.activeIdx, nextSessionId };
  });

  // 逐卷内容层（会话级 store——不触 sess 订阅，失败隔离）
  let failed = 0;
  for (const { sid, data, conv } of labeled) {
    try {
      // 采纳快照必须过 adoptRestoredMessages（同 loadSessionFromDisk——旧 id
      // 是上一运行发号产物，不垫发号器 → 重启后新消息撞号）
      const uiSnapshot =
        Array.isArray(data.uiMessages) && data.uiMessages.length > 0
          ? adoptRestoredMessages(data.uiMessages)
          : undefined;
      if (uiSnapshot) {
        msgStoreFor(ctx.storeId, sid).getState().setMessages(uiSnapshot);
        setTurnPairs(ctx.storeId, sid, rebuildTurnPairsFromProvider(conv));
        rebuildAssetTableFromMessages(ctx.storeId, sid, uiSnapshot);
      } else {
        rebuildMessagesFromMessages(conv, ctx.storeId, sid);
      }
      if (data.compose) {
        getComposeStore(ctx.storeId).getState().hydratePrefs(String(sid), data.compose);
      }
      // 组合身份随卷登记（P0 记录闭环——与 loadSessionFromDisk 同构：本批只登记，
      // 不弹提示（批量恢复安静展开；逐卷打开时由 loadSessionFromDisk 提示）。
      agentSessionState.setRecordedPresetId(ctx.storeId, sid, typeof data.presetId === 'string' ? data.presetId : null);
      getChatStore(ctx.storeId)
        .sess.getState()
        .setSessionTokens(sid, typeof data.tokensUsed === 'number' ? data.tokensUsed : 0);
      bumpSession(ctx.storeId, sid);
    } catch (e) {
      failed += 1;
      console.error('[chat] batchRestoreSessions: 单卷应用失败', sid, e);
    }
  }
  return failed;
}

/** 将磁盘上的会话文件标记为已删除。workspace-session-ownership-rework：
 *  墓碑写工作区会话根（归属即存储位置，无 workspace 字段）。
 *  seam：delete_volume（D-2 语义动作——默认 provider 墓碑重写 deleted:true，
 *  消费方过滤契约依赖此形态，行为字节不变；SQLite provider 可真删）。
 *  ⚠ 返回**删除结果**（2026-09-18 会话树「枝」P2）：连坐删除要**逐卷可见**
 *  （部分失败不静默），故这里不再只 toast——`ok:false` 带原因（已 toast +
 *  console.error），调用方据此逐卷报账（失败卷的标签页照旧不关）。 */
export type SessionDeleteResult = { ok: true } | { ok: false; reason: string };

export async function deleteSessionFile(
  ctx: SessionContext,
  projectPath: string,
  sessionId: number,
): Promise<SessionDeleteResult> {
  const root = workspaceSessionsDir(projectPath);
  try {
    await sessionExecute('delete_log', {
      root,
      id: String(sessionId),
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error('[chat] deleteSessionFile failed:', e);
    showToast(`删除案卷 ${sessionId} 失败：${why}`, 'error');
    return { ok: false, reason: why }; // 写入失败则不关闭标签页
  }
  // 真删成功：目录就地摘行（「文件不在 = 卷不存在」——消费面无需重扫）+ 广播
  dropCatalogRow(root, sessionId);
  bumpSessionVolumes();
  // 标记源会话已删（2026-08-28 会话管理专项）：其孤儿钉的「收回」语义失效——
  // 画布上该钉的按钮应显示「删除」。切工作区随画布整表重置。
  getCanvasStore(ctx.storeId).getState().markSessionDeleted(sessionId);
  // 卷已彻底删除：摊开集合移除该卷位置；公共物（钉住块/纸条）是工作区级
  // 宿主、不连坐——钉块以快照继续显示在纸上（钉到拔为止，Stage-5）。
  getCanvasStore(ctx.storeId).getState().removeRegion(String(sessionId));
  // 若该会话在标签页中打开，则关闭该标签页
  const idx = getChatStore(ctx.storeId)
    .sess.getState()
    .sessions.findIndex((s) => s.id === sessionId);
  if (idx < 0) return { ok: true };
  // 删除唯一/最后一卷（2026-08-28 会话管理专项修复）：删除语义下允许清空
  // 画布（closeSession 已同步放开——合卷最后一卷同样清空画布，见其空分支）。
  // 否则墓碑已写、流区已移除，但标签页不关（僵尸），且再发消息自动保存会把
  // {id}.json 重写回真实内容 → 已删卷复活。这里直接收掉最后一个标签页。
  if (getChatStore(ctx.storeId).sess.getState().sessions.length <= 1) {
    removeSessionExecState(ctx.storeId, sessionId);
    agentSessionState.removeAgent(ctx.storeId, sessionId);
    disposeSessionMessagesStore(ctx.storeId, sessionId);
    disposeAssetSessionStore(ctx.storeId, sessionId);
    getChatStore(ctx.storeId).input.getState().clearSessionDraft(sessionId);
    getComposeStore(ctx.storeId).getState().removePrefs(String(sessionId));
    getChatStore(ctx.storeId).sess.setState({ sessions: [], activeIdx: -1 });
    const runtime = ctx.getRuntime?.();
    if (runtime) runtime.destroySessionBoards(String(sessionId)).catch(() => {});
    ctx.updateFooter();
    return { ok: true };
  }
  closeSession(ctx, idx);
  return { ok: true };
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
  const preservedBlockParts = new Map<number, BlockPart[]>();
  {
    const existing = msgStoreFor(storeId, sessionId).getState().messages;
    let aIdx = 0;
    for (const m of existing) {
      if (m.role !== 'assistant') continue;
      const subs = (m as AssistantMessage).parts.filter((p): p is SubAgentPart => p.type === 'subagent');
      if (subs.length > 0) preservedSubAgents.set(aIdx, subs);
      const blocks = (m as AssistantMessage).parts.filter((p): p is BlockPart => p.type === 'block');
      if (blocks.length > 0) preservedBlockParts.set(aIdx, blocks);
      aIdx++;
    }
  }

  resetMsgIdCounter();
  setTurnPairs(storeId, sessionId, []);

  const toolResults = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === 'tool' && m.tool_call_id) {
      toolResults.set(m.tool_call_id, m.content || '');
    }
  }

  let pendingUserText: string | null = null;
  let pendingUserId: MessageId | null = null;
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
        getTurnPairs(storeId, sessionId).push({
          userText: pendingUserText,
          uiMsgId: pendingUserId,
          userBubble: null,
          assistantBubble: null,
        });
      }
      pendingUserText = m.content || '';
      pendingUserId = nextMsgId();
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
        getTurnPairs(storeId, sessionId).push({
          userText: pendingUserText,
          uiMsgId: pendingUserId ?? undefined,
          userBubble: null,
          assistantBubble: null,
        });
        pendingUserText = null;
        pendingUserId = null;
      }
    }
  }

  if (pendingUserText) {
    getTurnPairs(storeId, sessionId).push({
      userText: pendingUserText,
      uiMsgId: pendingUserId ?? undefined,
      userBubble: null,
      assistantBubble: null,
    });
  }

  // 按助手消息序号重新附加保留的子 Agent 部件。
  // 超出重建范围的序号（如仍在流式输出但尚未出现在
  // provider 消息中的轮次）回退到最后一条重建的助手消息。
  if (preservedSubAgents.size > 0 || preservedBlockParts.size > 0) {
    const rebuiltAssistants = rebuilt.filter((m): m is AssistantMessage => m.role === 'assistant');
    for (const [ordinal, subs] of preservedSubAgents) {
      const target = rebuiltAssistants[ordinal] ?? rebuiltAssistants[rebuiltAssistants.length - 1];
      if (target) target.parts.push(...subs);
    }
    for (const [ordinal, blocks] of preservedBlockParts) {
      const target = rebuiltAssistants[ordinal] ?? rebuiltAssistants[rebuiltAssistants.length - 1];
      if (target) target.parts.push(...blocks);
    }
  }

  // ponytail: 写入会话级 store — 唯一数据源
  msgStoreFor(storeId, sessionId).getState().setMessages(rebuilt);
  rebuildAssetTableFromMessages(storeId, sessionId, rebuilt);
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

/** 从 provider 会话推导轮次表（恢复路径直接采用 UI 快照时的派生重建）。
 *  pair 只是轮次簿册（userText + uiMsgId 身份）；撤回/重发的定位权威在
 *  沙盒映射（resolveUserTurnIndex 尾对齐派生），不在这里。
 *  internal 消息（目标/压缩上下文）不建轮次对；重发叠出的重复 user 消息
 *  各自成对，撤回按 uiMsgId 直达互不误删。 */
function rebuildTurnPairsFromProvider(providerSession: Message[]): TurnPair[] {
  const pairs: TurnPair[] = [];
  providerSession.forEach((m) => {
    if (m.role !== 'user' || isInternalMessage(m.content)) return;
    pairs.push({ userText: m.content || '', userBubble: null, assistantBubble: null });
  });
  return pairs;
}

// ── 轮次撤回（2026-09-01 重发锚点工程：ID 直达，无内容猜测）──
// 旧实现的三条猜测路（记录索引直用 / 内容兜底搜索 / 同文本清 pair）全部
// 退役——provider 会话与 UI 消息本就是两份不同形状的数据，定位唯一权威 =
// UI 消息 _id 经「沙盒映射」（TurnIdBridge）反查 provider 下标。映射由
// 尾对齐派生（按顺序配对 + 内容确认），戳失效即整表重算：压缩、外部裁剪、
// 恢复后统统自愈；对不上的轮次降级置灰，绝不按内容搜索下刀。

/** provider 内容与 UI 文本的对位确认（精确或附件前缀尾匹配——带附件轮次
 *  底层 content = 附加文件清单 + 正文）。仅用于确认顺序对位，绝不做内容搜索。 */
function providerContentMatches(providerContent: string, uiText: string): boolean {
  if (!uiText) return false;
  return providerContent === uiText || providerContent.endsWith(uiText);
}

/** 尾对齐：UI 用户消息 ↔ provider 用户消息从最新端按顺序配对，内容确认，
 *  失配即止（更早的轮次不入映射 → 降级）。同文本多轮按位置各归各位——
 *  旧「按文本找索引」的同文本撤错轮病根在此拔除。
 *  尾悬挂容忍一次：UI 末条在 provider 无对应（在途/夭折轮）时不拖累全场。 */
function alignUserTurns(uiUsers: UserMessage[], provUsers: { index: number; content: string }[]): Map<string, number> {
  const byUiId = new Map<string, number>();
  let ui = uiUsers;
  if (
    ui.length > provUsers.length &&
    !providerContentMatches(provUsers[provUsers.length - 1]?.content ?? '', ui[ui.length - 1]?.text ?? '')
  ) {
    ui = ui.slice(0, -1);
  }
  const n = Math.min(ui.length, provUsers.length);
  for (let k = 1; k <= n; k++) {
    const u = ui[ui.length - k];
    const p = provUsers[provUsers.length - k];
    if (!u || !p || !providerContentMatches(p.content, u.text)) break;
    byUiId.set(u._id, p.index);
  }
  return byUiId;
}

/** 重派生本会话的撤回定位映射（沙盒）。戳（会话长度/界面用户数）失效即
 *  整表重算——不做增量维护，外部改动点（压缩/裁剪/恢复）零接线自愈。 */
function realignTurnIdBridge(storeId: string, sid: number, session: Message[], uiUsers: UserMessage[]): void {
  const provUsers: { index: number; content: string }[] = [];
  session.forEach((m, i) => {
    if (m.role === 'user' && !isInternalMessage(m.content)) {
      provUsers.push({ index: i, content: m.content || '' });
    }
  });
  agentSessionState.setTurnIdBridge(storeId, sid, {
    sessionLength: session.length,
    uiUserCount: uiUsers.length,
    byUiId: alignUserTurns(uiUsers, provUsers),
  });
}

/** uiMsgId → provider 会话中该 user 轮的下标（ID 直达）。映射缺失/过期先
 *  尾对齐重派生；仍对不上返回 null——调用方降级，绝不回退内容搜索。 */
function resolveUserTurnIndex(storeId: string, sid: number, uiMsgId: MessageId): number | null {
  const agent = agentSessionState.getAgent(storeId, sid);
  if (!agent) return null;
  const session = agent.getSession();
  const uiUsers = msgStoreFor(storeId, sid)
    .getState()
    .messages.filter((m): m is UserMessage => m.role === 'user');
  const bridge = agentSessionState.getTurnIdBridge(storeId, sid);
  if (!bridge || bridge.sessionLength !== session.length || bridge.uiUserCount !== uiUsers.length) {
    realignTurnIdBridge(storeId, sid, session, uiUsers);
  }
  const idx = agentSessionState.getTurnIdBridge(storeId, sid)?.byUiId.get(uiMsgId);
  if (idx == null || idx < 0 || idx >= session.length || session[idx]?.role !== 'user') return null;
  return idx;
}

/** 改/重发按钮的准入判定：该轮当前能否被唯一定位撤回（不可 = 置灰降级）。 */
export function canRetraceUserTurn(storeId: string, sid: number, uiMsgId: MessageId): boolean {
  return resolveUserTurnIndex(storeId, sid, uiMsgId) != null;
}

/** 以 UI 消息 _id 撤回一轮（ID 直达）。全有或全无：UI 消息或 provider 轮
 *  任一定位失败 = 两边都原样不动（返回 false）——绝不半撤制造叠尸，
 *  也绝不按内容猜错轮。撤回区间 = 该 user 消息 + 紧随其后的助手回复
 *  （respondingTo 关联），子代理/资产随区间连坐（retractTurnAt 语义）。 */
export function retractUserMessage(ctx: SessionContext, msg: UserMessage): boolean {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return false;

  // 定位先行（UI + provider 两侧都要命中，缺一整体不动）
  const store = msgStoreFor(ctx.storeId, sid);
  const msgs = store.getState().messages;
  const uiIdx = msgs.findIndex((m) => m.role === 'user' && m._id === msg._id);
  const sessIdx = resolveUserTurnIndex(ctx.storeId, sid, msg._id);
  if (uiIdx < 0 || sessIdx == null) return false;

  agentSessionState.getAgent(ctx.storeId, sid)?.retractTurnAt(sessIdx);

  // UI 层清理（_id 直达）：该用户消息 + 紧随其助手回复
  const toRemove: number[] = [uiIdx];
  for (let i = uiIdx + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.respondingTo === msg._id) {
      toRemove.push(i);
      break;
    } else if (m.role === 'user') {
      break;
    }
  }
  for (const i of toRemove.reverse()) {
    msgs.splice(i, 1);
  }
  store.getState().setMessages([...msgs]);
  bumpSession(ctx.storeId, sid);

  // pair 簿册按 uiMsgId 直达清理（同文本轮次互不误删）
  const tp = getTurnPairs(ctx.storeId, sid);
  const pi = tp.findIndex((p) => p.uiMsgId === msg._id);
  if (pi >= 0) tp.splice(pi, 1);
  return true;
}

// ── 对话导出 ──

export async function exportSession(ctx: SessionContext): Promise<void> {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const agent = agentSessionState.getAgent(ctx.storeId, sessions[activeIdx]?.id ?? -1);
  if (!agent) {
    showToast('没有可导出的案卷', 'info');
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
      // 豁免（session-persistence-seam-wiring-plan 表 1.1 #9）：用户自选路径的
      // .md 导出，非会话存储语义——直连 kernelWriteFile，不进 sessionExecute。
      await kernelWriteFile(filePath, md);
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
  }
}
