// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionSidebar 数据模型（纯函数）——侧边栏行合流/排序/相对时间/状态点。
// Stage-3 DSH 范式：当前工作区会话管理 = 摊开会话（sess store）+ 未摊开
// 已存卷（listSavedSessions）两源合流；状态点 pending > running > done/idle
// （子 agent 与 running 同点——当前 exec 面暂无每会话子 agent 计数，运行中
// 即亮石青点，stage-3 §5 数据源核对）。

export type SessionStatus = 'pending' | 'running' | 'done' | 'idle';

export interface SidebarRow {
  id: number;
  label: string;
  savedAt: string;
  open: boolean;
  msgCount: number;
  /** 行状态点（组件计算后填充；纯模型保留类型供测试） */
  status: SessionStatus;
}

/** 两源合流：磁盘已存卷为底，摊开会话覆盖（label 取内存最新；savedAt 缺失
 *  的未落盘新卷保留空）。排序 = 摊开优先，同组按 savedAt 倒序（新者上）。 */
export function mergeSessionRows(
  open: Array<{ id: number; label: string; msgCount: number }>,
  saved: Array<{ id: number; label: string; msgCount: number; savedAt: string }>,
): SidebarRow[] {
  const byId = new Map<number, SidebarRow>();
  for (const s of saved) {
    byId.set(s.id, {
      id: s.id,
      label: s.label || `案卷 ${s.id}`,
      savedAt: s.savedAt,
      open: false,
      msgCount: s.msgCount,
      status: 'idle',
    });
  }
  for (const o of open) {
    const prev = byId.get(o.id);
    byId.set(o.id, {
      id: o.id,
      label: o.label || prev?.label || `案卷 ${o.id}`,
      savedAt: prev?.savedAt ?? '',
      open: true,
      msgCount: o.msgCount ?? prev?.msgCount ?? 0,
      status: 'idle',
    });
  }
  const rows = [...byId.values()];
  rows.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    const t = (b.savedAt || '').localeCompare(a.savedAt || '');
    if (t !== 0) return t;
    return b.id - a.id;
  });
  return rows;
}

/** 相对时间（DSH 行副信息）：刚刚 / N 分钟前 / N 小时前 / N 天前；缺省 '—'。 */
export function relativeTime(iso: string, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffMs = now - t;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString();
}

/** 状态点文案（title/aria 用）。 */
export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'pending':
      return '等待交互';
    case 'running':
      return '运行中';
    case 'done':
      return '已完成';
    case 'idle':
      return '空闲';
  }
}

/** 检索过滤（注疏重排 2026-08-31）：query 空 = 全量；匹配卷名（大小写
 *  无关）或卷号数字——卷名缺省名「案卷 N」天然可被命中。 */
export function filterRows(rows: SidebarRow[], query: string): SidebarRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => (r.label || `案卷 ${r.id}`).toLowerCase().includes(q) || String(r.id).includes(q));
}

/** 分节：摊开中（OPEN）在前、已合卷（CLOSED）在后——节内保持合流排序
 *  （新者上），不再做摊开优先的扁平混排。 */
export function splitSections(rows: SidebarRow[]): { open: SidebarRow[]; closed: SidebarRow[] } {
  return {
    open: rows.filter((r) => r.open),
    closed: rows.filter((r) => !r.open),
  };
}

/** 行机读注记（注疏版式第二行）：Nº 卷号 · N 块 · 相对时间；未落盘新卷
 *  （无 savedAt）省时间段，不出「—」占位。 */
export function sessionMeta(r: Pick<SidebarRow, 'id' | 'msgCount' | 'savedAt'>, now = Date.now()): string {
  const parts = [`Nº ${r.id}`, `${r.msgCount} 块`];
  if (r.savedAt) parts.push(relativeTime(r.savedAt, now));
  return parts.join(' · ');
}
