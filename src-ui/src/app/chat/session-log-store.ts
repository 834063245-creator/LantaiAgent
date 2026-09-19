// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话事件日志落盘（Phase 1：写面 + 最小加载器）——把内存里的 `SessionLog` 接到
// `{workspace}/.lantai/sessions/{id}.ndjson` 上（DSH 参照：事件日志即真相的写半边）。
//
// 为什么不是快照：卷快照是全量重写（本机 1–2.27MB/次），于是「落盘」只能是轮末的
// 偶然时机，丢就丢一整轮（事故见 docs/session-persistence-audit.md）。事件日志是
// 增量 append（一条事件几十字节~几 KB）+ fsync，于是「落盘」可以挂在每个语义时刻
// （模型请求前 / 工具副作用前 / step 前）——这正是 DSH 的检查点策略
// （`packages/session/session-checkpoint-policy`）的全部前提。
//
// 文件形状（每卷一个，扁平落点——用户拍板 2026-09-15）：
//   {root}/{id}.ndjson
//   第 1 行  头行：{"type":"session","version":1,"id":…,"createdAt":…,"presetId":…,"cwd":…}
//   第 2..n 行 事件：{"seq":1,"ts":…,"kind":"user/message","data":{…}}
// 头行**不带卷名**（2026-09-18 命名收口）：头行只在 materialize 那一次写、改名永不
// 回写 ⇒ 带 label 就是一份只会陈旧的副本（真源 = 卷快照 `<id>.json` 的 label）。
//
// 两种接入姿态（DSH `appendBatch(…, isMaterialized)` 契约的兰台形）：
//   · **materialize**（文件不存在/不可读）：首批把「头行 + 当时日志全部事件」一次原子
//     写盘（走 fs_cap write 的 tmp→rename 原子替换），此后纯 append；
//   · **continue**（文件已有本卷事件，加载器已把日志置回磁盘真源）：直接 append，
//     首批不写头行（头行已在那份文件里）。
//
// Phase 1 的加载器是**最小形态**：只认完整行、遇坏行/断号即停（warn 可见），
// Phase 2（恢复链）已接：断尾截断 + 悬空工具调用补结果 + 格式版本定向拒读。
// 权威翻转（内容从日志派生、快照降级为带 seq 的投影缓存）归 Phase 3。

import { log } from '../../agent/logger';
import type { SessionEvent, SessionLog } from '../../agent/session-log';
import { interruptedToolCallClosers } from '../../agent/session-log-repair';
import { DEFAULT_WRITE_BATCH_MAX_DELAY_MS, SessionLogWriteBehind } from '../../agent/session-log-write-behind';
import { sessionExecute } from '../../composition/session-persistence-service';

/** 父卷引用 = 会话树的一条**边**（血缘）。 */
export interface SessionLogParentRef {
  /** 父卷号（**归一化后**的那一卷——见 `SessionLogHeader.parent` 注）。 */
  id: number;
  /** 从父卷继承到的**最后一个事件 seq**（= 前缀长度 = 切点）。 */
  atSeq: number;
}

/** 事件日志头行（第 1 行）。`version` 是格式版本——未来版本拒绝读而不是报损坏。
 *  不带卷名：头行 write-once，改名的事实在卷快照里（见文件头注）。 */
export interface SessionLogHeader {
  type: 'session';
  version: 1;
  id: number;
  createdAt: string;
  presetId?: string;
  cwd?: string;
  /** **卷间血缘（会话树「枝」，2026-09-18）**：本卷从哪一卷的哪个切点分出。
   *  `atSeq` = 继承到的最后一个事件 seq ⇒ 本卷自己的事件自 `atSeq + 1` 起；
   *  前缀（seq ≤ atSeq）是父卷事件的**复制**（自包含：读不依赖父卷在场）。
   *  write-once（随头行物化写一次，改名不回写）；缺字段 = 根卷（无父）。
   *  **刻意不升 `version`**：可选字段是加法而非格式断裂，而升版会把现有**全部**
   *  卷判成「本版本读不了」（版本硬判见 `loadSessionLogFile`），代价与收益不成比例。
   *  边一律**归一化**过（归到「自己的区域覆盖切点的那个卷」）——不归一化会画错树，
   *  且删除连坐会删错子树；实现见 `app/chat/session-branch.resolveBranchOrigin`。 */
  parent?: SessionLogParentRef;
}

/** 血缘字段的形状判据（读路径容忍毒化——形状不对当无父，见 `parseHeader`）。 */
export function isSessionLogParentRef(value: unknown): value is SessionLogParentRef {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { id?: unknown; atSeq?: unknown };
  return Number.isInteger(v.id) && (v.id as number) > 0 && Number.isInteger(v.atSeq) && (v.atSeq as number) >= 0;
}

/** 磁盘上的一卷事件日志（头行 + 已认领的连续前缀）。 */
export interface LoadedSessionLog {
  header: SessionLogHeader;
  events: SessionEvent[];
  /** 认领到的完整行字节数（断尾修复的截断点）。 */
  committedBytes: number;
  /** 停止认领的原因（null = 整个文件干净读完）。 */
  stopReason: string | null;
  /** 断尾（末行不完整）——true 时打开路径先截断再续写。 */
  torn: boolean;
}

/** 日志格式版本本 build 读不了（**不是损坏**——定向拒读，绝不覆写）。 */
export class SessionLogFormatUnsupportedError extends Error {
  constructor(
    message: string,
    readonly location: { path: string; version: number },
  ) {
    super(message);
    this.name = 'SessionLogFormatUnsupportedError';
  }
}

/** 本 build 支持的日志格式版本。 */
export const SESSION_LOG_FORMAT_VERSION = 1;

/** 定向拒读文案（DSH `sessionFormatVersionRefusal` 的兰台形）。 */
export function sessionLogVersionRefusal(id: number, version: number, path: string): string {
  return version > SESSION_LOG_FORMAT_VERSION
    ? `案卷 ${id} 的事件日志是 v${version} 格式，本版本只读 v${SESSION_LOG_FORMAT_VERSION}——日志由更新的兰台写入，请升级兰台后打开（原始日志：${path}）`
    : `案卷 ${id} 的事件日志是 v${version} 格式，早于本版本支持的 v${SESSION_LOG_FORMAT_VERSION}，本版本不含升级路径（原始日志：${path}）`;
}

export interface AttachSessionLogStoreOptions {
  /** 会话根目录（`{workspace}/.lantai/sessions`——唯一权威拼接收敛在调用方）。 */
  root: string;
  /** 卷号（文件名主体）。 */
  sessionId: number;
  /** 头行内容（materialize 姿态才写）。 */
  header: SessionLogHeader;
  /** continue = 文件已有本卷事件且日志已置回真源（不写头行、不物化）。 */
  adopt?: 'materialize' | 'continue';
  /** 批量窗口（缺省 200ms，与 DSH 同值）。 */
  maxDelayMs?: number;
}

/** 一条卷的事件日志写面（每个 SessionLog 实例至多一个）。 */
export interface SessionLogStore {
  readonly sessionId: number;
  readonly root: string;
  /** 本卷的**头行**（write-once：物化写一次，改名不回写）——attach 时带入内存。
   *  读面零 I/O 的用途 = **血缘**（`header.parent`，会话树「枝」的画布承接面：
   *  枝卷卷首要拉一丝引线到父卷的那个节点，见 `app/chat/session-branch.branchOriginOf`）。 */
  readonly header: SessionLogHeader;
  /** 静默点：排空队列（检查点/退出收尾）。 */
  flush(): Promise<void>;
  /** 是否还有待写事件或在途写。 */
  hasWork(): boolean;
  /** 已落盘批次数与事件数（观测面）。 */
  stats(): { batches: number; events: number; failures: number };
}

/** 注册表：SessionLog 实例 → 写面（WeakMap——日志随 Agent 消亡，不留强引用）。 */
const _stores = new WeakMap<SessionLog, SessionLogStore>();

/** 当前在册写面（退出收尾排空全部——WeakMap 不可枚举，另存一份强引用表）。 */
const _live = new Set<SessionLogStore>();

/** 事件日志文件路径（唯一拼接点——消费方（store/加载器）一律经本函数）。 */
export function sessionLogPath(root: string, id: number): string {
  return `${root}/${id}.ndjson`;
}

/**
 * 读一卷事件日志（最小加载器）：头行 + 完整行的连续事件前缀。
 * 缺文件返回 null；坏行/断号/缺头行 → 停止认领并记可见 warn（Phase 2 会截断修复）。
 * **只认换行结尾的完整行**（与 DSH `SessionLogScanner` 同纪律）：崩溃留下的半截
 * 记录不算事件。
 */
export async function loadSessionLogFile(root: string, id: number): Promise<LoadedSessionLog | null> {
  const path = sessionLogPath(root, id);
  let raw: string;
  try {
    raw = await sessionExecute('read_log', { root, id: String(id) });
  } catch (e) {
    log.warn('session-log', `事件日志读取失败（按无日志处理）：${path}`, { error: String(e) });
    return null;
  }
  if (!raw) return null;
  // 只认完整行：最后一行没有换行 = 断尾（不认领，等修复截断）
  const lines = raw.split('\n');
  const tail = lines.pop();
  const torn = tail !== undefined && tail.length > 0;
  const rawHeader = lines.length > 0 ? parseHeaderRaw(lines[0]) : null;
  if (!rawHeader) {
    return {
      header: { type: 'session', version: 1, id, createdAt: new Date().toISOString() },
      events: [],
      committedBytes: 0,
      stopReason: '头行缺失或不可解析',
      torn: false,
    };
  }
  // 格式版本拒读必须在**任何结构校验之前**（未来格式不必满足本 build 的形状；
  // 用户要看到「升级兰台」，而不是「日志损坏」——DSH 同款纪律）。
  if (typeof rawHeader.version === 'number' && rawHeader.version !== SESSION_LOG_FORMAT_VERSION) {
    throw new SessionLogFormatUnsupportedError(sessionLogVersionRefusal(id, rawHeader.version, path), {
      path,
      version: rawHeader.version,
    });
  }
  const header = parseHeader(lines[0]);
  if (!header) {
    return {
      header: { type: 'session', version: 1, id, createdAt: new Date().toISOString() },
      events: [],
      committedBytes: 0,
      stopReason: '头行形状非法',
      torn: false,
    };
  }
  let committedBytes = utf8Len(`${lines[0]}\n`);
  const events: SessionEvent[] = [];
  let stopReason: string | null = torn ? `断尾：末行不完整（${utf8Len(tail)}\n 字节）` : null;
  for (let i = 1; i < lines.length; i++) {
    let ev: SessionEvent;
    try {
      ev = JSON.parse(lines[i]) as SessionEvent;
    } catch {
      stopReason = `第 ${i + 1} 行不可解析`;
      break;
    }
    if (typeof ev?.seq !== 'number' || ev.seq !== events.length + 1) {
      stopReason = `第 ${i + 1} 行序号断裂（期望 ${events.length + 1}，得到 ${String(ev?.seq)}）`;
      break;
    }
    events.push(ev);
    committedBytes += utf8Len(`${lines[i]}\n`);
  }
  if (stopReason) {
    log.warn('session-log', `事件日志未完整认领（打开时截断修复）：${path}`, {
      reason: stopReason,
      claimed: events.length,
      committedBytes,
    });
  }
  return { header, events, committedBytes, stopReason, torn };
}

/** UTF-8 字节长度（断尾修复的截断点按字节；浏览器无 Buffer，走 TextEncoder）。 */
function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 头行的宽松解析（只取 version——版本判定要先于形状校验）。 */
function parseHeaderRaw(line: string): { version?: unknown } | null {
  try {
    const parsed = JSON.parse(line) as { type?: string; version?: unknown };
    return parsed?.type === 'session' ? parsed : null;
  } catch {
    return null;
  }
}

function parseHeader(line: string): SessionLogHeader | null {
  try {
    const parsed = JSON.parse(line) as SessionLogHeader & { type?: string };
    if (parsed?.type !== 'session') return null;
    if (typeof parsed.id !== 'number') return null;
    // 毒化容忍（INVARIANTS #11 读路径纪律）：血缘形状不对 = 当无父（根卷）——
    // 不让一条脏字段把整卷判成损坏（「文件在、内容在」比「血缘完整」重要）。
    if (parsed.parent !== undefined && !isSessionLogParentRef(parsed.parent)) delete parsed.parent;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 只读一卷的事件日志（不经 Agent、不写盘）——**权威翻转后的卷内容真源**（Phase 3b）。
 *
 * 扫描 → 补悬空工具调用（同 Phase 2 判据，但**不落盘**：盘点/列表面只读）→
 * `SessionLog.replay` → `deriveMessages()`。缺日志/无事件返回 null（= 卷不存在）。
 */
export async function readVolumeLogMessages(
  root: string,
  id: number,
): Promise<{
  messages: import('../../provider/types').Message[];
  lastSeq: number;
  header: SessionLogHeader;
} | null> {
  const loaded = await loadSessionLogFile(root, id);
  if (!loaded || loaded.events.length === 0) return null;
  const { SessionLog } = await import('../../agent/session-log');
  const closers = interruptedToolCallClosers(loaded.events);
  const log = SessionLog.replay(closers.length > 0 ? [...loaded.events, ...closers] : loaded.events);
  return { messages: log.deriveMessages(), lastSeq: log.lastSeq, header: loaded.header };
}

/**
 * 把一条会话日志接到盘上：订阅 `onEvent` → 写后队列 → durable append。
 * 幂等：同一 SessionLog 重复 attach 返回既有写面（不重复订阅、不并发两个队列）。
 */
export function attachSessionLogStore(logInstance: SessionLog, opts: AttachSessionLogStoreOptions): SessionLogStore {
  const existing = _stores.get(logInstance);
  if (existing) return existing;

  const target = sessionLogPath(opts.root, opts.sessionId);
  let materialized = opts.adopt === 'continue'; // continue 姿态：头行已在盘上
  let batches = 0;
  let events = 0;
  let failures = 0;

  const sink = async (batch: readonly SessionEvent[]): Promise<void> => {
    if (batch.length === 0) return;
    if (materialized) {
      const body = `${batch.map((e) => JSON.stringify(e)).join('\n')}\n`;
      await sessionExecute('append_events', {
        root: opts.root,
        id: String(opts.sessionId),
        data: body,
      });
      events += batch.length;
      batches += 1;
      return;
    }
    // 首批 = 物化：头行 + **本批次末尾为止的全部事件**（构造期事件不会丢）。
    // ⚠ 切点必须按 batch 末条的 seq 截断，而不是「写入时刻 log.events() 全量」——
    // batch 是 splice 出来的，其后新入队的事件仍在 pending 里等下一次 append；
    // 若这里把 log.events() 全量写出去，那些事件会被物化一次 + append 一次
    // （同一 seq 落盘两遍 = 重放面判损坏；实测由本文件测试抓到）。
    // 整体替换写（tmp→rename 原子），崩溃不会留下「已物化但空」的会话。
    const lastSeq = batch.at(-1)?.seq ?? 0;
    const prefix = logInstance.events().filter((e) => e.seq <= lastSeq);
    const payload = `${JSON.stringify(opts.header)}\n${prefix.map((e) => JSON.stringify(e)).join('\n')}\n`;
    await sessionExecute('write_log', {
      root: opts.root,
      id: String(opts.sessionId),
      data: payload,
    });
    materialized = true;
    events += prefix.length;
    batches += 1;
  };

  const queue = new SessionLogWriteBehind({
    maxDelayMs: opts.maxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    write: sink,
    reportBackgroundFailure: (error) => {
      failures += 1;
      // 可见化（CONVENTIONS §1.7：写入类错误不得静默）——批次已回灌，下个检查点重试
      log.warn('session-log', `会话事件日志落盘失败（已保留待重试）：${target}`, { error: String(error) });
    },
  });

  logInstance.onEvent((ev) => {
    queue.enqueue(ev);
  });

  const store: SessionLogStore = {
    sessionId: opts.sessionId,
    root: opts.root,
    header: opts.header,
    flush: () => queue.flush(),
    hasWork: () => queue.hasWork,
    stats: () => ({ batches, events, failures }),
  };
  // 落盘面接上日志（agent 层的检查点问日志要屏障——见 SessionLog.flushPersistence）
  logInstance.setPersistenceSink(store);
  _stores.set(logInstance, store);
  _live.add(store);
  return store;
}

/** 取某条日志的写面（未 attach = null）。 */
export function sessionLogStoreOf(logInstance: SessionLog): SessionLogStore | null {
  return _stores.get(logInstance) ?? null;
}

/**
 * **切点 seq → 投影消息条数**（最后一个「来源 seq ≤ 切点」的投影下标 + 1；无日志/无命中 = 0）。
 *
 * ⚠ **不假设锚点单调**：`adopt`（开卷重设头部 system 提示）给头条消息的锚点是**那条
 * adopt 事件的 seq**（比尾部历史的锚点都大，见 `agent/session-log` 的 adopt 分支），
 * 故只能**全扫取最后一个命中**——遇大即断会在开过卷的卷上直接落空（P3 实测）。
 */
export function inheritedCountAt(logInstance: SessionLog | null | undefined, atSeq: number): number {
  if (!logInstance) return 0;
  const anchors = logInstance.deriveMessageAnchors();
  let k = -1;
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i] <= atSeq) k = i;
  }
  return k + 1;
}

/**
 * **本卷的继承前缀长度**（投影消息条数）：头行 `parent.atSeq` 的切点 → 见 `inheritedCountAt`。
 * 非枝卷 / 无父 / 无日志 = 0（整卷都是它自己的）。
 *
 * 用途：**给未命名卷起名**（首条来文派生）——枝卷的前缀是父卷的复制，拿它派生卷名 =
 * 子卷顶着父卷的名（2026-09-18 真机验收报的「卷名乱套」）。枝边的父卷落点用
 * `inheritedCountAt`（那个切点是**别的卷**的，不是本卷头行里的）。
 */
export function inheritedMessageCount(logInstance: SessionLog | null | undefined): number {
  if (!logInstance) return 0;
  const atSeq = sessionLogStoreOf(logInstance)?.header.parent?.atSeq;
  return atSeq == null ? 0 : inheritedCountAt(logInstance, atSeq);
}

/** 静默点：排空一条日志的队列（未 attach = no-op）。检查点与退出收尾共用。 */
export async function flushSessionLog(logInstance: SessionLog | null | undefined): Promise<void> {
  if (!logInstance) return;
  const store = _stores.get(logInstance);
  if (!store) return;
  await store.flush();
}

/** 排空全部在册队列（退出收尾：一条 flush 覆盖所有卷，成本 = 未落盘增量）。 */
export async function flushAllSessionLogs(): Promise<{ flushed: number; failed: number }> {
  const all = [..._live];
  const results = await Promise.allSettled(all.map((s) => s.flush()));
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    log.error('session-log', `退出排空会话事件日志失败：${failed}/${all.length} 卷`, {
      reasons: results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason)),
    });
  }
  return { flushed: all.length - failed, failed };
}

/** 摘除一条日志的写面（先排空；签卷销毁/切卷时调用）。 */
export async function detachSessionLogStore(logInstance: SessionLog): Promise<void> {
  const store = _stores.get(logInstance);
  if (!store) return;
  try {
    await store.flush();
  } catch (e) {
    log.warn('session-log', `会话事件日志摘除前排空失败（案卷 ${store.sessionId}）`, { error: String(e) });
  }
  logInstance.setPersistenceSink(null);
  _stores.delete(logInstance);
  _live.delete(store);
}

/**
 * 打开一卷：读盘 → **截断修复断尾** → 置回真源 → **补悬空工具调用** → 接到盘上。
 *
 * 情形（与 DSH `prepare()` + `commitRepair()` 同链）：
 *   · 文件有事件 → 若断尾/坏行：先 `truncate_log(committedBytes)`（丢弃半截记录，
 *     否则后续 append 会接在垃圾后面、扫描器永远认不回尾巴）；然后
 *     `restoreInPlace` + `continue` 姿态；再补悬空工具调用的 `tool/result`
 *     （两种语义文案见 `agent/session-log-repair`）并立刻排空——**修复本身是
 *     持久化的**，不是内存态调整；
 *   · 无文件/坏头行 → `materialize`（首批把当前日志整体物化，含构造期事件）；
 *   · 版本本 build 读不了 → **抛**（定向拒读，绝不覆写——见
 *     `SessionLogFormatUnsupportedError`）；
 *   · 句柄无日志能力位（旧实现/测试桩）→ no-op。
 *
 * 失败语义：除版本拒读外，任何读/修失败都降级为「日志从本轮重开」（可见 warn）——
 * 不因日志问题挡用户打开会话。
 */
export async function openSessionLog(
  logInstance: SessionLog | null | undefined,
  opts: AttachSessionLogStoreOptions,
): Promise<{ adopted: boolean; events: number; repaired: boolean; closers: number }> {
  if (!logInstance) return { adopted: false, events: 0, repaired: false, closers: 0 };
  const path = sessionLogPath(opts.root, opts.sessionId);
  const loaded = await loadSessionLogFile(opts.root, opts.sessionId);
  if (loaded && loaded.events.length > 0) {
    try {
      // ① 断尾/坏行 → 截断到已认领的完整前缀（DSH `commitRepair` 的第一半）
      let repaired = false;
      if (loaded.stopReason !== null && loaded.committedBytes > 0) {
        await sessionExecute('truncate_log', {
          root: opts.root,
          id: String(opts.sessionId),
          offset: loaded.committedBytes,
        });
        repaired = true;
        log.warn('session-log', `事件日志断尾已截断修复：${path}`, {
          reason: loaded.stopReason,
          keptEvents: loaded.events.length,
        });
      }
      // ② 置回磁盘真源 + 续写姿态
      // 头行取**盘上那一份**（不是调用方现造的出生头）：血缘（`parent`）只写在
      // 文件头行里，续开时调用方的 header 是新的出生记录、没有它——带错了，
      // 画布上枝卷就找不到父卷（见 SessionLogStore.header 注）。
      logInstance.restoreInPlace(loaded.events);
      const store = attachSessionLogStore(logInstance, { ...opts, header: loaded.header, adopt: 'continue' });
      // ③ 补悬空工具调用（崩溃时「宣布了但没结果」的调用）并立刻持久化
      const closers = interruptedToolCallClosers(loaded.events);
      if (closers.length > 0) {
        for (const closer of closers) logInstance.appendEvent(closer);
        await store.flush();
        log.warn('session-log', `崩溃恢复：已为 ${closers.length} 条悬空工具调用补结果：${path}`, {
          calls: closers.map((c) => (c.data as { message: { name?: string } }).message.name ?? '?'),
        });
      }
      return { adopted: true, events: loaded.events.length, repaired, closers: closers.length };
    } catch (e) {
      // 基线不可用（seq 断裂等）→ 落到 materialize（重开一段），响亮记警告
      if (e instanceof SessionLogFormatUnsupportedError) throw e;
      log.warn('session-log', `事件日志基线不可用，改为重新物化：${path}`, { error: String(e) });
    }
  }
  attachSessionLogStore(logInstance, { ...opts, adopt: 'materialize' });
  return { adopted: false, events: 0, repaired: false, closers: 0 };
}
