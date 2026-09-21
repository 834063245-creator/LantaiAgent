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
import type { SessionEvent, SessionLogErasedRange } from '../../agent/session-log';
import { danglingToolCalls } from '../../agent/session-log-repair';
import { sessionExecute } from '../../composition/session-persistence-service';
import type { Message, ToolCall } from '../../provider/types';
import { bumpSessionVolumes } from '../../state/session-volumes-store';
import { showToast, TOAST_LONG_HOLD_MS } from '../../state/toast-store';
import type { SessionContext, SessionDeleteResult } from '../../ui/chat-session';
import {
  canRetraceUserTurn,
  isInternalMessage,
  listVolumeIds,
  loadSessionFromDisk,
  noteVolumeIssued,
  reconcileVolumeIssueFloor,
  scanMaxSessionId,
  workspaceSessionsDir,
} from '../../ui/chat-session';
import { getChatStore, msgStoreFor } from '../../ui/chat-store';
import {
  flushSessionLog,
  inheritedCountAt,
  loadSessionLogFile,
  type SessionLogHeader,
  type SessionLogParentRef,
  sessionLogStoreOf,
} from './session-log-store';

/** 血缘上溯的深度上限（坏数据成环时的兜底——正常树远小于此）。 */
const MAX_ANCESTOR_WALK = 64;

/** 立枝结果。`ok:false` 时 `reason` 已 toast（错误不静默），调用方无需再报。 */
export type BranchResult = { ok: true; sid: number } | { ok: false; reason: string };

/** 可立枝的节点（UI 消息的最小形状——`chat-core` 直接把 ChatMessage 传进来）。 */
export interface BranchNode {
  /** UI 消息 id（`_id`）——经既有尾对齐映射落到投影下标。 */
  _id: string;
  role: string;
  /** 助手消息回答的来文 `_id`（`AssistantMessage.respondingTo`）——助手块的定位入口。 */
  respondingTo?: string;
}

/** 某节点的切点（`atSeq` = 枝要包含的最后一个事件 seq）或不可立枝的具名原因。 */
export type BranchPoint = { ok: true; atSeq: number } | { ok: false; reason: string };

/** 枝边血缘（父卷 + 切点）——侧栏/书脊/卷首那枚「枝」标与画布引线的取材形状。 */
export type BranchNodeOrigin = SessionLogParentRef;

/**
 * 定位上下文（**一次算清**，单点与批量共用同一份判据）。
 *
 * 为什么要有这一层：`resolveBranchPoint` 里的 `deriveMessageAnchors()` 是**整段 fold**
 * （O(事件数)），逐块调它 = O(块数 × 事件数)——长卷上渲染期拖帧。故把「会话 / 锚点 /
 * 最早未落定点 / 尾对齐桥」一次算清，逐节点判定退化为 O(1)。
 */
interface BranchContext {
  session: ReadonlyArray<{ role?: string; content?: string }>;
  /** 与 `session` 同长同序的来源事件 seq（`SessionLog.deriveMessageAnchors()`）。 */
  anchors: readonly number[];
  /** 日志里**最早的未落定点** seq（null = 全落定）——切点 ≥ 它即含未落定批次。 */
  firstUnsettled: number | null;
  /** 当前悬空的调用数（置灰文案用）。 */
  danglingCount: number;
  bridge: { byUiId: Map<string, number> } | null;
}

type ContextResult = { ok: true; ctx: BranchContext } | { ok: false; reason: string };

/**
 * 最早的「未落定」点：日志里第一条**宣布了当前仍悬空**的调用的事件 seq。
 *
 * 「哪些调用还悬空」取自 `danglingToolCalls`（恢复链的同一真源）——本函数只**定位**
 * 它们出现在哪，不另立判据。
 *
 * 诚实边界：`danglingToolCalls` 会在 `session/reset` / `session/retract` 处清空，
 * 故「切点 ≥ 本点」是**充分**条件而非等价条件——夹在「宣布」与「清空」之间的切点
 * 会被判为可立枝，点下去仍由 `resolveBranchPoint` 具名拒绝（方向是安全的：
 * 绝不把**合法**的枝灰掉；实际卷里悬空只可能出现在**日志尾部**——开卷路径已用
 * `interruptedToolCallClosers` 修好历史，运行中的那一批就是尾巴）。
 */
function firstUnsettledSeq(events: readonly SessionEvent[], stillDangling: ReadonlySet<string>): number | null {
  for (const ev of events) {
    if (ev.kind === 'assistant/text') {
      const calls = (ev.data as { message: Message }).message?.tool_calls ?? [];
      for (const call of calls) {
        if (stillDangling.has(String(call.id ?? ''))) return ev.seq;
      }
    } else if (ev.kind === 'tool/call') {
      const call = (ev.data as { call: ToolCall }).call;
      if (stillDangling.has(String(call?.id ?? ''))) return ev.seq;
    }
  }
  return null;
}

/** 定位上下文构建（**一趟一次**；`nodes` 只用于触发尾对齐桥）。 */
function branchContext(storeId: string, sid: number, nodes: readonly BranchNode[]): ContextResult {
  const agent = agentSessionState.getAgent(storeId, sid);
  if (!agent) return { ok: false, reason: '本卷的 Agent 未就绪（配好 API Key 后再试）' };
  const logInstance = agent.sessionLog;
  if (!logInstance) return { ok: false, reason: '本卷没有事件日志（旧实现/测试桩），无从立枝' };
  // 尾对齐桥整趟只对齐一次：`canRetraceUserTurn` 的失效戳（会话长度 / 界面来文数）
  // 在一趟里不会变，逐节点调它 = 每块一次 O(消息数) 的来文过滤（渲染期拖帧）。
  // 传哪个 id 不影响对齐结果（对不上即返回 false，对齐已发生）。
  if (nodes.length > 0) canRetraceUserTurn(storeId, sid, nodes[0]._id);
  const events = logInstance.events();
  const dangling = danglingToolCalls(events);
  const stillDangling = new Set(dangling.map((c) => c.callId));
  return {
    ok: true,
    ctx: {
      session: agent.getSession(),
      anchors: logInstance.deriveMessageAnchors(),
      firstUnsettled: dangling.length > 0 ? firstUnsettledSeq(events, stillDangling) : null,
      danglingCount: dangling.length,
      bridge: agentSessionState.getTurnIdBridge(storeId, sid),
    },
  };
}

/** 单节点判定（上下文的纯消费面——单点与批量**同一条**判据）。 */
function branchPointIn(ctx: BranchContext, node: BranchNode): BranchPoint {
  if (node.role !== 'user' && node.role !== 'assistant') {
    return { ok: false, reason: '通知不是对话节点，无从立枝' };
  }
  // 定位用户轮：来文块用自己；回复块用 respondsTo（同一条尾对齐链）
  const userId = node.role === 'user' ? node._id : node.respondingTo;
  if (!userId) return { ok: false, reason: '这条回复没有可定位的来文（旧存档缺关联），无从立枝' };
  const userIdx = ctx.bridge?.byUiId.get(userId);
  if (userIdx == null || userIdx < 0 || userIdx >= ctx.session.length || ctx.session[userIdx]?.role !== 'user') {
    return { ok: false, reason: '该轮已不可唯一定位（会话已压缩或上下文已变），无从立枝' };
  }

  let cutIdx = userIdx;
  if (node.role === 'assistant') {
    // 走到**下一个真正的来文**为止——内部来文（`<system-reminder>` / `<goal>` 等，
    // `isInternalMessage` 同一把尺子）不算轮边界：轮内被 append 的内部插入若当成边界，
    // 枝会止于插入之前（后面的工具结果/正文不在枝里，且缺得看不出来）。
    let i = userIdx + 1;
    while (i < ctx.session.length) {
      const m = ctx.session[i];
      if (m?.role === 'user' && !isInternalMessage(m.content)) break;
      i++;
    }
    cutIdx = Math.max(userIdx, i - 1);
  }
  const atSeq = ctx.anchors[cutIdx];
  if (typeof atSeq !== 'number') {
    return { ok: false, reason: '该节点在事件日志里没有来源锚点（日志与会话不同步），无从立枝' };
  }
  if (ctx.firstUnsettled !== null && atSeq >= ctx.firstUnsettled) {
    return { ok: false, reason: `这一轮还有 ${ctx.danglingCount} 处工具调用没落定——等它跑完再立枝` };
  }
  return { ok: true, atSeq };
}

/**
 * **节点 → 事件切点**（会话树「枝」的定位半边，plan §3/§4）。
 *
 * 「枝含该节点」：
 *   · **来文块** → 切点 = 这条来文自己的来源 seq（新枝到此为止，改写在枝上继续）；
 *   · **回复块** → 一条 UI 助手消息聚合**整轮**（parts 里含工具/子代理块）⇒ 切点 =
 *     本轮最后一个已落定节点的 seq。停止条件 = 下一条**真正的**来文——轮内被 append 的
 *     内部来文（`<system-reminder>` / `<goal>` 等）不是轮边界，故切点落在**整轮末尾**
 *     （判据 = `isInternalMessage`，与恢复/导出/撤回定位**同一把尺子**，见
 *     `ui/chat-session.ts`；plan §3.2 的书面语义「该节点所属批次全部落定之后」）。
 *
 * 定位链全部复用既有单一真源，不另立尺子：
 *   UI `_id` →（`canRetraceUserTurn` 触发的尾对齐 `TurnIdBridge`）→ 投影下标 →
 *   （`SessionLog.deriveMessageAnchors()`，与投影同一个 fold）→ 事件 seq →
 *   （`danglingToolCalls`，恢复链同一判据）→ 落定校验。
 *
 * 纯同步、零 I/O（故可在点击时即时判定）；不可立枝一律给具名原因，绝不静默失败。
 */
export function resolveBranchPoint(storeId: string, sid: number, node: BranchNode): BranchPoint {
  const built = branchContext(storeId, sid, [node]);
  if (!built.ok) return { ok: false, reason: built.reason };
  return branchPointIn(built.ctx, node);
}

/**
 * **一卷内全部节点的可立枝判据**（一次性派生，O(事件数 + 节点数)）——「立枝」按钮
 * 置灰 + 具名原因的**渲染期读面**。
 *
 * 为什么批量：判据里含 `deriveMessageAnchors()`（整段 fold）与尾对齐桥（读界面来文
 * 表），逐块问就是 O(块数 × 事件数)。这里一趟算清上下文、逐节点 O(1) 判定，判据与
 * `resolveBranchPoint` **同一条**（`branchPointIn`）——绝不出现「灰着却能点」或
 * 「能点却灰着」的第二把尺子。
 *
 * 返回 `Map<节点 _id, 判据>`；未列出的节点 = 无判据（调用方按可立枝处理，点击时仍由
 * `resolveBranchPoint` 兜底——置灰是提示，不是门禁）。
 */
export function deriveBranchPoints(
  storeId: string,
  sid: number,
  nodes: readonly BranchNode[],
): Map<string, BranchPoint> {
  const out = new Map<string, BranchPoint>();
  if (nodes.length === 0) return out;
  const built = branchContext(storeId, sid, nodes);
  if (!built.ok) {
    for (const n of nodes) out.set(n._id, { ok: false, reason: built.reason });
    return out;
  }
  for (const n of nodes) out.set(n._id, branchPointIn(built.ctx, n));
  return out;
}

/** 具名拒绝 + 可见化（本模块唯一的失败出口形态）。 */
function refuse(reason: string): BranchResult {
  showToast(reason, 'warn', TOAST_LONG_HOLD_MS);
  return { ok: false, reason };
}

// ═══════════════════════════════════════════════════════════════
// 画布承接（P3）：枝边的**读面**——引线从枝卷卷首拉向父卷的那个节点
// ═══════════════════════════════════════════════════════════════

/**
 * 某**摊开卷**的枝边（child → 父卷 + 切点）。
 *
 * 真源 = 卷日志头行（`SessionLogStore.header`，attach 时带入内存，write-once）
 * ⇒ **零 I/O、O(1)**——画布每帧问它也不花钱。null = 根卷 / 无句柄 / 无日志
 * （旧实现或测试桩）。
 */
export function branchOriginOf(storeId: string, sid: number): SessionLogParentRef | null {
  const logInstance = agentSessionState.getAgent(storeId, sid)?.sessionLog;
  if (!logInstance) return null;
  return sessionLogStoreOf(logInstance)?.header.parent ?? null;
}

/**
 * 枝边的**父卷落点**：切点 seq → 父卷里承载它的那条**界面消息** `_id`。
 *
 * 这就是引线要指的那个节点（plan §5「引线连回父卷的那个节点」，不是「父卷」这个整体）。
 * 方向与 `resolveBranchPoint` 相反，但**同一条链**：投影锚点（与投影同一个 fold）
 * → 用户轮桥（同一条尾对齐）→ 界面消息（用户轮 = 桥的来文；其余归到该轮的回复）。
 *
 * 返回 null = 该切点在父卷里落不到界面消息（无句柄/桥对不上/切点在首轮之前）——
 * 调用方据此不画引线（宁可没有线，也不指错）。
 */
export function branchNodeMessageId(storeId: string, sid: number, atSeq: number): string | null {
  const agent = agentSessionState.getAgent(storeId, sid);
  const logInstance = agent?.sessionLog;
  if (!agent || !logInstance) return null;
  const session = agent.getSession();
  // 切点 → 投影下标 = **该切点处的投影消息条数 - 1**（`inheritedCountAt` = 同一把尺子：
  // 最后一个「来源 seq ≤ 切点」的投影下标 + 1；它同时供「给未命名卷起名」用，一条实现）。
  // 注意传的是**本卷（父卷）自己的**日志 + 子卷的切点——不是 `inheritedMessageCount`。
  const k = inheritedCountAt(logInstance, atSeq) - 1;
  if (k < 0 || k >= session.length) return null;
  const msgs = msgStoreFor(storeId, sid).getState().messages;
  const uiUsers = msgs.filter((m) => m.role === 'user');
  if (uiUsers.length === 0) return null;
  // 桥整趟只对齐一次（`canRetraceUserTurn` 的失效戳在此不变）——与 deriveBranchPoints 同法
  canRetraceUserTurn(storeId, sid, uiUsers[0]._id);
  const bridge = agentSessionState.getTurnIdBridge(storeId, sid);
  if (!bridge) return null;
  // 该消息属于哪一轮：≤ k 的最后一个 user 投影下标
  let u = -1;
  for (let i = k; i >= 0; i--) {
    if (session[i]?.role === 'user') {
      u = i;
      break;
    }
  }
  if (u < 0) return null;
  let uiUserId: string | null = null;
  for (const [uiId, idx] of bridge.byUiId) {
    if (idx === u) {
      uiUserId = uiId;
      break;
    }
  }
  if (!uiUserId) return null;
  if (k === u) return uiUserId;
  // 回复/工具结果归到该轮的回复块（引线指「那个节点」所在的块）
  const owner = msgs.find((m) => m.role === 'assistant' && m.respondingTo === uiUserId);
  return owner?._id ?? uiUserId;
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
 *
 * `readEdge` 可注入（血缘图重建：头行一次性并行读全，上溯零 I/O）——**判据只有这一份**，
 * 删除侧复用同一条规则，绝不另写一遍（plan §7 P2 硬规：否则会删错子树）。
 */
export type ParentEdgeReader = (id: number) => Promise<{ parent?: SessionLogParentRef } | null>;

export async function resolveBranchOrigin(
  root: string,
  fromId: number,
  atSeq: number,
  readEdge?: ParentEdgeReader,
): Promise<SessionLogParentRef | null> {
  const read: ParentEdgeReader =
    readEdge ??
    (async (id) => {
      const loaded = await loadSessionLogFile(root, id);
      if (!loaded) return null;
      return loaded.header.parent ? { parent: loaded.header.parent } : {};
    });
  let id = fromId;
  let lastReadable: SessionLogParentRef | null = null;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth++) {
    const edge = await read(id);
    if (edge === null) {
      if (lastReadable) {
        log.warn('chat', `立枝：血缘上溯断链（案卷 ${id} 读不出来），边止于案卷 ${lastReadable.id}`);
      }
      return lastReadable;
    }
    const up = edge.parent;
    if (!up || atSeq > up.atSeq) return { id, atSeq };
    lastReadable = { id, atSeq };
    id = up.id;
  }
  log.warn('chat', `立枝：血缘上溯超过 ${MAX_ANCESTOR_WALK} 层（疑似成环），止于案卷 ${id}`);
  return lastReadable ?? { id, atSeq };
}

/** 立枝备料：切点 + 归一化后的边 + 前缀事件 + 继承的组合 + 继承的抹除账。 */
interface BranchSeed {
  origin: SessionLogParentRef;
  /** 要复制进新卷的前缀事件（父卷事件的字节同源副本，seq 原样保留）。 */
  events: SessionEvent[];
  /** 父卷生效组合（newest-wins，`resolveSessionPreset` 单一真源）——枝出生即继承。 */
  presetId?: string;
  /** 父卷的**抹除账**（压实产生的合法空洞）——前缀带着同样的空洞，子卷头行必须同账，
   *  否则子卷文件被读路径判成「序号断裂」（掉行）而截断（2026-09-19 A 案连带面）。 */
  erased?: SessionLogErasedRange[];
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
  // 抹除账随前缀裁剪继承：只带切点之内的段（切点之外的抹除与本卷无关）
  const inheritedErased = (loaded.header.erased ?? []).filter((r) => r.from <= cut);
  return {
    ok: true,
    seed: {
      origin,
      events: prefix,
      ...(presetId ? { presetId } : {}),
      ...(inheritedErased.length > 0 ? { erased: inheritedErased } : {}),
    },
  };
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
  const { origin, events, presetId, erased } = prepared.seed;

  const scanned = await scanMaxSessionId(projectPath);
  // 发号前对账（B·2026-09-21）：账把「已发出、盘上却已不存在」的号段接住——撞号即
  // 原子替换写覆写既有卷，所以地板必须先抬到位（原「宁可多发一号也不赌」由账兜底）。
  await reconcileVolumeIssueFloor(ctx, projectPath, scanned);
  const sess = getChatStore(ctx.storeId).sess.getState();
  const id = sess.nextSessionId;
  sess.setNextSessionId(id + 1);
  // 发出即记账（B）：与起卷同源（await 落盘的取舍见 chat-session.noteVolumeIssued 注）。
  await noteVolumeIssued(projectPath, id);

  const header: SessionLogHeader = {
    type: 'session',
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    ...(presetId ? { presetId } : {}),
    cwd: projectPath,
    parent: origin,
    ...(erased ? { erased } : {}),
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

// ═══════════════════════════════════════════════════════════════
// 删除连坐（P2，plan §8/§9：删父卷 = 删整棵子树）
//
// 用户裁定（§9）：会话分支**真的会导致无父会话堆积**，分不清哪个从哪来 ⇒ 应用内删除
// 一律连坐整棵子树。三条硬规（§8）：
//   ① **按磁盘真源重建血缘图**：目录枚举定卷集 + 逐卷读头行定边——`_index.json` 只是
//      投影（可陈旧），不可逆动作不信它；
//   ② **后序遍历删（先子后父）**：任何中断点剩下的都还是合法森林，**永不产生孤儿**；
//   ③ **部分失败逐卷可见**：不静默、不假装成功。
// 边归一化复用 `resolveBranchOrigin`（同一条规则——不归一化会删错子树）。
// ═══════════════════════════════════════════════════════════════

/** 血缘图（会话树「枝」的边集，**归一化后**）。 */
export interface BranchLineage {
  /** 子 → 父（根卷/悬空 = null）。 */
  parentOf: Map<number, number | null>;
  /** 父 → 子（子树枚举用）。 */
  childrenOf: Map<number, number[]>;
}

/** 血缘图重建的读并发（每卷 = 一次整份日志读——seam 无「只读头行」动作）。 */
const LINEAGE_READ_CONCURRENCY = 8;

/**
 * **按磁盘真源重建血缘图**（硬规①）：目录枚举定卷集（文件不在 = 卷不存在），
 * 逐卷读**头行**定边，边一律**归一化**（`resolveBranchOrigin` 同一规则）。
 *
 * 读不出来的卷按**根卷**处理：它的边不可知，就不认它属于谁（悬空血缘不阻塞删除——
 * 与侧栏「父卷已删」同一语义）。
 *
 * 成本诚实说：一次删除 = 每卷一次整份日志读（`read_log` 没有只读头行的形态），
 * 几百卷的工作区要几秒——这是「不可逆动作按真源重建」的价钱，用**可见的等待**
 * （调用方在确认前给出进度提示）换正确性。
 */
export async function loadBranchLineage(root: string, ids: readonly number[]): Promise<BranchLineage> {
  const parentOf = new Map<number, number | null>();
  const childrenOf = new Map<number, number[]>();
  for (const id of ids) {
    parentOf.set(id, null);
    childrenOf.set(id, []);
  }
  // 逐卷头行（有界并发）：读到的边进表，`readEdge` 据此零 I/O 上溯
  const edges = new Map<number, SessionLogParentRef | undefined>();
  const present = new Set(ids);
  const queue = [...ids];
  const worker = async (): Promise<void> => {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      let parent: SessionLogParentRef | undefined;
      try {
        parent = (await loadSessionLogFile(root, id))?.header.parent;
      } catch (e) {
        // 读不出来 = 边不可知（按根卷处理，可见化）
        log.warn('chat', `血缘图：案卷 ${id} 头行读不出来（按根卷处理）`, { error: String(e) });
      }
      edges.set(id, parent);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINEAGE_READ_CONCURRENCY, queue.length) }, worker));

  const readEdge: ParentEdgeReader = async (id) =>
    present.has(id) ? (edges.get(id) ? { parent: edges.get(id) } : {}) : null;
  for (const id of ids) {
    const up = edges.get(id);
    if (!up) continue;
    const origin = await resolveBranchOrigin(root, id, up.atSeq, readEdge);
    // 归到自己的卷（= 无有效父）/ 归到卷集外的卷（父已被外部删掉）= 根卷
    if (!origin || origin.id === id || !present.has(origin.id)) continue;
    parentOf.set(id, origin.id);
    childrenOf.get(origin.id)?.push(id);
  }
  return { parentOf, childrenOf };
}

/** 连坐子树（**后序**：先子后父）——硬规②：任何中断点剩下的都还是合法森林。 */
export function branchSubtree(lineage: BranchLineage, id: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const walk = (n: number): void => {
    if (seen.has(n)) return; // 环守卫（坏血缘不递归、不吞卷）
    seen.add(n);
    for (const child of lineage.childrenOf.get(n) ?? []) walk(child);
    out.push(n);
  };
  walk(id);
  return out;
}

/** 连坐删除的准备面（只读）：确认文案的枝数 + 运行中拦截名单 + 后序删除序。 */
export interface CascadePlan {
  /** 选中的卷（原样）。 */
  roots: number[];
  /** 可删的卷（**后序**、去重——先子后父）。 */
  order: number[];
  /** 被拦下的选择卷：其子树里有运行中的卷（整体不删，逐卷列出）。 */
  blocked: Array<{ id: number; running: number[] }>;
  /** 除选择卷之外的枝数（确认文案「将同时删除 N 枝」）。 */
  branchCount: number;
}

/** 连坐删除结果（**逐卷可见**——硬规③：部分失败不静默）。 */
export interface CascadeOutcome {
  /** 已删卷（后序序）。 */
  deleted: number[];
  /** 删除失败的卷（卷号 + 原因）——成功删掉的卷不回滚（后序已保证剩下的是合法森林）。 */
  failed: Array<{ id: number; reason: string }>;
  /** 被运行中拦下的**选择卷**（其子树里有运行中的卷）：整体不删，逐卷列出（§9）。 */
  blocked: Array<{ id: number; running: number[] }>;
}

/** 运行中判定（与侧栏/书脊/退出守卫同一真源：运行态唯一读面，v43）。 */
function isRunning(storeId: string, sid: number): boolean {
  return agentSessionState.runStateOf(storeId, sid).running;
}

/**
 * 连坐删除的准备（只读、磁盘真源）：子树里有运行中的卷 ⇒ 该选择卷**整体不删**
 * （plan §9：「运行中拒绝」扩到整棵子树——不可半途 dispose 别人正在跑的卷）。
 */
export async function planBranchDelete(
  storeId: string,
  projectPath: string,
  ids: readonly number[],
): Promise<CascadePlan> {
  const lineage = await loadBranchLineage(workspaceSessionsDir(projectPath), await listVolumeIds(projectPath));
  const order: number[] = [];
  const taken = new Set<number>();
  const blocked: Array<{ id: number; running: number[] }> = [];
  let branchCount = 0;
  for (const root of ids) {
    const subtree = branchSubtree(lineage, root);
    const running = subtree.filter((sid) => isRunning(storeId, sid));
    if (running.length > 0) {
      blocked.push({ id: root, running });
      continue;
    }
    for (const sid of subtree) {
      if (taken.has(sid)) continue; // 选择卷之间有父子关系时去重
      taken.add(sid);
      order.push(sid);
    }
    branchCount += subtree.length - 1;
  }
  return { roots: [...ids], order, blocked, branchCount };
}

/**
 * **连坐删除**：先按真源出计划（准备面），再**后序**逐卷删。
 *
 * 逐卷删由**调用层注入**（`removeOne`）——app 层不持有 UI 编排面（`SessionContext`），
 * 产品侧的注入实现 = `ChatCore.deleteSessionFile`（既有单卷删除入口：真删日志 + 缓存、
 * 摘清单行、标记画布、关标签页），故连坐删除与单卷删除的**副作用面完全一致**；
 * 失败**逐卷**回报（硬规③），成功删掉的卷不回滚——后序已保证剩下的还是合法森林。
 *
 * 被运行中拦下的**选择卷**不参与删除，随 `blocked` 回报（单卷调用方据此整体拒绝并
 * 列出；批量调用方据此跳过并报数——旧行为「运行中跳过」不变，只是判定扩到子树）。
 */
export async function deleteBranchSubtrees(
  storeId: string,
  projectPath: string,
  ids: readonly number[],
  removeOne: (sid: number) => Promise<SessionDeleteResult>,
): Promise<CascadeOutcome> {
  const plan = await planBranchDelete(storeId, projectPath, ids);
  const deleted: number[] = [];
  const failed: Array<{ id: number; reason: string }> = [];
  for (const sid of plan.order) {
    try {
      const res = await removeOne(sid);
      if (res.ok) deleted.push(sid);
      else failed.push({ id: sid, reason: res.reason });
    } catch (e) {
      failed.push({ id: sid, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { deleted, failed, blocked: plan.blocked };
}
