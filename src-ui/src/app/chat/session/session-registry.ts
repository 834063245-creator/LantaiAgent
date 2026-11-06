// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 面板级会话注册表访问器（句柄 / exec 账 / 轮次对 / 全量重置）
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import { agentSessionState, type OwnedAgentHandle, type TurnPair } from '../../../agent/agent-session-state';
import type { ChatAgentHandle } from '../../../agent/chat-agent-handle';
import type { ExecStateInstance } from '../../../agent/execution-state';
import { disposeAssetTables } from '../../../state/asset-store';
import { getCanvasStore } from '../../../state/canvas-store';
import { getComposeStore } from '../../../state/compose-store';
import { disposeMessagesStores } from '../../../state/messages-store';
import { getChatStore } from '../../../ui/chat-store';
import type { ChatSession, SessionContext } from './session-types';

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
/** 发号下限访问器（产线零调用，仅测试用）。**只增不许拉低**（B·2026-09-21）：下限是
 *  「号永不复用」的承重面，旧语义（无条件覆盖）能把它写小——水位一低，旧号就能被
 *  重新发出（正是本批要拆的那族事故）。 */
export function setNextSessionId(storeId: string, id: number): void {
  getChatStore(storeId).sess.setState((s) => ({ nextSessionId: Math.max(s.nextSessionId, id) }));
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

/** 获取或创建会话的**账**（运行账 = 每卷一本，「这卷在不在跑」的唯一事实）。
 *  铸造点只有这一处（`agentSessionState.getOrCreateExec`）；读运行态请走
 *  `agentSessionState.runStateOf`，不要各自取实例。 */
export function getSessionExecState(storeId: string, sessionId: number): ExecStateInstance {
  return agentSessionState.getOrCreateExec(storeId, sessionId);
}

/** 清理已关闭会话的 execState。 */
export function removeSessionExecState(storeId: string, sessionId: number): void {
  agentSessionState.removeExec(storeId, sessionId);
}

/** 装配收尾：把本卷的账**绑**给句柄（`agentSessionState.bindExec`）——2026-09-17
 *  「偶发：会话在跑而运行态丢失」那半（账本身份）+ 2026-09-20 结构性收口。
 *
 *  两个读账方必须是同一个对象：
 *  - UI 全域读注册表实例（chat-core._activeExec / runStateOf / 创作坞 / 目次带）；
 *  - Agent 自起的轮次（`_onMessageDelivered`：异步子 Agent 回件 / 后台任务 bg /
 *    延迟唤醒）走句柄内部账本 `agent._execState`。
 *
 *  两条身份纪律（2026-09-20 收口后**都是结构性的**，不靠调用方记得）：
 *  ① **账是卷级恒定的那一本**——装配只绑定、绝不新铸（旧实现 `createExecState()`
 *     每装配一次换一本账：在跑的记录被孤儿化，UI 立刻丢失运行态）；
 *  ② 句柄拿到的就是注册表那一本（同处发生、紧邻 setAgent，并发装配竞态下
 *     「最后注册的句柄 ↔ 最后绑的账」仍成对）。
 *  句柄无 `setExecState` 能力位（旧实现/测试桩）= 只有注册表一本账，bindExec 留痕。 */
export function bindSessionExec(ctx: SessionContext, sid: number, agent: OwnedAgentHandle): void {
  agentSessionState.bindExec(ctx.storeId, sid, agent);
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
