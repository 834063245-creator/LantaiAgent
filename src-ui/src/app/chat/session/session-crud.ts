// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话 CRUD（切换 / 懒建句柄 / 关闭 / 新建）
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import { agentSessionState, type OwnedAgentHandle } from '../../../agent/agent-session-state';
import { log } from '../../../agent/logger';
import type { Message } from '../../../provider/types';
import { disposeAssetSessionStore } from '../../../state/asset-store';
import { getCanvasStore } from '../../../state/canvas-store';
import { getComposeStore } from '../../../state/compose-store';
import { disposeSessionMessagesStore } from '../../../state/messages-store';
import { showToast, TOAST_LONG_HOLD_MS } from '../../../state/toast-store';
import { volumeDisplayName } from '../../../state/volume-name';
import { useAgentPanelStore } from '../../../ui/agent-panel-store';
import { getChatStore, msgStoreFor } from '../../../ui/chat-store';
import { resetMsgIdCounter } from '../../../ui/message-model';
import { getWorkspaceEpoch, isCurrentEpoch } from '../../../workspace-scope';
import { detachSessionLogStore, openSessionLog } from '../session-log-store';
import {
  noteVolumeIssued,
  reconcileVolumeIssueFloor,
  SESSION_CACHE_VERSION,
  type StoredSession,
  workspaceSessionsDir,
} from './session-paths';
import { readVolumeData } from './session-read';
import { bindSessionExec, getAgentFactory, removeSessionExecState, setTurnPairs } from './session-registry';
import { scheduleAutoSave, writeSessionSnapshot } from './session-save';
import type { SessionContext } from './session-types';

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
export function hydrateSessionAgentVisible(ctx: SessionContext): void {
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
export async function seedVolumeLog(
  ctx: SessionContext,
  sid: number,
  agent: OwnedAgentHandle,
): Promise<{ adopted: boolean }> {
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
  return ensureVolumeAgent(ctx, sid);
}

/** **指定卷**的句柄补建（`ensureSessionAgent` 的单卷形，2026-09-19）。
 *
 *  为什么需要它：冷启动走 `restoreCanvasSpread` 的**批量恢复**（刻意不造 Agent，
 *  只有活跃卷由末尾 switchSession 惰性补建），而会话树「枝」的画布承接需要**父子卷
 *  都有句柄**（血缘在子卷头行里、父卷那个节点要走父卷的投影与定位桥）⇒ 重启后非活跃
 *  卷的枝边读面全空（真机报的「引线消失」）。调用方（chat-core 冷启动）只为**参与枝边
 *  的摊开卷**补建：数量 = 树上的卷，不是全摊开集。 */
export async function ensureVolumeAgent(ctx: SessionContext, sid: number): Promise<boolean> {
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
  // token 账本同批捕获（2026-09-23 修）：句柄是**惰性**资源，「拟文/切卷时补建」
  // 是最常见的一条句柄来路——此前只回填消息、不回填账本，于是每次懒建都把卷文件
  // 里的累计账丢掉，下一次落盘再把它覆盖成更小的账（案卷 35 实测：第 1 轮 14 次
  // 请求 768,457 输入凭空消失，墨量册「缓存命中」从 68% 起爬）。与开卷路径
  // （loadSessionFromDisk 的 `if (newAgent && data.tokens)`）同一条纪律：
  // **重开该卷账本不归零**（2026-09-18 已在合卷路径立此规，此处是同一族的第三条写面）。
  let ledger: StoredSession['tokens'];
  try {
    const data = await readVolumeData(ctx.getProjectPath(), sid);
    if (data) {
      conv = (data.messages as Message[])?.filter((m) => m.role !== 'system') ?? [];
      ledger = data.tokens;
    }
  } catch (e) {
    // 卷文件缺失 = 空会话起步（新卷语义）；**读失败**要可见（2026-10-29 收口：
    // 此前两种情形同一个空 catch——读失败会被当成「新卷」，用户看到空白卷）。
    log.warn('chat', `案卷 ${sid} 读取失败（按空会话起步——若为意外，请查看 ui.log）`, { error: String(e) });
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
  // 账本恢复放在**入册之后**：上方两次「句柄已被并行补建」的早退会 dispose 本句柄，
  // 恢复给一个即将丢弃的实例没有意义。
  if (ledger) agent.restoreTokenLedger?.(ledger);
  // 折叠状态同批恢复（2026-09-24 修）：折叠（摘要 + 尾部起点）此前是纯运行时态，
  // 句柄一重建就丢 ⇒ 载荷回到满值、付过钱的摘要在下一次请求里白丢（卷 39 实测
  // 22,378 → 295,017）。真源 = 卷日志的 `session/compaction`（seedVolumeLog 刚置回）。
  // 与账本同规：**重建句柄不丢折叠**，两条路径（此处的懒建 / loadSessionFromDisk）都要接。
  agent.restoreCompactionFromLog?.();
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
  // 发号前对账（B·2026-09-21）：await **读账**（不扫盘——起卷只认内存的既有语义不动）
  // + 抬下限；**claim 仍留在无 await 的同步段**（占号与推高 nextSessionId 之间不许有
  // await，否则并发建卷铸同号；对账只抬地板）。
  await reconcileVolumeIssueFloor(ctx, claimWs);
  if (!isCurrentEpoch(epoch)) return null; // 在途切走工作区：丢弃（同下方判据，提前一步）
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
  // 发出即记账（B）：await 落盘——「发出号 → 崩溃 → 删卷」这条复用窗口靠它关掉
  // （占号已成事实，此处的 await 不影响占号本身的同步性）。
  await noteVolumeIssued(claimWs, id);
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
  // U4/Q1-B：总目记账退役（摊开集重启由磁盘扫描推导）
  return id;
}
