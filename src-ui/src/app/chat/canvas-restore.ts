// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工作区画布恢复 / 落盘（2026-11-12 自 app/chat/chat-core 搬出）。
//
// 画布状态是**工作区级**的（state/canvas-store）：摊开集合 + 公共物钉 + 视野，
// 存在 {workspace}/.lantai/canvas.json。本模块只做两件事——进工作区把它读回来
// （含悬空摊开项自愈），离开/关窗显式落盘。
//
// 自愈判据（2026-08-28 会话管理专项）：画布摊开集可能引用磁盘上不存在的卷——
// 空卷不落盘 / 卷文件被删 / 早期切换残留。剪枝只在目录列表**成功**时进行
// （列表失败 = 保守不剪，避免误删真实卷）。

import { agentSessionState } from '../../agent/agent-session-state';
import { log } from '../../agent/logger';
import { sessionExecute } from '../../composition/session-persistence-service';
import { useBgAlertStore } from '../../state/bg-alert-store';
import { getCanvasStore, loadCanvasFromDisk, saveCanvasToDisk } from '../../state/canvas-store';
import * as Session from '../../ui/chat-session';
import { getChatStore } from '../../ui/chat-store';
import type { SessionContext } from './session/session-types';

/** 恢复面需要的主机能力位（ChatCore 注入；本模块不依赖类本身）。 */
export interface CanvasRestoreHost {
  readonly panelId: string;
  sessionCtx(): SessionContext;
  switchSession(idx: number): void;
}

/** Stage-5：进工作区恢复画布——读工作区画布状态文件 → 摊开集合落回画布
 *  （拍板 11：展开 = 永远展开，重启恢复；Q-B 在画布语义下不再适用）。
 *  自愈（2026-08-28 会话管理专项）：画布摊开集可能引用磁盘上不存在的卷——
 *  空卷不落盘（saveActiveSession 只存非空卷）/ 卷文件被删 / 早期切换残留，
 *  直接恢复会每次启动弹「案卷文件读取失败」+ 画布残留幽灵流区。恢复前先探
 *  真实卷集（在开卷 + 磁盘已落盘卷），剪掉悬空摊开项并回写清理后的画布。
 *  剪枝只在目录列表**成功**时进行（列表失败 = 保守不剪，避免误删真实卷）。 */
export async function restoreCanvasSpread(host: CanvasRestoreHost, workspace: string): Promise<void> {
  await loadCanvasFromDisk(host.panelId, workspace);
  const st = getChatStore(host.panelId).sess.getState();
  const openIds = new Set(st.sessions.map((s) => s.id));

  // 磁盘已落盘卷集（目录缺席/列表失败 = 不剪枝，保守）。
  // P1-1（2026-09-02）：剪枝改为「文件名级 + 读结果级」双面——不再调
  // listSavedSessions（全量读 T 个卷文件）。文件名在目录里 = 存在；读阶段
  // readVolumeData null = 墓碑/空卷/坏 JSON（从摊开集剪掉，不弹失败 toast）。
  // seam（C 定案）：目录枚举换 list_volumes（provider 滤目录——文件名数组，
  // 目录缺席/读失败 = 不剪枝的保守语义保留）。
  // root 拼接收敛：workspaceSessionsDir（chat-session 唯一权威——消费方复用）
  const sessionsDir = Session.workspaceSessionsDir(workspace);
  let volumeNames: string[] | null = null;
  try {
    const raw = await sessionExecute('list_volumes', { root: sessionsDir });
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) volumeNames = parsed.filter((n): n is string => typeof n === 'string');
  } catch {
    /* 目录缺席/列表失败 = 不剪枝 */
  }

  // P0-3 两阶段恢复 + P1-1 去冗余（2026-09-02）：
  //   读阶段——并行读全部摊开卷 + 钉源卷（readVolumeData 互相独立），
  //   替代旧「先 listSavedSessions 全量读 T 卷、再恢复循环串行读 spread 卷」
  //   的双倍 I/O。读结果 null = 墓碑/空卷/缺失（读阶段即发现，不弹 toast）。
  //   应用阶段——串行 setState/消息重建（并行会触发全局 msgId 计数器重置
  //   竞态与 sessions append 覆盖）。
  const canvasState0 = getCanvasStore(host.panelId).getState();
  const readTargets = new Set<number>();
  for (const sid of Object.keys(canvasState0.spread)) {
    const n = Number(sid);
    if (!openIds.has(n)) readTargets.add(n);
  }
  // 钉源卷不在摊开集也要读（孤儿钉「收回/删除」按钮判定需要知道源是否已删）
  for (const pin of Object.values(canvasState0.pins)) {
    if (pin.source && !openIds.has(pin.source.sessionId)) readTargets.add(pin.source.sessionId);
  }
  const readResults = await Promise.all(
    [...readTargets].map((sid) =>
      Session.readVolumeData(workspace, sid)
        .then((data) => ({ sid, data, failed: false }))
        .catch((e) => {
          // 读失败 ≠ 卷不存在（2026-10-29 收口）：标记 failed，剪枝面据此**保留**该卷
          console.error('[canvas] 恢复摊开卷预读失败（保留不剪枝）', sid, e);
          return { sid, data: null as null, failed: true };
        }),
    ),
  );
  const readBySid = new Map<number, import('../../ui/chat-session').StoredSession | null>();
  const readFailed = new Set<number>();
  for (const { sid, data, failed } of readResults) {
    readBySid.set(sid, data);
    if (failed) readFailed.add(sid);
  }

  if (volumeNames) {
    // 文件名级存在性（剪枝面 1）：摊开/钉源卷的**事件日志**（`.ndjson`——Phase 3b
    // 起卷本体）不在目录里 = 幽灵。`.json` 只是投影缓存，不参与存在性判定。
    // #1 修复的保守语义保留：目录列表失败 = 不剪枝（避免误删真实卷）。
    const fileIds = new Set<number>();
    for (const name of volumeNames) {
      if (!name.endsWith('.ndjson') || name.startsWith('_')) continue;
      const n = parseInt(name.replace('.ndjson', ''), 10);
      if (!Number.isNaN(n)) fileIds.add(n);
    }
    // 读结果级有效性（剪枝面 2）：文件在但 readVolumeData null = 空卷——
    // 从摊开集剪掉（替代旧 listSavedSessions 的墓碑过滤，不再弹读取失败 toast）。
    // **读失败（readFailed）不剪**：读不出来 ≠ 卷不存在（2026-10-29 收口）——
    // 剪掉等于把真卷当幽灵从画布上抹掉（还会回写 canvas.json）。
    const phantom = Object.keys(canvasState0.spread).filter((sid) => {
      const n = Number(sid);
      if (openIds.has(n)) return false; // 已在案头 = 有效
      if (readFailed.has(n)) return false; // 读面异常 = 保留现场，等下次
      return !fileIds.has(n) || readBySid.get(n) === null;
    });
    if (phantom.length > 0) {
      for (const sid of phantom) getCanvasStore(host.panelId).getState().removeRegion(sid);
      // 活跃会话指向若落在被剪的幽灵卷 → 一并清掉（不残留失效指向）
      const curActive = getCanvasStore(host.panelId).getState().activeSessionId;
      if (curActive != null && phantom.includes(curActive)) {
        getCanvasStore(host.panelId).getState().setActiveRegion(null);
      }
      // 回写清理后的画布（幂等——下次启动已无悬空项，不再重复剪）
      void saveCanvasToDisk(host.panelId, workspace).catch((e) =>
        console.warn('[chat-core] 画布回写失败（幽灵卷清理未落盘，下次启动重试）:', e),
      );
    }
    // 已删源会话播种（2026-08-28 会话管理专项）：钉的源卷既不在开卷、也
    // 读不出有效数据（墓碑/空卷/文件没了）——「收回」语义失效，孤儿钉
    // 按钮应显示「删除」。deleteSessionFile 运行时另做增量标记。
    const dead = new Set<number>();
    for (const pin of Object.values(getCanvasStore(host.panelId).getState().pins)) {
      const src = pin.source?.sessionId;
      if (src == null || openIds.has(src)) continue;
      const read = readBySid.get(src);
      if (readFailed.has(src)) continue; // 读面异常：不知道源还在不在，别急着标「已删」
      if (read === null || !fileIds.has(src)) dead.add(src);
    }
    if (dead.size > 0) getCanvasStore(host.panelId).getState().replaceDeletedSessionIds(dead);
  }

  // 应用阶段（P3-1，2026-09-02）：批量铺开——一次 setState 摊全部卷（读数据
  // 已在 readBySid，不再触盘），随后逐卷填内容层（会话级 store 不触 sess 订阅）。
  // 替代旧「逐卷 loadSessionFromDisk = N 次 setState append」——sess 订阅
  // （PaperPanel sessions 同步 + 消息订阅 effect）从 N 次降为 1 次。
  // 活跃卷句柄：末尾 switchSession 的惰性补建承担（批量应用不造 Agent）。
  const batchItems: Array<{ sid: number; data: import('../../ui/chat-session').StoredSession }> = [];
  for (const sid of readTargets) {
    // 钉源补充读的卷可能不在摊开集（只供孤儿钉判定用）——不摊开
    if (!Object.hasOwn(canvasState0.spread, String(sid))) continue;
    // 墓碑/空卷/缺失（read null）——剪枝阶段已从摊开集移除，不进批量
    const data = readBySid.get(sid);
    if (data != null) batchItems.push({ sid, data });
  }
  const restoreFailed = await Session.batchRestoreSessions(host.sessionCtx(), batchItems);
  // D5（拍板 C）：恢复失败可见——StatusLine 警告档 + 一次性提示条
  if (restoreFailed > 0) {
    useBgAlertStore.getState().pushBgAlert('restore-open', `有 ${restoreFailed} 卷恢复失败——可在左侧栏手动展开`);
  } else {
    useBgAlertStore.getState().clearBgAlert('restore-open');
  }
  // #6 修复：恢复活跃会话指向——重新取 state（上方剪枝已产生新 state，
  // 旧 canvas 快照的 activeSessionId 可能已过期）
  const freshActive = getCanvasStore(host.panelId).getState().activeSessionId;
  const activeSid = freshActive ? Number(freshActive) : null;
  if (activeSid != null) {
    const st2 = getChatStore(host.panelId).sess.getState();
    const idx = st2.sessions.findIndex((s) => s.id === activeSid);
    if (idx >= 0 && idx !== st2.activeIdx) host.switchSession(idx);
  }

  // ── 枝线卷的后台句柄水合（2026-09-19，真机报的「重启后引线消失」）──
  // 批量恢复刻意不造句柄（P3-1），只有活跃卷由上面那次 switchSession 惰性补建；
  // 而枝边的画布承接要求**父子卷都有句柄**（血缘在子卷头行、父卷那个节点要走父卷的
  // 投影与定位桥）⇒ 非活跃的枝卷/父卷重启后一条线都画不出来。
  // 只为**参与枝边的摊开卷**补建（子卷 + 其父卷，且都在摊开集内）：数量 = 树上的卷
  // （摊开集按设计只放活跃路径），不是全摊开集。串行补建避免启动期 I/O 突发；
  // 失败可见（console + warn），不挡冷启动。
  const spread = getCanvasStore(host.panelId).getState().spread;
  const edgeSids: number[] = [];
  for (const s of getChatStore(host.panelId).sess.getState().sessions) {
    if (!Object.hasOwn(spread, String(s.id))) continue;
    const parentId = readBySid.get(s.id)?.parentId;
    if (parentId == null) continue;
    if (!edgeSids.includes(s.id)) edgeSids.push(s.id);
    if (Object.hasOwn(spread, String(parentId)) && !edgeSids.includes(parentId)) edgeSids.push(parentId);
  }
  if (edgeSids.length > 0) {
    void (async () => {
      for (const sid of edgeSids) {
        if (agentSessionState.getAgent(host.panelId, sid)) continue;
        try {
          await Session.ensureVolumeAgent(host.sessionCtx(), sid);
        } catch (e) {
          console.error('[chat-core] 枝线卷句柄水合失败', sid, e);
          log.warn('chat', `案卷 ${sid} 的 Agent 未就绪（枝边引线待其就绪后出现）`, { error: String(e) });
        }
      }
    })();
  }
}

/** Stage-5：显式保存点落盘工作区画布状态（切换 / 关闭窗口时调用）。 */
export async function saveCanvasState(panelId: string, workspace: string): Promise<void> {
  await saveCanvasToDisk(panelId, workspace);
}
