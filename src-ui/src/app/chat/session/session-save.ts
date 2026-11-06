// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷快照落盘（写链入队 / 防抖自动存 / 改名即存）
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import { agentSessionState } from '../../../agent/agent-session-state';
import { log } from '../../../agent/logger';
import { sessionExecute } from '../../../composition/session-persistence-service';
import { getComposeStore } from '../../../state/compose-store';
import { bumpSessionVolumes } from '../../../state/session-volumes-store';
import { showToast, TOAST_LONG_HOLD_MS } from '../../../state/toast-store';
import { getChatStore, msgStoreFor } from '../../../ui/chat-store';
import { getWorkspaceEpoch, isCurrentEpoch } from '../../../workspace-scope';
import { readVolumeLogMessages } from '../session-log-store';
import {
  dropCatalogRow,
  enqueueVolumeWrite,
  rowFromSnapshot,
  type SessionSaveOutcome,
  type SessionSaveReport,
  summarizeSaveReport,
  upsertCatalogRow,
  warnSaveAnomaly,
} from './session-catalog';
import {
  readVolumeJSON,
  reconcileVolumeIssueFloor,
  SESSION_CACHE_VERSION,
  type SessionSnapshotData,
  type StoredSession,
  scanMaxSessionId,
  workspaceSessionsDir,
} from './session-paths';
import { cacheOfThisVolume } from './session-read';
import type { SessionContext } from './session-types';
import { isVolumeRemoved } from './session-volume-guard';

/** 将已捕获的会话快照写入存储（save_volume——默认 provider 落工作区会话根
 *  {projectPath}/.lantai/sessions/{id}.json；替代 provider 自管存储）。
 *  C8 合卷自动存从 saveActiveSession 离体出来的共享写盘函数——调用方负责
 *  在 agent 句柄消亡前完成数据捕获（messages 属引用，序列化在首次 await 前）。
 *  workspace-session-ownership-rework（2026-08-27）：落盘目标 = 工作区会话根
 *  （workspace 字段标签退役；localStorage 备份早已拆除——磁盘是唯一事实源）。
 *  失败：console.error 后上抛——调用方决定可见等级（autosave 容忍、合卷告警）。 */
export async function writeSessionSnapshot(projectPath: string, data: SessionSnapshotData): Promise<void> {
  // 序列化在入链前完成（快照语义 = 调用时刻的会话，不被前序写在途拖成旧值）
  const json = JSON.stringify(data);
  const root = workspaceSessionsDir(projectPath);
  const target = `${root}/${data.id}.json`;
  // 已删卷的快照写一律拒绝（在途写链任务 / 防抖自动存都可能晚于删除到达）——
  // 不挡就是「删了又活」的化石种子（见 `_removedVolumes` 注）。
  if (isVolumeRemoved(root, data.id)) {
    log.debug('chat', `案卷 ${data.id} 已删——快照写被拒绝（防复活）`);
    return;
  }
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
 *  原样 → 重写同一路径（归属 = 存储位置，无字段改写面）。
 *  **同代校验与 `readVolumeData` 同一把尺子**（`cacheOfThisVolume`）：残留的上一代
 *  `.json` 不是本卷的快照——展开它改名 = 把**死卷**的消息表/账本写成新卷的缓存
 *  （下次开卷 `seq` 够大就整表搬过来），故残留一律当没有（只写 label 的干净快照）。 */
export async function renameSessionFile(projectPath: string, sessionId: number, label: string): Promise<void> {
  const data = await readVolumeJSON(projectPath, sessionId);
  if (!data) {
    showToast('案卷文件不存在，无法改名', 'error');
    return;
  }
  let born: string | undefined;
  try {
    born = (await readVolumeLogMessages(workspaceSessionsDir(projectPath), sessionId))?.header.createdAt;
  } catch (e) {
    // 读日志失败 ≠ 卷不存在（2026-10-29 收口）：改名照常写干净快照（born 缺失
    // ⇒ cacheOfThisVolume 判「缓存不是本卷的」，只写 label），但失败必须可见。
    log.warn('chat', `改名：案卷 ${sessionId} 事件日志读取失败（按无缓存处理）`, { error: String(e) });
  }
  const base: Pick<StoredSession, 'id' | 'label' | 'savedAt' | 'messages' | 'tokensUsed'> = cacheOfThisVolume(
    data,
    born,
  )
    ? data
    : { id: sessionId, label: '', savedAt: '', messages: [], tokensUsed: 0 };
  try {
    // ⚡ 连带修复（2026-09-14 审计）：改名此前**重建**卷对象（只写 6 个字面字段），
    // 于是 `tokens`（token 账本）与 `compose`（创作坞覆盖）被静默抹掉——改名即丢数据。
    // 现改为「展开原卷 → 只覆盖 label」：未知/后续新增字段天然保留（presetId 等）。
    await writeSessionSnapshot(projectPath, {
      ...base,
      id: sessionId,
      label,
      savedAt: base.savedAt || new Date().toISOString(),
      messages: base.messages ?? [],
      tokensUsed: base.tokensUsed ?? 0,
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
  // #5 修复（保留）：用 scanMaxSessionId（仅 list_directory，不读文件内容）替代
  // listSavedSessions（读全部卷文件）——避免与 restoreCanvasSpread 的 listSavedSessions
  // 调用双倍 I/O。发号对账只需最大档号，不需读内容。
  // B（2026-09-21）：扫出的档号交给 reconcileVolumeIssueFloor 与账、内存下限取 max——
  // **装配是扫盘的那一处**（发号路径不扫，见该函数注），地板公式与代际防护（H5）都在里面。
  const scanned = await scanMaxSessionId(projectPath);
  await reconcileVolumeIssueFloor(ctx, projectPath, scanned);
}
