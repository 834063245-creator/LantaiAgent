// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License: MIT.

// SessionLedger — 恢复集形状 + 发号对账（会话统一 U4 / Q1-B 总目退役后残面）。
//
// 历史：L0-L3 总目 _ledger.json 记「开合册」（摊开集 + 活跃指针 + 发号器），
// 2026-08-23 落地；2026-08-24 会话统一 U4 拍板 Q1-B 退役——会话全局化后
// 「谁摊开」由磁盘现场推导（chat-session.autoRestoreLastSession 扫描取最近
// N 卷合成恢复集），总目与 tracker（_active.json）不再读/写，在盘旧文件
// 自然荒废（毒化无害：无人读）。
//
// 本模块现仅承载：
//   - SessionLedgerDisk：恢复集的内存形状（autoRestore 合成 + restoreOpenSet
//     消费；不再有磁盘对应物）
//   - reconcileNextSessionId：发号对账（max(内存, 恢复集, 磁盘最大档号+1)）
//   - openMetaOf：恢复集元数据视图
//
// 模块级可变态归属（CONVENTIONS §1.10 四级分类）：零模块级可变态（纯函数）。

import { getChatStore } from '../ui/chat-store';

// ── 恢复集形状（内存态；磁盘总目已退役）──

/** 恢复集形状（摊开集推导产物：open 集 + 活跃卷指针 + 发号下限）。
 *  open[].label 是摊开时刻的卷名快照——恢复时以卷文件内 label 为准
 *  （卷文件更权威；此 label 仅在卷文件缺失时兜底显示）。 */
export interface SessionLedgerDisk {
  version: 2;
  open: Array<{ id: number; label?: string }>;
  activeId: number | null;
  nextSessionId: number;
  savedAt?: string;
}

// ── 发号（F5：单一发号源对账，scanMaxSessionId 上岗）──

/**
 * 发号器对账：next = max(内存 nextSessionId, 恢复集 nextSessionId, 磁盘最大卷号 + 1)。
 * 消灭「localStorage 双失效 → 新卷撞旧档号」的裂缝。
 * 工作区装配点调用一次；返回应写入 sess store 的 nextSessionId。
 */
export function reconcileNextSessionId(storeId: string, ledger: SessionLedgerDisk | null, scanMax: number): number {
  const memNext = getChatStore(storeId).sess.getState().nextSessionId;
  const ledgerNext = ledger?.nextSessionId ?? 0;
  return Math.max(memNext, ledgerNext, scanMax + 1);
}

/** 摊开集元数据视图（恢复路径用：恢复集 label 仅作卷文件缺失时的兜底显示）。 */
export function openMetaOf(ledger: SessionLedgerDisk): Array<{ id: number; label?: string }> {
  return ledger.open.map((o) => ({ id: o.id, label: o.label }));
}
