// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shelf-model — 架阁两页的**纯函数面**（无 React、无 store、无 RPC）。
//
// 为什么单独一层：器物页与卡片页都要「过滤 / 分桶 / 时间与字节的读法 / payload 取文」，
// 这些判据必须只有一份（页面组件各写一遍 = 两套口径）。本文件只做输入 → 输出的
// 归一，不持有任何状态，也不认识宿主桥。

/** 器物页一行（窗口 / 软件 / 面板统一形状——渲染与键盘只认它）。 */
export interface ShelfRow {
  id: string;
  title: string;
  sub: string;
  /** 朱砂方点：窗口开 / 面板开 ⇒ true；软件未开 ⇒ false。 */
  on: boolean;
  /** 行主点击（键盘 ↵ 同一条）：开窗 / 聚焦 / 开面板。 */
  run: () => void;
  /** 行尾动作（常显，不做 hover 才出）。 */
  acts: Array<{ label: string; run: () => void; quiet?: boolean }>;
}

/** 器物页一段（在窗 / 软件 / 面板）。空段不渲染——空标题只是噪声。 */
export interface ShelfSection {
  key: 'windows' | 'apps' | 'panels';
  title: string;
  rows: ShelfRow[];
}

/** 卡片摘要（`card_list` 一行，字段可能残缺——旧卡按诚实给空）。 */
export interface CardEntry {
  cardId: string;
  kind: string;
  title: string;
  /** ISO 串；读不出 = 空（排到「更早」且不显示时间，不编造）。 */
  shelvedAt: string;
  dirBytes: number;
  stateBytes: number;
  /** 文件卡记的绝对路径（非空 = 这张卡能再被打开）。 */
  file: string;
}

/** `card_read` 回来的 card.json（自由形状——只取架阁用得上的四样）。 */
export interface CardDoc {
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  source: Record<string, unknown>;
  file: string;
}

export type CardBucketKey = 'today' | 'week' | 'earlier';

export interface CardBucket {
  key: CardBucketKey;
  title: string;
  rows: CardEntry[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 卡片摘要归一（RPC 返回 unknown 的边界只在这一处拆）。 */
export function normalizeCard(raw: unknown): CardEntry {
  const o = (raw ?? {}) as Record<string, unknown>;
  const file = str(o.file);
  return {
    cardId: str(o.cardId),
    kind: str(o.kind),
    title: str(o.title),
    shelvedAt: str(o.shelvedAt),
    dirBytes: typeof o.dirBytes === 'number' && Number.isFinite(o.dirBytes) ? o.dirBytes : 0,
    stateBytes: typeof o.stateBytes === 'number' && Number.isFinite(o.stateBytes) ? o.stateBytes : 0,
    file,
  };
}

/** card.json 归一。 */
export function cardDocOf(raw: unknown): CardDoc {
  const o = (raw ?? {}) as Record<string, unknown>;
  const payload = (o.payload ?? {}) as Record<string, unknown>;
  const source = (o.source ?? {}) as Record<string, unknown>;
  return {
    kind: str(o.kind),
    title: str(o.title),
    payload,
    source,
    file: str(o.file) || str(payload.path),
  };
}

/** 卡片显示名：标题 → kind 兜底（不编造「未命名」以外的信息）。 */
export function cardTitle(card: Pick<CardEntry, 'title' | 'kind'>): string {
  if (card.title) return card.title;
  return card.kind ? `${card.kind}（未命名）` : '未命名卡片';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 入阁时间戳（本机时区）：今年 = `MM-DD HH:mm`，跨年 = `YYYY-MM-DD`。 */
export function fmtStamp(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.getFullYear() !== now.getFullYear()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 分桶：今天 / 本周（近 7 天）/ 更早。读不出的时间归「更早」——不冒充今天。 */
export function bucketOf(iso: string): CardBucketKey {
  if (!iso) return 'earlier';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'earlier';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startOfToday) return 'today';
  if (t >= startOfToday - 6 * 24 * 60 * 60 * 1000) return 'week';
  return 'earlier';
}

const BUCKET_TITLE: Record<CardBucketKey, string> = { today: '今天', week: '本周', earlier: '更早' };

/** 按入阁时间分桶（桶序固定 今天 → 本周 → 更早；空桶不出）。 */
export function bucketCards(cards: readonly CardEntry[]): CardBucket[] {
  const grouped: Record<CardBucketKey, CardEntry[]> = { today: [], week: [], earlier: [] };
  for (const c of cards) grouped[bucketOf(c.shelvedAt)].push(c);
  return (['today', 'week', 'earlier'] as const)
    .filter((k) => grouped[k].length > 0)
    .map((k) => ({ key: k, title: BUCKET_TITLE[k], rows: grouped[k] }));
}

/** 字节读数（只给人一个量级，不做精确到小数的账）。 */
export function bytesLabel(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 子序列/包含的极简大小写不敏感匹配（空查询 = 全中）。 */
export function matches(query: string, ...fields: Array<string | undefined | null>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}

const TEXT_KEYS = ['text', 'markdown', 'content', 'body', 'quote', 'excerpt', 'summary', 'code'] as const;

/** 从 payload 里取一段可读文本（给非 html / 非 table 的卡一个诚实的预览）。
 *  只认常见文本键，不猜；取不到 = null（界面回落「这类卡片不能在架上预览」）。 */
export function payloadText(payload: Record<string, unknown>): string | null {
  for (const key of TEXT_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim()) return v.length > 8000 ? `${v.slice(0, 8000)}…` : v;
  }
  return null;
}

/** 表格卡的最小形状（列可缺省——按行位生成表头）。 */
export interface TableShape {
  columns: string[];
  rows: string[][];
  caption: string;
}

export function tableOf(payload: Record<string, unknown>): TableShape | null {
  const rawRows = payload.rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0) return null;
  const rows = rawRows.slice(0, 200).map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : []));
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const rawCols = Array.isArray(payload.columns) ? payload.columns.map((c) => String(c)) : [];
  const columns = Array.from({ length: width }, (_, i) => rawCols[i] ?? `#${i + 1}`);
  return { columns, rows, caption: str(payload.caption) };
}
