// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// paper/code-view — 程文（code）完成值的结构化视图（P5，code-execution-upgrade-plan §7）。
//
// 缘起：程序 `return { __view: 'table' | 'diff', … }` 时，纸面此前把整个对象当 JSON
// 文本倒出来（用户要的是「程序结果直接出表格」，拿到的是「一坨 JSON」）。
//
// 三条纪律（违反即返工）：
//   ① **单一权威源**：视图从**同一条信封文本**投影出来——模型读到的完成值与纸面读的
//      源是同一串，不在协议上加第二份表示（`done.view` 会让同一件事有两个真源）。
//   ② **不动模型面**：本层纯读（工具返回值一字不改，`__view` 对象照旧 JSON 落信封）。
//   ③ **解析不了就交回兜底**：形状不认识 / 被输出预算截断 / 未知 `__view` → null，
//      调用方照旧渲染 JSON 文本（信息不静默丢失）。
//
// 视图契约（模型可见，真源 = agent/code-run/code-execution-tool.ts 的描述）：
//   { __view: 'table', columns?: […], rows: [[…], …], caption?: '…' }
//   { __view: 'diff',  diff: '<统一 diff 文本>' }
// 省略量（行 / 列 / 超长单元格）不静默丢——`tableViewNote` 产出注记行，渲染与测高共用。

import { codeSections, diffLine, sanitizePayloadText, type ToolDisplay, toolDisplayFromLines } from './tool-text';

/** 表格视图：列 + 行（单元一律纯文本——纸面是展示面，不是数据面）。 */
export interface CodeTableView {
  kind: 'table';
  caption?: string;
  columns: string[];
  rows: string[][];
  /** 省略量——渲染与测高共用 `tableViewNote` 出注记行（不静默丢信息）。 */
  dropped: { rows: number; cols: number; cells: number };
}

/** 差分视图：统一 diff 文本（行首 +/-/@@ 决定墨色，与抄录块同判据）。
 *  **只有文本**——目标路径由 diff 自己的 `--- a/x` / `+++ b/x` 头承担（统一 diff
 *  的惯例），别再开一个 path 字段让程序选「写哪儿」（两个位置说同一件事 = 必然漂）。 */
export interface CodeDiffView {
  kind: 'diff';
  text: string;
}

export type CodeView = CodeTableView | CodeDiffView;

/** 行上限（超出出注记；.pp-out 可滚动，但 DOM 行数要收）。 */
const ROW_CAP = 200;
/** 列上限（版心宽下 13 列以上已不可读；超出出注记）。 */
const COL_CAP = 12;
/** 单元格字符上限（超长出注记——长 JSON 单元会把整张表撑成噪音）。 */
const CELL_MAX = 200;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 可选文本字段（空白即缺省——空题签不支一行）。 */
function optText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = sanitizePayloadText(v).trim();
  return t === '' ? undefined : t;
}

interface CellTally {
  cells: number;
}

/** 单元格 → 展示文本：null/undefined = 空；标量原样；
 *  容器走紧凑 JSON（表格单元里放结构是误用，但不当它不存在）；超长出注记。 */
function cellText(v: unknown, tally: CellTally): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v); // 环引用等（worker 侧已不可达，防御）
    }
  }
  s = sanitizePayloadText(s);
  if (s.length > CELL_MAX) {
    tally.cells += 1;
    return `${s.slice(0, CELL_MAX)}…`;
  }
  return s;
}

/** 表格形状归一（列/行/上限）。形状不认识 → null（调用方回落 JSON 文本）。 */
function tableViewOf(o: Record<string, unknown>): CodeTableView | null {
  const rowsRaw = Array.isArray(o.rows) ? o.rows : null;
  if (!rowsRaw) return null;
  // 先验形状再取值：rows 里混进非数组 = 不是表（别把 `[1,2]` 当一行两列猜）
  if (rowsRaw.some((r) => !Array.isArray(r))) return null;
  const colsRaw = Array.isArray(o.columns) ? o.columns : null;
  let width = colsRaw?.length ?? 0;
  for (const r of rowsRaw) width = Math.max(width, (r as unknown[]).length);
  if (width === 0) return null; // 零列零行：没有可展示的东西

  const tally: CellTally = { cells: 0 };
  const cols = Math.min(width, COL_CAP);
  // 列名：显式给的前 cols 项；缺省由最宽行派生 `#1..#N`（grid 原语同款兜底）
  const columns: string[] = [];
  for (let i = 0; i < cols; i++) {
    columns.push(colsRaw ? cellText(colsRaw[i], tally) : `#${i + 1}`);
  }
  const keep = Math.min(rowsRaw.length, ROW_CAP);
  const rows: string[][] = [];
  for (let r = 0; r < keep; r++) {
    const raw = rowsRaw[r] as unknown[];
    const row: string[] = [];
    for (let c = 0; c < cols; c++) row.push(c < raw.length ? cellText(raw[c], tally) : '');
    rows.push(row);
  }
  const caption = optText(o.caption);
  return {
    kind: 'table',
    ...(caption ? { caption } : {}),
    columns,
    rows,
    dropped: { rows: rowsRaw.length - keep, cols: width - cols, cells: tally.cells },
  };
}

function diffViewOf(o: Record<string, unknown>): CodeDiffView | null {
  if (typeof o.diff !== 'string') return null;
  const text = sanitizePayloadText(o.diff).replace(/\n+$/, '');
  if (text.trim() === '') return null;
  return { kind: 'diff', text };
}

/** 完成值段文本 → 视图。无信封 / 无完成值段 / 非 JSON / 未知 `__view` → null。 */
export function codeViewOf(output: string | undefined): CodeView | null {
  if (!output) return null;
  // 只认「完成值」段：日志里出现的 `__view` 不是程序的返回值（同名键不越权）。
  const secs = codeSections(output);
  let result: string | null = null;
  for (const s of secs) if (s.kind === 'result') result = s.raw;
  if (result === null) return null;
  // 快出口：视图必然是对象（字符串/数组/数字完成值零解析开销——绝大多数程文走这条）
  const head = result.trim().slice(0, 1);
  if (head !== '{') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.trim());
  } catch {
    return null; // 被预算截断 / 非 JSON：照旧当文本读
  }
  const o = asRecord(parsed);
  if (!o) return null;
  if (o.__view === 'table') return tableViewOf(o);
  if (o.__view === 'diff') return diffViewOf(o);
  return null;
}

/** 表格注记行（空串 = 无省略）：渲染与测高同一判据（不静默丢信息）。 */
export function tableViewNote(view: CodeTableView): string {
  const parts: string[] = [];
  if (view.dropped.rows > 0) {
    parts.push(`其余 ${view.dropped.rows} 行未显示（共 ${view.rows.length + view.dropped.rows} 行）`);
  }
  if (view.dropped.cols > 0) {
    parts.push(`其余 ${view.dropped.cols} 列未显示（共 ${view.columns.length + view.dropped.cols} 列）`);
  }
  if (view.dropped.cells > 0) parts.push(`${view.dropped.cells} 格超长已截断`);
  return parts.join(' · ');
}

/** 差分视图的展示模型（行首 +/-/@@ 三档墨色——与抄录块 / fs(edit) 同判据）。
 *  渲染与测高消费同一产物（文本即测量量，镜像纪律见 paper/tool-text 头注）。 */
export function diffViewDisplay(view: CodeDiffView): ToolDisplay {
  return toolDisplayFromLines(view.text.split('\n').map((line) => diffLine(line)));
}

/** 折叠行读数（「表格 4×3」/「差分 +12 −3」）；空串 = 回落字数读数。 */
export function codeViewReadout(view: CodeView): string {
  if (view.kind === 'table') {
    const rows = view.rows.length + view.dropped.rows;
    const cols = view.columns.length + view.dropped.cols;
    return `表格 ${rows}×${cols}`;
  }
  let add = 0;
  let del = 0;
  for (const line of view.text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) add += 1;
    else if (line.startsWith('-')) del += 1;
  }
  return `差分 +${add} −${del}`;
}
