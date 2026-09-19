// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话树「枝」——从某个切点另起一卷（P1：从卷尾立枝）。
// 立项件：`docs/plans/session-tree-plan.md`。
//
// 形态（plan §1/§2）：**节点自包含**——枝卷 = 父卷前缀的**复制**（seq ≤ 切点）
// + 自己的后续事件；**边落头行**——`SessionLogHeader.parent{id, atSeq}`
// （write-once，app 层，不进 phase-5 快照 ⇒ 零 BCR）。
//
// 立枝是**纯数据动作**：读父卷日志 → 写新卷 `.ndjson`（头行 + 前缀，走 seam 的
// 原子替换写）→ 交既有开卷路径摊开（`loadSessionFromDisk` 读路径**一行不改**）。
// 不建 Agent、不碰父卷一个字节、不动事件词表。
//
// 三条切点纪律（plan §3）：
//   ① **只落已落定处**：前缀里每个宣布的 `tool_call` 都必须有配对结果——这是
//      provider 转写合法性，不是风格问题。判据复用 `danglingToolCalls`（恢复链
//      同一真源，杜绝第二把尺子）。没落定 = 具名拒绝，**绝不「悄悄向前归一」**
//      （那会让用户从"第 1 个工具结果"立枝却拿到含第 2/3 个结果的枝 = 静默改语义）。
//   ② **切点必须已落盘**：父卷在案头时先排空写后队列（200ms 窗口，见
//      `session-log-store` 的写后队列），再读盘取前缀。
//   ③ **边归一化**（plan §1.3）：在**继承区**内立枝时，边归到上层卷——否则树画错，
//      且删除连坐（P2）会删错子树。

import { agentSessionState } from '../../agent/agent-session-state';
import { log } from '../../agent/logger';
import type { SessionEvent } from '../../agent/session-log';
import { danglingToolCalls } from '../../agent/session-log-repair';
import { sessionExecute } from '../../composition/session-persistence-service';
import { bumpSessionVolumes } from '../../state/session-volumes-store';
import { showToast, TOAST_LONG_HOLD_MS } from '../../state/toast-store';
import type { SessionContext } from '../../ui/chat-session';
import { loadSessionFromDisk, scanMaxSessionId, workspaceSessionsDir } from '../../ui/chat-session';
import { getChatStore } from '../../ui/chat-store';
import {
  flushSessionLog,
  loadSessionLogFile,
  type SessionLogHeader,
  type SessionLogParentRef,
} from './session-log-store';

/** 血缘上溯的深度上限（坏数据成环时的兜底——正常树远小于此）。 */
const MAX_ANCESTOR_WALK = 64;

/** 立枝结果。`ok:false` 时 `reason` 已 toast（错误不静默），调用方无需再报。 */
export type BranchResult = { ok: true; sid: number } | { ok: false; reason: string };

/** 具名拒绝 + 可见化（本模块唯一的失败出口形态）。 */
function refuse(reason: string): BranchResult {
  showToast(reason, 'warn', TOAST_LONG_HOLD_MS);
  return { ok: false, reason };
}

/**
 * **父边归一化**（plan §1.3）：把切点归到「自己的区域覆盖它的那一卷」。
 *
 * 为什么必须有：在**继承区**内立枝时，「父 = 来源卷」会画出错的边——
 * B 从 A 的 `seq 50` 分出（B.parent = `A@50`，B 自己的区域自 `51` 起），随后 C 从
 * B 的 `seq 30` 分出——30 落在 B 的继承区里，那份内容其实来自 A。此时 C 的边若记成
 * B，树会把 C 挂在 B 的分叉点下游（画错），而**级联删除会删错子树**。
 *
 * 规则：沿 `parent` 上溯，直到 `atSeq > 该卷.parent.atSeq`（= 切点落在它自己的区域里）；
 * `atSeq == parent.atSeq` 视为全部继承，继续上溯。无父 = 根卷。
 *
 * 返回 null = **首跳就读不出来**（来源卷缺失）——调用方据此具名拒绝。
 * 上溯中途断链（祖卷文件不在/读坏）= 血缘止于最后一个可读卷：内容自包含，
 * 不能因为祖先缺席就把枝立不成（树的连通性优先，诚实记录一次 warn）。
 */
export async function resolveBranchOrigin(
  root: string,
  fromId: number,
  atSeq: number,
): Promise<SessionLogParentRef | null> {
  let id = fromId;
  let lastReadable: SessionLogParentRef | null = null;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth++) {
    const loaded = await loadSessionLogFile(root, id);
    if (!loaded) {
      if (lastReadable) {
        log.warn('chat', `立枝：血缘上溯断链（案卷 ${id} 读不出来），边止于案卷 ${lastReadable.id}`);
      }
      return lastReadable;
    }
    const up = loaded.header.parent;
    if (!up || atSeq > up.atSeq) return { id, atSeq };
    lastReadable = { id, atSeq };
    id = up.id;
  }
  log.warn('chat', `立枝：血缘上溯超过 ${MAX_ANCESTOR_WALK} 层（疑似成环），止于案卷 ${id}`);
  return lastReadable ?? { id, atSeq };
}

/** 立枝备料：切点 + 归一化后的边 + 前缀事件 + 继承的组合。 */
interface BranchSeed {
  origin: SessionLogParentRef;
  /** 要复制进新卷的前缀事件（父卷事件的字节同源副本，seq 原样保留）。 */
  events: SessionEvent[];
  /** 父卷生效组合（newest-wins，`resolveSessionPreset` 单一真源）——枝出生即继承。 */
  presetId?: string;
}

type SeedResult = { ok: true; seed: BranchSeed } | { ok: false; reason: string };

/** 三种「有内容」的事件（判定卷非空——与 `readVolumeData` 的空卷判据同源）。 */
function isContentEvent(ev: SessionEvent): boolean {
  return ev.kind === 'user/message' || ev.kind === 'assistant/text' || ev.kind === 'tool/result';
}

/** 备料：读父卷日志 → 三道校验（落盘/非空/已落定）→ 切点 + 归一化边。 */
async function prepareBranchSeed(root: string, fromId: number, atSeq?: number): Promise<SeedResult> {
  const loaded = await loadSessionLogFile(root, fromId);
  if (!loaded) return { ok: false, reason: `案卷 ${fromId} 的事件日志读不出来，无从立枝` };
  // 断尾/坏行：认领到的前缀是安全的，但父卷文件带垃圾 ⇒ 立出来的枝与父卷字节不同源
  // （父卷下次打开还会被截断修复，两卷内容会悄悄分叉）。宁缺毋滥：先修好再立。
  if (loaded.stopReason !== null) {
    return { ok: false, reason: '这一卷的日志有断尾或坏行——先打开它让恢复链修好，再立枝' };
  }
  if (loaded.events.length === 0) return { ok: false, reason: '这一卷还没有内容，无从立枝' };
  const cut = atSeq ?? loaded.events.at(-1)?.seq ?? 0;
  const prefix = loaded.events.filter((e) => e.seq <= cut);
  if (prefix.length === 0) return { ok: false, reason: '切点之前没有内容，无从立枝' };
  // 空卷不能立枝：立出来的是「卷在盘上但摊不开」的幽灵（readVolumeData 空卷判空
  // 会把它从摊开集与侧栏都滤掉——用户看得见文件、点不开）。
  if (!prefix.some(isContentEvent)) return { ok: false, reason: '这一卷还没有内容，无从立枝' };
  // ① 已落定：每个宣布的 tool_call 都得有配对结果（provider 转写合法性）
  const dangling = danglingToolCalls(prefix);
  if (dangling.length > 0) {
    return {
      ok: false,
      reason: `这一卷还有 ${dangling.length} 处工具调用没落定（正在跑或崩溃残留）——等它跑完或打开这一卷让恢复链补完再立枝`,
    };
  }
  const origin = await resolveBranchOrigin(root, fromId, cut);
  if (!origin) return { ok: false, reason: `案卷 ${fromId} 的血缘读不出来，无从立枝` };
  // 组合继承：先认**事件记录**（S4-1b 首事件方案起：`preset/selected` 是选型事实，
  // newest-wins，空白期改选也会追加），旧卷（无该 kind）退回**头行**的出生记录。
  // 与开卷路径同判据族（`readVolumeData` 的 `cache?.presetId ?? header.presetId`）——
  // 枝出生即继承父卷生效组合：既是意图，也是钱（前缀逐字节同源 ⇒ 提供方缓存命中）。
  const { SessionLog } = await import('../../agent/session-log');
  const presetId = SessionLog.replay(prefix).resolveSessionPreset() ?? loaded.header.presetId;
  return { ok: true, seed: { origin, events: prefix, ...(presetId ? { presetId } : {}) } };
}

/**
 * 立枝：从 `atSeq`（缺省 = **卷尾**）另起一枝，返回新卷号。
 *
 * 发号纪律与建卷同源：`max(会话 store 的 nextSessionId, 磁盘最大卷号 + 1)`——
 * 目标文件是**原子替换写**，撞号即覆写既有卷，所以宁可多发一号也不赌。
 *
 * 摊开走既有开卷路径（读路径零改动）；摊开失败**不回滚**——卷已在盘上、侧栏可点开，
 * 只是这一次没摊到案头（可见 warn，不静默）。
 */
export async function createBranchVolume(ctx: SessionContext, fromId: number, atSeq?: number): Promise<BranchResult> {
  const projectPath = ctx.getProjectPath();
  if (!projectPath) return refuse('立枝需要先有工作区');
  let root: string;
  try {
    root = workspaceSessionsDir(projectPath);
  } catch (e) {
    return refuse(`立枝失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ② 切点已落盘：父卷在案头时先排空它的写后队列（未 attach = no-op）
  try {
    await flushSessionLog(agentSessionState.getAgent(ctx.storeId, fromId)?.sessionLog ?? null);
  } catch (e) {
    log.warn('chat', `立枝：父卷（案卷 ${fromId}）写队列排空失败，按磁盘现状取材`, { error: String(e) });
  }

  const prepared = await prepareBranchSeed(root, fromId, atSeq);
  if (!prepared.ok) return refuse(prepared.reason);
  const { origin, events, presetId } = prepared.seed;

  const sess = getChatStore(ctx.storeId).sess.getState();
  const scanned = await scanMaxSessionId(projectPath);
  const id = Math.max(sess.nextSessionId, scanned + 1);
  sess.setNextSessionId(id + 1);

  const header: SessionLogHeader = {
    type: 'session',
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    ...(presetId ? { presetId } : {}),
    cwd: projectPath,
    parent: origin,
  };
  const payload = `${JSON.stringify(header)}\n${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  try {
    await sessionExecute('write_log', { root, id: String(id), data: payload });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return refuse(`枝卷写盘失败：${why}`);
  }
  // 卷清单变更信号（写落定之后才 bump——侧栏按此重读清单投影）
  bumpSessionVolumes();

  let opened = false;
  try {
    opened = await loadSessionFromDisk(ctx, projectPath, id);
  } catch (e) {
    log.warn('chat', `立枝：新枝卷 ${id} 摊开失败（卷已在盘上，可从侧栏点开）`, { error: String(e) });
  }
  if (!opened) showToast(`枝已立（案卷 ${id}），但没能摊到案头——可在侧栏点开`, 'warn', TOAST_LONG_HOLD_MS);
  return { ok: true, sid: id };
}
