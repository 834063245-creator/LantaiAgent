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
//   第 1 行  头行：{"type":"session","version":1,"id":…,"createdAt":…,"label":…,"presetId":…,"cwd":…}
//   第 2..n 行 事件：{"seq":1,"ts":…,"kind":"user/message","data":{…}}
//
// 两种接入姿态（DSH `appendBatch(…, isMaterialized)` 契约的兰台形）：
//   · **materialize**（文件不存在/不可读）：首批把「头行 + 当时日志全部事件」一次原子
//     写盘（走 fs_cap write 的 tmp→rename 原子替换），此后纯 append；
//   · **continue**（文件已有本卷事件，加载器已把日志置回磁盘真源）：直接 append，
//     首批不写头行（头行已在那份文件里）。
//
// Phase 1 的加载器是**最小形态**：只认完整行、遇坏行/断号即停（warn 可见），
// 断尾截断与合成 closers 归 Phase 2（见 docs/plans/session-persistence-dsh-port-plan.md）。

import { log } from '../../agent/logger';
import type { SessionEvent, SessionLog } from '../../agent/session-log';
import { DEFAULT_WRITE_BATCH_MAX_DELAY_MS, SessionLogWriteBehind } from '../../agent/session-log-write-behind';
import { sessionExecute } from '../../composition/session-persistence-service';

/** 事件日志头行（第 1 行）。`version` 是格式版本——未来版本拒绝读而不是报损坏。 */
export interface SessionLogHeader {
  type: 'session';
  version: 1;
  id: number;
  createdAt: string;
  label?: string;
  presetId?: string;
  cwd?: string;
}

/** 磁盘上的一卷事件日志（头行 + 已认领的连续前缀）。 */
export interface LoadedSessionLog {
  header: SessionLogHeader;
  events: SessionEvent[];
  /** 认领到的完整行字节数（Phase 2 断尾修复的截断点；Phase 1 只用于诊断）。 */
  committedLines: number;
  /** 停止认领的原因（null = 整个文件干净读完）。 */
  stopReason: string | null;
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
  let raw: string;
  try {
    raw = await sessionExecute('read_log', { root, id: String(id) });
  } catch (e) {
    log.warn('session-log', `事件日志读取失败（按无日志处理）：${sessionLogPath(root, id)}`, { error: String(e) });
    return null;
  }
  if (!raw) return null;
  // 只认完整行：最后一行没有换行 = 断尾（不认领）
  const lines = raw.split('\n');
  const tail = lines.pop();
  let committedLines = 0;
  const header = lines.length > 0 ? parseHeader(lines[0]) : null;
  if (!header) {
    return {
      header: { type: 'session', version: 1, id, createdAt: new Date().toISOString() },
      events: [],
      committedLines: 0,
      stopReason: '头行缺失或不可解析',
    };
  }
  committedLines = utf8Len(`${lines[0]}\n`);
  const events: SessionEvent[] = [];
  let stopReason: string | null = tail ? `断尾：末行不完整（${tail.length} 字节未认领）` : null;
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
    committedLines += utf8Len(`${lines[i]}\n`);
  }
  if (stopReason) {
    log.warn('session-log', `事件日志未完整认领（Phase 2 将做断尾修复）：${sessionLogPath(root, id)}`, {
      reason: stopReason,
      claimed: events.length,
    });
  }
  return { header, events, committedLines, stopReason };
}

/** UTF-8 字节长度（断尾修复的截断点按字节；浏览器无 Buffer，走 TextEncoder）。 */
function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

function parseHeader(line: string): SessionLogHeader | null {
  try {
    const parsed = JSON.parse(line) as SessionLogHeader & { type?: string };
    if (parsed?.type !== 'session') return null;
    if (typeof parsed.id !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
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
    flush: () => queue.flush(),
    hasWork: () => queue.hasWork,
    stats: () => ({ batches, events, failures }),
  };
  _stores.set(logInstance, store);
  _live.add(store);
  return store;
}

/** 取某条日志的写面（未 attach = null）。 */
export function sessionLogStoreOf(logInstance: SessionLog): SessionLogStore | null {
  return _stores.get(logInstance) ?? null;
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
  _stores.delete(logInstance);
  _live.delete(store);
}

/**
 * 打开一卷：读盘 → 把日志置回磁盘真源 → 接到盘上（Phase 1 接线的唯一入口）。
 *
 * 三种情形：
 *   · 文件有事件 → `restoreInPlace(events)` + `continue`（**不覆写**：崩溃时写下的
 *     尾巴必须活到下一次打开——Phase 2 的修复链据此续命）；
 *   · 无文件/坏头行 → `materialize`（首批把当前日志整体物化，含构造期事件）；
 *   · 句柄无日志能力位（旧实现/测试桩）→ no-op。
 *
 * 代际/失败语义：读盘失败按「无日志」处理（materialize），并已可见 warn——
 * 会话仍可打开（降级为「日志从本轮重开」），不因日志问题挡用户。
 */
export async function openSessionLog(
  logInstance: SessionLog | null | undefined,
  opts: AttachSessionLogStoreOptions,
): Promise<{ adopted: boolean; events: number }> {
  if (!logInstance) return { adopted: false, events: 0 };
  const loaded = await loadSessionLogFile(opts.root, opts.sessionId);
  if (loaded && loaded.events.length > 0) {
    try {
      logInstance.restoreInPlace(loaded.events);
      attachSessionLogStore(logInstance, { ...opts, adopt: 'continue' });
      return { adopted: true, events: loaded.events.length };
    } catch (e) {
      // 基线不可用（seq 断裂等）→ 落到 materialize（重开一段），响亮记警告
      log.warn('session-log', `事件日志基线不可用，改为重新物化：${sessionLogPath(opts.root, opts.sessionId)}`, {
        error: String(e),
      });
    }
  }
  attachSessionLogStore(logInstance, { ...opts, adopt: 'materialize' });
  return { adopted: false, events: 0 };
}
