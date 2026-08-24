// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// SessionLedger — 案卷总目（session-ledger-plan L0，2026-08-23 立项）。
//
// 一个实体、一本账、两个视图、两个动词：
//   - 会话身份统一：档案号 = 卷号（磁盘 {id}.json 与内存 sess store 同号）
//   - 总目 `_ledger.json` 记「开合册」：摊开集（open）+ 活跃卷指针（activeId）
//     + 发号器（nextSessionId）——它是 _active.json 的继任者（自然迁移：
//       旧路径恢复成功后首次写盘即完成升级，旧跟踪文件退休）
//   - 书脊列 / 档案首页退化为总目的两个视图：谁摊开查 isOpen，不自己记账
//
// 本模块只管「开合与发号」；卷内容（messages/tokens/paper）仍归
// chat-session.ts 的卷文件快照（writeSessionSnapshot），两层无字段竞争。
// 摊开集的运行时真相 = sess store（20+ 消费点不动）；总目是它的持久化投影。
//
// 模块级可变态归属（CONVENTIONS §1.10 四级分类）：本模块零模块级可变态
// （纯函数 + 调用方持有的账本对象）；磁盘真源不在内存长期持有。

import { getChatStore } from '../ui/chat-store';

// ── 磁盘形状 ──

/** 总目磁盘形状（_ledger.json，version 2）。
 *  open[].label 是摊开时刻的卷名快照——重启恢复时以卷文件内 label 为准
 *  （卷文件更权威；总目 label 仅在卷文件缺失时兜底显示）。 */
export interface SessionLedgerDisk {
  version: 2;
  open: Array<{ id: number; label?: string }>;
  activeId: number | null;
  nextSessionId: number;
  savedAt?: string;
}

// ── 磁盘 IO 注入（RPC 依赖经注入而非直接 import chat-session——
//    chat-session 导入本模块记账，本模块不得反向依赖它，避免循环 import）──

export interface LedgerIo {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
}

// ── 路径推导（与 chat-session 的 sessionsDir 同规：项目内 .lantai/sessions）──

export function ledgerFile(projectPath: string): string {
  return `${projectPath.replace(/\\/g, '/')}/.lantai/sessions/_ledger.json`;
}

/** 去 read_file_content 行号前缀（后端始终返回 "{:>6}\t{content}"）。 */
function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

// ── 解析（毒化容忍：INVARIANTS #11 读路径纪律——坏账本不炸启动）──

export function parseLedger(raw: unknown): SessionLedgerDisk | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Partial<SessionLedgerDisk>;
  if (v.version !== 2 || !Array.isArray(v.open)) return null;
  const open: Array<{ id: number; label?: string }> = [];
  const seen = new Set<number>();
  for (const e of v.open) {
    if (typeof e !== 'object' || e === null) continue;
    const id = (e as { id?: unknown }).id;
    if (typeof id !== 'number' || !Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    const label = (e as { label?: unknown }).label;
    open.push({ id, label: typeof label === 'string' ? label : undefined });
  }
  return {
    version: 2,
    open,
    activeId: typeof v.activeId === 'number' ? v.activeId : null,
    nextSessionId: typeof v.nextSessionId === 'number' && v.nextSessionId > 0 ? v.nextSessionId : 1,
    savedAt: typeof v.savedAt === 'string' ? v.savedAt : undefined,
  };
}

// ── 读取（自然迁移：总目缺席 → 旧路径照跑，恢复成功后首次写盘即完成升级）──

export interface LoadedLedger {
  ledger: SessionLedgerDisk | null;
}

/**
 * 读总目。只有 _ledger.json 一种真相源：
 *  - 有且合法 → 返回（不再读 _active.json——它自总目首次写盘起退休）
 *  - 无/毒化 → null（调用方回退旧单卷路径：_active.json/localStorage，
 *    行为不变；旧路径恢复成功后的 recordOpenSetChange 写出首份总目，
 *    迁移自然完成，无需显式吸收旧跟踪文件）
 */
export async function loadLedger(projectPath: string, io: LedgerIo): Promise<LoadedLedger> {
  try {
    const raw = await io.readFile(ledgerFile(projectPath));
    return { ledger: parseLedger(JSON.parse(stripLineNumbers(raw))) };
  } catch {
    /* 无总目或毒化 — 冷路径（旧单卷路径兼自然迁移入口） */
    return { ledger: null };
  }
}

// ── 写入（sess store 投影 → 磁盘）──

/** 从 sess store 内存态推导总目全量快照（写入的唯一数据源）。 */
export function snapshotFromMem(storeId: string): SessionLedgerDisk {
  const st = getChatStore(storeId).sess.getState();
  const activeId = st.sessions[st.activeIdx]?.id ?? null;
  return {
    version: 2,
    open: st.sessions.map((s) => ({ id: s.id, label: s.label })),
    activeId,
    nextSessionId: st.nextSessionId,
    savedAt: new Date().toISOString(),
  };
}

/** 全量写总目。失败可见（console.error + 上抛给调用方决定通知等级），不静默。 */
export async function persistLedger(storeId: string, projectPath: string, io: LedgerIo): Promise<void> {
  const disk = snapshotFromMem(storeId);
  try {
    await io.writeFile(ledgerFile(projectPath), JSON.stringify(disk));
  } catch (e) {
    console.error('[ledger] 总目落盘失败:', e);
    throw e;
  }
}

/**
 * 摊开集变更后的记账（另起/换卷/合卷/续开四个动词的公共尾巴）。
 * 总目写失败不影响会话操作本身（磁盘总目缺席时恢复路径退化为旧行为），
 * 但失败要可见（persistLedger 内已记日志）。
 */
export function recordOpenSetChange(storeId: string, projectPath: string | null, io: LedgerIo): void {
  if (!projectPath) return;
  persistLedger(storeId, projectPath, io).catch(() => {
    /* 已记日志——记账尽力而为，见上注释 */
  });
}

// ── 成员查询（两个视图共用：书脊列已有 sess store 订阅；首页卡片摊开标记用此口）──

/** 该卷是否已摊开（运行时真相 = sess store；不查磁盘——首页列表已列全档案，
 *  摊开标记只对「当前面板正在翻」为真）。 */
export function isOpen(storeId: string, sessionId: number): boolean {
  return getChatStore(storeId)
    .sess.getState()
    .sessions.some((s) => s.id === sessionId);
}

// ── 发号（F5：单一发号源对账，scanMaxSessionId 上岗）──

/**
 * 发号器对账：next = max(内存 nextSessionId, 总目 nextSessionId, 磁盘最大卷号 + 1)。
 * 消灭「跟踪文件+localStorage 双失效 → 新卷撞旧档号」的裂缝。
 * 工作区装配点调用一次；返回应写入 sess store 的 nextSessionId。
 */
export function reconcileNextSessionId(storeId: string, ledger: SessionLedgerDisk | null, scanMax: number): number {
  const memNext = getChatStore(storeId).sess.getState().nextSessionId;
  const ledgerNext = ledger?.nextSessionId ?? 0;
  return Math.max(memNext, ledgerNext, scanMax + 1);
}

/** 摊开集元数据视图（恢复路径用：总目 label 仅作卷文件缺失时的兜底显示）。 */
export function openMetaOf(ledger: SessionLedgerDisk): Array<{ id: number; label?: string }> {
  return ledger.open.map((o) => ({ id: o.id, label: o.label }));
}
