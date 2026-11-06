// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 单卷续开 / 批量恢复 / 真删
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import { agentSessionState, type OwnedAgentHandle } from '../../../agent/agent-session-state';
import { removeAssetStateSession } from '../../../agent/asset-state';
import { log } from '../../../agent/logger';
import { sessionExecute } from '../../../composition/session-persistence-service';
import type { Message } from '../../../provider/types';
import { disposeAssetSessionStore, rebuildAssetTableFromMessages } from '../../../state/asset-store';
import { getCanvasStore } from '../../../state/canvas-store';
import { getComposeStore } from '../../../state/compose-store';
import { disposeSessionMessagesStore } from '../../../state/messages-store';
import { bumpSessionVolumes } from '../../../state/session-volumes-store';
import { showToast, TOAST_LONG_HOLD_MS } from '../../../state/toast-store';
import { deriveVolumeLabel, isUnnamedVolumeLabel } from '../../../state/volume-name';
import { bumpSession, getChatStore, msgStoreFor } from '../../../ui/chat-store';
import { adoptRestoredMessages } from '../../../ui/message-model';
import { getWorkspaceEpoch, isCurrentEpoch } from '../../../workspace-scope';
import { inheritedMessageCount, retireSessionLogPath } from '../session-log-store';
import { dropCatalogRow } from './session-catalog';
import { closeSession, hydrateSessionAgentVisible, seedVolumeLog, switchSession } from './session-crud';
import { type StoredSession, workspaceSessionsDir } from './session-paths';
import { readVolumeData } from './session-read';
import { rebuildMessagesFromMessages, rebuildTurnPairsFromProvider, renderRestoredSession } from './session-rebuild';
import { bindSessionExec, getAgentFactory, removeSessionExecState, setTurnPairs } from './session-registry';
import { saveSessionById } from './session-save';
import { isInternalMessage, type SessionContext } from './session-types';
import { markVolumeRemoved, unmarkVolumeRemoved } from './session-volume-guard';

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
  try {
    data = await readVolumeData(projectPath, sessionId);
  } catch (e) {
    // 读失败**不得**伪装成「空卷/不存在」（2026-10-29 收口）：明示 + 拒绝打开
    // （保留磁盘真源，用户重试/看日志，而不是把空白会话摊开再覆盖写）。
    log.warn('chat', `案卷 ${sessionId} 打开失败（读面异常）`, { error: String(e) });
    showToast('案卷读取失败（未改动磁盘上的卷——可稍后重试）', 'error');
    return false;
  }
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
  // 折叠状态随卷恢复（2026-09-24 修）：同一条纪律的另一半——重建句柄不丢折叠，
  // 载荷不会回到满值（真源 = 卷日志的 session/compaction，seedVolumeLog 已置回）。
  if (newAgent) newAgent.restoreCompactionFromLog?.();
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
    // 开卷落盘（2026-10-08 卷重建丢卡根治配套）：开卷动作推进了日志（adopt
    // reset）却不写快照 ⇒ 快照落后 ⇒ 下次开卷判陈旧 → 重建循环（51 号卷丢卡
    // 链的触发条件）。落盘把快照 seq 追上当前日志（采信/重建产物固化）。
    // 调用前代际校验：在途期间切走工作区则不发起（saveSessionById 取数据是同步
    // 段、写盘在 await 之后——起点必须落在原代际，防「W2 内容写进 W1 目录」）。
    if (isCurrentEpoch(epoch)) void saveSessionById(ctx, projectPath, sid);
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
  // 先退休该卷的活写面并**丢弃未落盘尾巴**（2026-10-29 收口）：否则删除后
  // closeSession → detach 的「先排空」会把刚删掉的 `.ndjson` 写回来（卷复活）。
  await retireSessionLogPath(root, sessionId);
  // 先登记「这一卷已删」再真删文件：本函数尾部的 `closeSession` 会 fire-and-forget 地
  // 写一份合卷快照（C8），在途的防抖自动存同理——不挡就把 `{id}.json` 写回来，成为
  // 下一轮档号复用时的「死卷快照」（见 `_removedVolumes` 注）。
  markVolumeRemoved(root, sessionId);
  try {
    await sessionExecute('delete_log', {
      root,
      id: String(sessionId),
    });
  } catch (e) {
    // 真删失败 = 卷还在：撤销登记（写面必须继续工作——不能因为一次删除失败把卷钉成只读）
    unmarkVolumeRemoved(root, sessionId);
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
  // 资产状态表随卷消亡（2026-10-07 asset-state）：**真删除**才清（内存 + 落盘文件）
  // ——合卷（从画布收走、卷仍在盘上）不清，续开时从磁盘恢复。best-effort 不阻塞
  // 删除流程（对齐 board 销毁的尽力而为语义）。
  void removeAssetStateSession(projectPath, String(sessionId)).catch(() => {});
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
