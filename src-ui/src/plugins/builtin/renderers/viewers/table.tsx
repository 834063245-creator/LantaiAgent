// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 表格数据查看器（P1 · B7 之一）——csv / tsv：RFC4180 子集解析 + 表头冻结 + 行数读数
// + 截断横幅。样式语言与流内 `grid` 原语同源（同 token），**不复用组件本体**：
// 原语自带题签行与虚拟滚动，与本壳的题签行重复、且改热原语的收益低于风险（施工单 §11 记）。

import { VIEWER_TABLE_EXTS } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import './table.css';

const { useMemo } = rendererHooks;

/** 行窗口（与注册面 readLines 同值：宿主多读 1 行作「文件更长」判据）。 */
const TABLE_LINE_CAP = 4000;
/** 显示行上限（超出出横幅；窗口本身已限 4000 行，这里再收一道防 DOM 过大）。 */
const TABLE_ROW_CAP = 500;

interface TableView {
  columns: string[];
  rows: string[][];
  /** 与表头列数不一致的行数（不静默：显式读数） */
  ragged: number;
  /** 窗口里还有第 TABLE_LINE_CAP+1 行 ⇒ 文件更长 */
  moreLines: boolean;
}

/** RFC4180 子集：引号包裹字段（`""` 转义）、CRLF/LF、按分隔符切。
 *  末行无换行也算一行；空文本 = 零行（空态由调用方给可读文案）。 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function buildTableView(text: string, ext: string): TableView {
  const delimiter = ext === 'tsv' ? '\t' : ',';
  const all = parseDelimited(text, delimiter);
  const moreLines = all.length > TABLE_LINE_CAP;
  const capped = moreLines ? all.slice(0, TABLE_LINE_CAP) : all;
  const header = capped[0] ?? [];
  const columns = header.length > 0 ? header : (capped[1]?.map((_, i) => `#${i + 1}`) ?? []);
  const body = header.length > 0 ? capped.slice(1) : capped;
  const shown = body.length > TABLE_ROW_CAP ? body.slice(0, TABLE_ROW_CAP) : body;
  const ragged = shown.filter((r) => r.length !== columns.length).length;
  return { columns, rows: shown, ragged, moreLines };
}

function TableViewer({ ext, bytes }: ViewerProps) {
  const text = bytes?.kind === 'text' ? bytes.value : '';
  const view = useMemo(() => buildTableView(text, ext), [text, ext]);
  // 文本没有放大形态（浮层由宿主渲染，「看大图」语义对表格无意义）
  if (text.length === 0) return <div className="pp-viewer-empty">文件为空（0 行）</div>;
  if (view.columns.length === 0) return <div className="pp-viewer-empty">没有可显示的行</div>;
  return (
    <div className="pp-viewer-box pp-viewer-table">
      {view.moreLines && <div className="pp-viewer-note">已截断：只读前 {TABLE_LINE_CAP} 行（文件更长）</div>}
      <div className="pp-viewer-table-meta">
        {view.rows.length} 行 × {view.columns.length} 列 · 分隔符 {ext === 'tsv' ? '制表符' : '逗号'}
        {view.rows.length >= TABLE_ROW_CAP && ` · 只显示前 ${TABLE_ROW_CAP} 行`}
        {view.ragged > 0 && ` · ${view.ragged} 行列数与表头不一致（按表头列数显示）`}
      </div>
      <table className="pp-viewer-table-grid">
        <thead>
          <tr>
            {view.columns.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 表头按列位渲染（同名列是合法的）
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 表格行按位置渲染，行序即身份
            <tr key={i}>
              {view.columns.map((_, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 单元格按行列位置渲染
                <td key={j}>{row[j] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const tableViewer: ViewerDef = {
  id: 'table',
  exts: VIEWER_TABLE_EXTS,
  needsBytes: true,
  bytesKind: 'text',
  readLines: TABLE_LINE_CAP,
  maxBytes: 4 * 1024 * 1024,
  component: TableViewer,
};
