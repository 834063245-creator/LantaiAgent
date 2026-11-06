// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷读取（快照 / 清单 / 档号列表）
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import { sessionExecute } from '../../../composition/session-persistence-service';
import { readVolumeLogMessages } from '../session-log-store';
import { buildMissingRows, catalogOf, flushCatalog, loadCatalog, type SavedSessionRow } from './session-catalog';
import { readVolumeJSON, type StoredSession, workspaceSessionsDir } from './session-paths';
import type { SessionContext } from './session-types';

// ── 摊开集多卷恢复（扫描推导；session-ledger L0 语义承继面）─────────────

/** **投影缓存是否属于这一卷**（同代校验——读面唯一判据，2026-09-19「子卷卷名乱套」根治）。
 *
 *  为什么必须有：**卷集判定只认 `.ndjson`**（`listVolumeIds` / `scanMaxSessionId`），
 *  而 `{id}.json` 是**另一条命**——上一代的 `.json` 会以两种方式留在盘上：
 *    · **旧格式化石**：Phase 3b 之前的 `.json` 卷（用户 2026-09-15 拍板「不做兼容读」，
 *      文件留在盘上不再被认作卷）；
 *    · **删除竞态复活**：删除链先 `delete_log` 再 `closeSession`，而合卷快照是
 *      fire-and-forget 的写链任务 ⇒ 已删卷的 `.json` 被写回盘上（本机实测：`10.json`
 *      的 `savedAt` 恰是删除那一刻，与 `13.ndjson` 的立卷时刻只差 14 秒）。
 *  档号一旦被复用（删掉大号卷后 `scanMaxSessionId` 回退，发号取 `scanned + 1`），
 *  残留缓存就冒充**新卷**的缓存：新卷顶着**死卷的名**（真机验收：立枝出来的三个子卷
 *  卷名全来自 9/6–9/7 的死卷，且因为「有名 = 已命名」再也没有任何命名路径会纠正它），
 *  `seq` 够大时连死卷的 `uiMessages`/账本/组合都一并搬过来。
 *
 *  判据：**缓存必须晚于卷的立卷时刻**（头行 `createdAt` = write-once 真源；缓存 `savedAt`
 *  = 最后一次落盘，恒 ≥ 立卷时刻）。两刻有任一不可判（旧卷缺字段）= **不否决**——
 *  误伤本代缓存的代价是卷名/账本/组合一起丢，比漏放一份残留贵得多。 */
export function cacheOfThisVolume(cache: StoredSession | null, bornAt: string | undefined): boolean {
  if (!cache) return false;
  const born = Date.parse(bornAt ?? '');
  const saved = Date.parse(cache.savedAt ?? '');
  if (Number.isNaN(born) || Number.isNaN(saved)) return true;
  return saved >= born;
}

/** 恢复路径的卷数据（**Phase 3b 权威翻转**）：**事件日志 = 卷本体与内容真源**，
 *  `.json` 降级为 UI 投影缓存（`uiMessages`/tokens/compose/label）。
 *  · 无日志 = 卷不存在（旧 `.json` 卷不做兼容读——用户 2026-09-15 拍板）；
 *  · 缓存**不是本卷的**（同代校验不过 = 上一代残留）→ 一律当没有：卷名留空（呈现层按
 *    档号兜底）、账本/组合不采信——见 `cacheOfThisVolume` 注；
 *  · 缓存陈旧（`cache.seq < 日志 lastSeq`）→ **不采信快照**，UI 面走既有
 *    `rebuildMessagesFromMessages` 重建（DSH「possibly stale but never wrong」）。
 *  P0-3（2026-09-02）导出：restoreCanvasSpread 两阶段恢复的并行读面。 */
export async function readVolumeData(projectPath: string, id: number): Promise<StoredSession | null> {
  // 无工作区 = 无卷（M8 既定降级：空路径响亮报错由 workspaceSessionsDir 承担，
  // 消费面按「空集/不存在」处理——这里不把它变成异常，见 session-exit-flush 用例）。
  if (!projectPath) return null;
  // 读面失败**上抛**（2026-10-29 收口，M9）：此前 catch 成 null ⇒ 上层把「读失败」
  // 当「卷不存在」（画布剪枝会因此把真卷当幽灵删掉）。缺失 = null（provider 判空），
  // 失败 = throw——消费面各自选择「保留上次结果 / 明示」。
  const logRead = await readVolumeLogMessages(workspaceSessionsDir(projectPath), id);
  if (!logRead) return null;
  // 空卷（无任何非系统消息）不进摊开集——与「空卷不落盘」同规
  if (!logRead.messages.some((m) => m.role !== 'system')) return null;
  const raw = await readVolumeJSON(projectPath, id);
  // 同代校验：`.json` 不是本卷的（上一代残留）⇒ 整份当没有——卷名的家在这里，
  // 采信残留 = 新卷顶着死卷的名（真机「子卷卷名乱套」的机理，见 cacheOfThisVolume）。
  const cache = cacheOfThisVolume(raw, logRead.header.createdAt) ? raw : null;
  const fresh = cache !== null && typeof cache.seq === 'number' && cache.seq >= logRead.lastSeq;
  return {
    id,
    // 卷名的家 = 投影缓存（2026-09-18 命名收口：事件日志头行不再带 label——那份
    // append-only 副本改名永不回写，只会在读面冒充真值）。缺缓存 = 未命名（空），
    // 显示兜底由呈现层按档号给；内容真源仍是事件日志。
    label: cache?.label ?? '',
    savedAt: cache?.savedAt ?? '',
    createdAt: logRead.header.createdAt,
    // 血缘取**头行**（write-once 真源），不取快照——快照里没有这一栏
    ...(logRead.header.parent ? { parentId: logRead.header.parent.id } : {}),
    messages: logRead.messages,
    uiMessages: fresh ? cache?.uiMessages : undefined,
    tokensUsed: cache?.tokensUsed,
    // 账本不受新鲜度门管（2026-09-18 修）：`tokens` 是**累计账**不是投影——陈旧
    // 快照只会「落后」（少记末尾几百 token），不会「说错」；而丢掉它才是错的
    // （重开卷账本从零起 = 历史读数凭空消失）。DSH 同判：possibly stale but never wrong。
    // uiMessages 仍按新鲜度取舍——那是内容投影，陈旧会如实说错。
    tokens: cache?.tokens,
    compose: cache?.compose,
    presetId: cache?.presetId ?? logRead.header.presetId,
    seq: logRead.lastSeq,
    ver: 1,
  };
}

/** 扫描本工作区会话根 — 无需 Agent。单目录（{workspace}/.lantai/sessions/），
 *  目录内文件天然属于本工作区（归属 = 存储位置，无 workspace 字段过滤）。
 *  Phase 3b：**卷集 = `.ndjson` 文件集**（卷本体）；label/savedAt 取投影缓存，
 *  msgCount 由事件日志派生（内容真源）——缓存缺失/陈旧不影响「卷存不存在」。
 *  读取失败的卷**可见化**（console.error + 明示原因），不再静默从列表消失。
 *
 *  成本与失效（P0·2026-09-18 侧栏载入审计）：清单投影**持久化**在 `{root}/_index.json`
 *  ——一次清点 = 目录枚举 + 一份小 JSON（几百卷 ≈ 20 KB），**不读任何卷体**；缺失行由
 *  目录对账发现并补建（首次调用阻塞至预算，其余后台分批 + 每批广播）。见「卷目录」头注。
 *  读盘**失败**不再伪装成空集：目录枚举失败一律上抛（调用方保留上次结果并明示），
 *  「工作区为空」才返回 []。 */
export async function listSavedSessions(_ctx: SessionContext, projectPath: string): Promise<SavedSessionRow[]> {
  // 无工作区 = 无卷（合法空态，不是失败——不抛）
  if (!projectPath) return [];
  const root = workspaceSessionsDir(projectPath);
  const ids = await listVolumeIds(projectPath);

  const cat = catalogOf(root);
  await loadCatalog(cat, root);

  // 目录对账（**文件不在 = 卷不存在**）：目录里没有的条目摘掉（外部删除可见化）
  const present = new Set(ids);
  let pruned = false;
  for (const id of [...cat.rows.keys()]) {
    if (!present.has(id)) {
      cat.rows.delete(id);
      pruned = true;
    }
  }
  if (pruned) flushCatalog(cat, root);

  // 目录里有、目录里没有 = 待补建（本轮失败的卷不反复重试；补建在途时并发清点
  // 直接返回已知行——不重复读盘）
  const missing = ids.filter((id) => !cat.rows.has(id) && !cat.failed.has(id));
  if (missing.length > 0 && !cat.building && !cat.blocking) {
    await buildMissingRows(cat, root, projectPath, missing);
  }

  const rows: SavedSessionRow[] = [];
  for (const id of ids) {
    const row = cat.rows.get(id);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return rows;
}

/** **本工作区卷号集**（目录枚举 = 卷集真源：文件不在 = 卷不存在）——清单之外的
 *  读面（会话树「枝」的血缘图重建）取材于此，**不信 `_index.json`**（它是投影，
 *  可陈旧；删除连坐是不可逆动作，见 `app/chat/session-branch.loadBranchLineage`）。 */
export async function listVolumeIds(projectPath: string): Promise<number[]> {
  const names = await listVolumeNames(workspaceSessionsDir(projectPath));
  // 卷集 = .ndjson（跳过下划线开头的保留名；provider 已滤目录）
  const ids: number[] = [];
  for (const name of names) {
    if (!name.endsWith('.ndjson') || name.startsWith('_')) continue;
    const sid = parseInt(name.replace(/\.ndjson$/, ''), 10);
    if (!Number.isNaN(sid)) ids.push(sid);
  }
  return ids;
}

/** 目录枚举（list_volumes）——失败**上抛**（旧实现返回空集，把「目录读不出来」
 *  显示成「没有卷」）。 */
async function listVolumeNames(root: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await sessionExecute('list_volumes', { root });
  } catch (e) {
    console.error('[chat] listSavedSessions: list_volumes failed', e);
    throw new Error(`案卷目录枚举失败（${root}）：${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    console.error('[chat] listSavedSessions: unexpected result', typeof parsed);
    throw new Error(`案卷目录枚举返回非数组（${typeof parsed}）`);
  }
  return parsed.filter((n): n is string => typeof n === 'string');
}

/** 从磁盘加载已保存的会话到新标签页（单卷打开路径——首页点卷/侧边栏续开）。
 *  批量摊开集恢复走 batchRestoreSessions（P3-1）——本函数不再承担恢复路径。
 *  ⚠ 返回「该卷是否已在案头摊开」（2026-09-10 收口）：true = 新摊开成功或本
 *  就已在案头（幂等分支）；false = 未摊开（卷文件缺失/墓碑、读失败、代际丢弃）。
 *  消费方 space-service.expand 依此决定要不要发起定位——失败卷永远不会进
 *  摊开集，照旧发定位只会留下永不兑现的悬空请求（见 expand 注）。 */
