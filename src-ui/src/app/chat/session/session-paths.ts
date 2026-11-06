// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工作区会话根 + 卷快照形状 + 发号账（_issue.json）
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import type { TokenLedgerSnapshot } from '../../../agent/token-meter/types';
import { sessionExecute } from '../../../composition/session-persistence-service';
import type { Message } from '../../../provider/types';
import type { ComposeSessionPrefs } from '../../../state/compose-store';
import { showToast, TOAST_LONG_HOLD_MS } from '../../../state/toast-store';
import { getChatStore } from '../../../ui/chat-store';
import type { ChatMessage } from '../../../ui/message-model';
import { getWorkspaceEpoch, isCurrentEpoch } from '../../../workspace-scope';
import type { SessionContext } from './session-types';

// ── 会话持久化 — 每个工作区一个会话根，每卷一个文件（{ws}/.lantai/sessions/）──

/** 会话文件的持久化形状（磁盘 JSON）。
 *  Stage-5 起不再含 paper（钉住块/纸条/流区位置已升格工作区级——
 *  随 {workspace}/.lantai/canvas.json，不再随卷快照）。
 *  workspace-session-ownership-rework：不再写 workspace 字段——存储位置即归属。 */
export interface StoredSession {
  id: number;
  label?: string;
  savedAt?: string;
  /** 立卷时刻（ISO）——**不落快照**，读面每次取自卷日志头行（`SessionLogHeader.createdAt`，
   *  卷本体真源）。列在此处仅供 `readVolumeData` 的返回值携带（2026-09-16 卷首档行）。 */
  createdAt?: string;
  /** **父卷号**（会话树「枝」的血缘，2026-09-18）——同样**不落快照**：真源 = 卷日志
   *  头行 `SessionLogHeader.parent.id`（write-once），此处仅供 `readVolumeData` 的返回值
   *  携带（清单投影 `_index.json` 的血缘栏由它供数）。缺 = 根卷。 */
  parentId?: number;
  messages?: Message[];
  /** UI 消息副本（WO-7）：含 BlockPart 资产块；旧存档无此字段 = 仅 provider 消息。 */
  uiMessages?: ChatMessage[];
  tokensUsed?: number;
  /** token 账本快照（2026-09-13）：分桶用量/逐轮/压力/构成。
   *  `tokensUsed` 是它的总量投影（旧字段，坞在无句柄时用）；旧存档无
   *  `tokens` = 账本从空开始（不迁移，不编造历史）。 */
  tokens?: TokenLedgerSnapshot;
  /** 会话级创作坞覆盖（方案甲 2026-08-27）：旧存档无此字段 = 无覆盖。 */
  compose?: ComposeSessionPrefs;
  /** 本卷创建时点生效的组合 id（P0 记录闭环，2026-09-14）。
   *  「模型可见 ⟺ 已记录」：组合决定模型看到哪些工具/段落，卷必须能自证。
   *  旧存档无此字段 = 未知（不猜、不编造；恢复期不校验）。 */
  presetId?: string;
  /** 投影缓存新鲜度（Phase 3b 权威翻转）：写这份快照时事件日志的 lastSeq。
   *  读面 `cache.seq >= 日志 lastSeq` 才算新鲜；陈旧 = 当没有这份快照（重建 UI 面）。 */
  seq?: number;
  /** 缓存格式版本（与事件日志 `version` 分开——缓存可随时丢弃重建）。 */
  ver?: number;
  /** _active.json 跟踪文件字段（与单个会话文件形状不同） */
  lastId?: number;
  nextId?: number;
}

// ── 工作区会话根（workspace-session-ownership-rework 2026-08-27）────────────
// 会话**物理归属工作区**：唯一存储位 = {workspace}/.lantai/sessions/{id}.json。
// 归属 = 存储位置，无需 workspace 字段标签/路径归一匹配；零目录会话已退役，
// projectPath 恒为真实目录，不存在第二存储位。
//
// seam 接线（session-persistence-seam-wiring-plan C 定案，2026-09-05）：
// 卷 CRUD 全链经 sessionExecute 四动作（read_volume/list_volumes/save_volume/
// delete_volume）——默认 provider builtin/rust-sessions 内部转发 kernel* helper，
// 行为与今日直连逐字节一致（测试 mock 面零迁移）；换 provider（SQLite/远程仓）
// 即整链换存储，产品代码零改动。root = 本工作区会话根（下方唯一权威拼接点）。

/** 工作区会话目录（唯一权威存储位——消费方（chat-session/chat-core）一律
 *  经本导出拼 root，路径构造收敛单点）。
 *  P0（2026-09-15 存盘审计 M8）：空路径此前拼出 `/.lantai/sessions`——相对
 *  进程 CWD 解析（`ui.log` 实证落到 `D:\.lantai\sessions` 并被安全闸拒绝）。
 *  改为响亮报错：调用方各自的 catch 决定可见等级（读侧降级为「无卷」、写侧
 *  走落盘失败可见面），不再静默拼出工作区外路径。 */
export function workspaceSessionsDir(projectPath: string): string {
  const base = projectPath.replace(/[\\/]+$/, '');
  if (!base) {
    throw new Error('workspaceSessionsDir: 工作区路径为空——无法定位会话根（拒绝拼出 CWD 相对路径）');
  }
  return `${base}/.lantai/sessions`;
}

/** 读卷：工作区目录单一路径。缺失/坏文件返回 null——卷不在本工作区
 *  会话目录 = 不存在（无回退面）。read_volume 缺卷返回 'null'（判空语义与
 *  旧 readSessionJSONOrNull catch 等价——错误不静默在消费方 catch 面）。 */
export async function readVolumeJSON(projectPath: string, id: number): Promise<StoredSession | null> {
  try {
    const raw = await sessionExecute('read_volume', {
      root: workspaceSessionsDir(projectPath),
      id: String(id),
    });
    if (raw === 'null') return null;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

/** 扫描本工作区会话目录，查找最大的数字会话 ID。无会话时返回 0。
 *  每工作区独立发号（workspace-session-ownership-rework 2026-08-27）——
 *  跨工作区撞号在结构上不可能（不同目录，天然隔离）。
 *  Phase 3b：**按 `.ndjson`（卷本体）认卷**；`.json` 只是投影缓存，不参与发号
 *  （否则缓存文件会让号段虚高或多算已删卷）。 */
export async function scanMaxSessionId(projectPath: string): Promise<number> {
  let maxId = 0;
  try {
    const root = workspaceSessionsDir(projectPath);
    const raw = await sessionExecute('list_volumes', { root });
    const names: unknown = JSON.parse(raw);
    if (!Array.isArray(names)) return maxId;
    for (const n of names) {
      const name = typeof n === 'string' ? n : '';
      if (!name || name.startsWith('_') || !name.endsWith('.ndjson')) continue;
      const sid = parseInt(name.replace(/\.ndjson$/, ''), 10);
      if (!Number.isNaN(sid) && sid > maxId) maxId = sid;
    }
  } catch {
    /* 目录缺席/读失败 = 空（首启常态） */
  }
  return maxId;
}

// ── 发号账（`{root}/_issue.json`，2026-09-21 卷号治理 B）────────────────────
//
// 病根：号 = 身份（落盘文件名主体 / 血缘 `parent` / 每卷账本键），而发号器只在内存
// （`session-store.nextSessionId`）——重启按「磁盘现存最大号 + 1」对账 ⇒ **删掉高位卷后
// 旧号会被重新发出**。复用正是「死卷冒充新卷」那一族事故的根（真机：三个子卷顶着 9/6
// 死卷的卷名，且不会自愈——见 docs/archive/session-line/session-tree-plan.md §12）。
//
// 治法：**号一经发出即记账**——账落盘、单调、只增不减 ⇒ 号永不复用。形状抄
// `_index.json`（下划线保留名 + 同一 seam `read_volume`/`save_volume`：零 Rust 变更、
// 零 RPC 契约变更、零文件格式版本升级），但**独立成文件**、不寄生卷目录：`_index` 是
// 可丢弃投影（版本不认即整份重建），单调事实不得住在会被重建的缓存里（单一权威源）。
//
// 与退役总目的关系：`_ledger.json` 里的 `nextSessionId` 正是这一栏
// （docs/archive/session-ledger-plan.md §56-76）；总目因**摊开集**用途退役（见下方
// saveActiveSession 注），发号这一半在本批补回、用途收窄到发号。
//
// 旧工作区不迁移：无账 = `next` 记 0，首次发号时写账；账丢失/被删 = 退回磁盘对账并
// warn（比今日不劣，不炸）。

/** 发号账 id（`{root}/_issue.json`）。卷集判定只认 `.ndjson` 且跳过 `_` 开头
 *  （`listVolumeIds` / `scanMaxSessionId`）⇒ 账文件对既有清点面天然隐形。 */
const ISSUE_LEDGER_ID = '_issue';
/** 账版本（不认即当账缺席：退回磁盘对账，不炸）。 */
const ISSUE_LEDGER_VERSION = 1;

/** 每工作区一本账（模块级可变态归属：**键控自清理**——键 = 会话根，与 `_volumeCatalogs`
 *  同族；不做跨工作区共享，INVARIANTS #1）。 */
interface IssueLedger {
  /** 下一个可发的号（**单调**：只增不减；0 = 账缺席/尚未发出过号）。 */
  next: number;
  /** 是否已读过盘（每根每进程一次）。 */
  loaded: boolean;
  loading: Promise<void> | null;
  /** 盘上账的版本本 build 读不了（**不是损坏**——定向拒读、**绝不覆写**，同卷日志
   *  格式的拒读纪律：降级运行不得把新版写的账抹掉）。此状态下不写账，号段退回
   *  磁盘对账（最坏 = 今日语义）。 */
  foreign: boolean;
}

const _issueLedgers = new Map<string, IssueLedger>();

/** 内存键归一：`D:\ws` 与 `D:/ws` 指向**同一份盘上账**，而 `workspaceSessionsDir`
 *  只剥尾分隔符、不转反斜杠（两条键会各持一份水位——审计 2026-09-21 §6 #12）。
 *  传给 seam 的仍是原路径（fs 层各自归一）。 */
function issueLedgerKey(root: string): string {
  return root.replace(/\\/g, '/');
}

function issueLedgerOf(root: string): IssueLedger {
  const key = issueLedgerKey(root);
  let led = _issueLedgers.get(key);
  if (!led) {
    led = { next: 0, loaded: false, loading: null, foreign: false };
    _issueLedgers.set(key, led);
  }
  return led;
}

/** 账载入（每根每进程一次）。坏档 / 版本不认 / 字段非法 ⇒ 当账缺席（`next = 0`）+ 可见
 *  warn——毒化容忍与卷目录同规：不让一份脏数据变成「每卷都发不出号」。 */
function loadIssueLedger(root: string): Promise<void> {
  const led = issueLedgerOf(root);
  if (led.loaded) return Promise.resolve();
  if (led.loading) return led.loading;
  led.loading = (async () => {
    try {
      const raw = await sessionExecute('read_volume', { root, id: ISSUE_LEDGER_ID });
      if (raw !== 'null') {
        const parsed = JSON.parse(raw) as { ver?: unknown; next?: unknown };
        if (parsed?.ver !== ISSUE_LEDGER_VERSION) {
          led.foreign = true;
          console.warn(
            `[chat] 发号账版本不认（${String(parsed?.ver)}）——按账缺席对账，且本 build 不覆写它` +
              '（号段退回磁盘对账；升级兰台后恢复）',
          );
        } else if (Number.isInteger(parsed.next) && (parsed.next as number) > 0) {
          led.next = parsed.next as number;
        }
      }
    } catch (e) {
      // 坏 JSON / 读失败：账缺席，不炸（号段退回磁盘对账）。可见化不静默。
      console.warn('[chat] 发号账读取失败（按账缺席处理）:', e);
    } finally {
      led.loaded = true;
      led.loading = null;
    }
  })();
  return led.loading;
}

/** **发号前对账**（三个入口共用：起卷 / 立枝 / 重启装配）：
 *  `next = max(内存下限, [磁盘最大号 + 1], 账 next)`——账把「已发出、盘上却已不存在」的
 *  号段接住（这就是「重启不回退」的全部机制）。**方括号项只在调用方已经扫过盘时参与**：
 *  装配（`autoRestoreLastSession`）与立枝本来就要扫，发号路径**不扫**（见函数内注）。
 *  在途切走工作区 ⇒ 丢弃（不抬旧区下限，同 H5 防护）。 */
export async function reconcileVolumeIssueFloor(
  ctx: SessionContext,
  projectPath: string,
  scannedMax?: number,
): Promise<void> {
  const epoch = getWorkspaceEpoch();
  const root = workspaceSessionsDir(projectPath);
  await loadIssueLedger(root);
  if (!isCurrentEpoch(epoch)) return;
  const memNext = getChatStore(ctx.storeId).sess.getState().nextSessionId;
  // 扫盘项只在调用方已扫时参与：发号是**同步占号**的热路径，起卷今天不读盘（盘上号由
  // 装配对账与开卷抬下限覆盖）——把目录枚举塞进发号会让既有语义漂移（2026-09-21 全量
  // 回归实测 9 例因它变红；收窄后零漂移）。账那一项则**每次都在场**：只有它知道
  // 「发出过、卷已删」的号。账读取每 root 每进程一次 ⇒ 第二次起发号零 I/O。
  const floor = scannedMax === undefined ? memNext : Math.max(memNext, scannedMax + 1);
  const next = Math.max(floor, issueLedgerOf(root).next);
  if (next !== memNext) getChatStore(ctx.storeId).sess.setState({ nextSessionId: next });
}

/** **记「号已发出」**（发号后半边，起卷与立枝同源）。**await 落盘**：否则「发出号 →
 *  立刻崩溃 → 该卷被删」这条窗口仍能复用——账的全部意义就是关掉它（每建一卷多一次
 *  小文件写，与同路径已 await 的卷日志物化同量级）。写失败**可见**但不阻断建卷：
 *  退回今日语义，下一次发号重试。 */
export async function noteVolumeIssued(projectPath: string, id: number): Promise<void> {
  let root: string;
  try {
    root = workspaceSessionsDir(projectPath);
  } catch {
    return; // 无工作区：发号路径本就走不到这里（防御位，静默合理——无存储位可记）
  }
  const led = issueLedgerOf(root);
  // 盘上是更新版兰台写的账（版本不认）：**定向拒读、绝不覆写**——覆写会抹掉新版
  // 已发出的号段，降级运行反而制造「号被复用」。合法降级路径 = 退回磁盘对账。
  if (led.foreign) return;
  const next = Math.max(led.next, id + 1);
  led.next = next;
  try {
    await sessionExecute('save_volume', {
      root,
      id: ISSUE_LEDGER_ID,
      data: JSON.stringify({ ver: ISSUE_LEDGER_VERSION, next }),
    });
  } catch (e) {
    console.warn('[chat] 发号账落盘失败（号段可能被复用；下次发号重试）:', e);
    showToast(`发号账落盘失败：案卷 ${id} 的号没被记账（下次发号重试）`, 'warn', TOAST_LONG_HOLD_MS);
  }
}

/** 会话快照的磁盘形状（C8：saveActiveSession 与合卷落盘共用）。
 *  compose：会话级创作坞覆盖（方案甲 2026-08-27）——只存显式改动过的卷，
 *  旧存档无此字段 = 无覆盖（实时跟随全局默认）。
 *  Stage-5：不再含 paper——布局/公共物已升格工作区级（canvas-store）。
 *  workspace-session-ownership-rework：不再写 workspace 字段——存储位置即归属。 */
export interface SessionSnapshotData {
  id: number;
  label: string;
  savedAt: string;
  messages: Message[];
  /** UI 消息副本（WO-7）：见 StoredSession.uiMessages。 */
  uiMessages?: ChatMessage[];
  tokensUsed: number;
  /** token 账本快照（2026-09-13）：见 StoredSession.tokens。 */
  tokens?: TokenLedgerSnapshot;
  compose?: ComposeSessionPrefs;
  /** 组合身份（P0 记录闭环）：见 StoredSession.presetId。 */
  presetId?: string;
  /** 投影缓存新鲜度（Phase 3b）：见 StoredSession.seq。 */
  seq?: number;
  ver?: number;
}

/** 投影缓存的格式版本（与事件日志 version 分开——缓存可丢弃重建）。 */
export const SESSION_CACHE_VERSION = 1;

/** 清空发号账内存态（跨用例隔离——与卷目录/写拒绝名单同批清）。 */
export function resetIssueLedgersForTests(): void {
  _issueLedgers.clear();
}
