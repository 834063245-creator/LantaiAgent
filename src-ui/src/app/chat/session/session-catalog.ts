// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷目录投影（清单缓存）+ 每卷写链 + 落盘结果账
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import { log } from '../../../agent/logger';
import { sessionExecute } from '../../../composition/session-persistence-service';
import { bumpSessionVolumes } from '../../../state/session-volumes-store';
import { resetIssueLedgersForTests } from './session-paths';
import { readVolumeData } from './session-read';
import { resetVolumeGuardForTests } from './session-volume-guard';

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

export function enqueueVolumeWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
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

export function catalogOf(root: string): VolumeCatalog {
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
export function flushCatalog(cat: VolumeCatalog, root: string): void {
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
export function loadCatalog(cat: VolumeCatalog, root: string): Promise<void> {
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
export async function buildMissingRows(
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
export function upsertCatalogRow(root: string, row: SavedSessionRow): void {
  const cat = catalogOf(root);
  const prev = cat.rows.get(row.id);
  if (!prev) return;
  cat.rows.set(row.id, { ...row, ...(prev.parentId != null ? { parentId: prev.parentId } : {}) });
  cat.failed.delete(row.id);
  flushCatalog(cat, root);
}

/** 写面就地摘行（真删 / 写失败后状态未知——下次清点按需补建）。 */
export function dropCatalogRow(root: string, id: number): void {
  const cat = catalogOf(root);
  if (!cat.rows.delete(id)) return;
  flushCatalog(cat, root);
}

/** 卷清单行由快照派生（写面就地更行的唯一形状来源——与补建同口径：
 *  块数 = 非 system 消息数）。快照无 messages（只改元数据的写）= 无行可更
 *  （调用方退回摘行——下次清点补建，不猜块数）。 */
export function rowFromSnapshot(data: {
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
 *  由各用例的 mock 盘自理）。已删卷写拒绝名单与发号账同属模块级态，一并清。 */
export function resetSessionListCacheForTests(): void {
  _volumeCatalogs.clear();
  resetVolumeGuardForTests();
  resetIssueLedgersForTests();
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
export function warnSaveAnomaly(key: string, msg: string): void {
  if (_warnedSaveSkips.has(key)) return;
  _warnedSaveSkips.add(key);
  console.warn(msg);
  log.warn('chat', msg);
}
