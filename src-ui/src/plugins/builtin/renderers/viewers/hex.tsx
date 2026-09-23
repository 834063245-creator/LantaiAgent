// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 兜底查看器（P1 · B8 之一）——**未认领的扩展名**不再落文件壳：读字节 → 嗅探 →
//   ① 严格 UTF-8 解码成功且可打印占比 ≥ 0.9 ⇒ 文本视图（行号 + mono）
//   ② 否则 ⇒ 十六进制视图（偏移 + 16 字节 + ASCII），窗口内分页
// 两条都带「未认领扩展名」横幅（用户知道这不是专程支持的格式）。
// 体积闸 256 KiB：base64 走 IPC 且要进 DOM，未知格式没必要整份读。

import { VIEWER_CATCHALL_ID } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import { bytesOfDataUri, printableRatio, strictUtf8 } from './bytes';
import './hex.css';

const { useMemo, useState } = rendererHooks;

/** 嗅探阈值：可打印占比 ≥ 此值当文本（低于它 → hex；经验值，宁严勿宽）。 */
const TEXT_RATIO = 0.9;
/** 文本视图行上限 / hex 视图每页字节数。 */
const TEXT_LINE_CAP = 2000;
const HEX_PAGE_BYTES = 4096;

interface Sniff {
  text: string | null;
  bytes: Uint8Array;
}

/** 兜底两态输入：`auto` 形态下文本窗口成功 ⇒ 直接是文本（无 base64）；
 *  文本读失败 ⇒ 宿主转二进制通道给 data URI。两条都归一到「字节 + 可选文本」。 */
function sniff(bytes: ViewerProps['bytes']): Sniff {
  if (bytes?.kind === 'text') {
    // 文本窗口来的原文：反向编码回字节是无损的（它本就是 UTF-8 解码的产物）
    return { text: bytes.value, bytes: new TextEncoder().encode(bytes.value) };
  }
  const raw = bytesOfDataUri(bytes?.kind === 'data-uri' ? bytes.value : undefined);
  const decoded = raw.length > 0 ? strictUtf8(raw) : null;
  const text = decoded !== null && printableRatio(decoded) >= TEXT_RATIO ? decoded : null;
  return { text, bytes: raw };
}

function hexLine(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function asciiLine(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
    .join('');
}

function HexViewer({ ext, bytes }: ViewerProps) {
  const view = useMemo(() => sniff(bytes), [bytes]);
  const [page, setPage] = useState(0);
  if (view.bytes.length === 0) return <div className="pp-viewer-empty">读取到的字节为空（文件可能是空的）</div>;
  const banner = `未认领的扩展名「${ext ? `.${ext}` : '（无扩展名）'}」——按${view.text !== null ? '文本' : '十六进制'}显示`;

  if (view.text !== null) {
    const lines = view.text.split('\n');
    const more = lines.length > TEXT_LINE_CAP;
    const shown = more ? lines.slice(0, TEXT_LINE_CAP) : lines;
    return (
      <div className="pp-viewer-box pp-viewer-hex">
        <div className="pp-viewer-note">
          {banner}
          {more && ` · 已截断：只显示前 ${TEXT_LINE_CAP} 行（文件更长）`}
        </div>
        <div className="pp-viewer-hex-text">
          <div className="pp-viewer-hex-gutter" aria-hidden="true">
            {shown.map((_, i) => i + 1).join('\n')}
          </div>
          <pre className="pp-viewer-hex-pre">
            <code>{shown.join('\n')}</code>
          </pre>
        </div>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(view.bytes.length / HEX_PAGE_BYTES));
  const current = Math.min(page, totalPages - 1);
  const start = current * HEX_PAGE_BYTES;
  const slice = view.bytes.subarray(start, Math.min(start + HEX_PAGE_BYTES, view.bytes.length));
  const rows: Array<{ offset: number; hex: string; ascii: string }> = [];
  for (let i = 0; i < slice.length; i += 16) {
    const chunk = slice.subarray(i, Math.min(i + 16, slice.length));
    rows.push({ offset: start + i, hex: hexLine(chunk), ascii: asciiLine(chunk) });
  }
  return (
    <div className="pp-viewer-box pp-viewer-hex">
      <div className="pp-viewer-note">
        {banner} · 只读前 {(view.bytes.length / 1024).toFixed(1)} KB · 第 {current + 1}/{totalPages} 页（每页 4 KB）
      </div>
      <div className="pp-viewer-hex-nav">
        <button type="button" onClick={() => setPage(Math.max(0, current - 1))} disabled={current === 0}>
          上一页
        </button>
        <button
          type="button"
          onClick={() => setPage(Math.min(totalPages - 1, current + 1))}
          disabled={current >= totalPages - 1}
        >
          下一页
        </button>
      </div>
      <table className="pp-viewer-hex-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.offset}>
              <td className="pp-viewer-hex-offset">{r.offset.toString(16).padStart(8, '0')}</td>
              <td className="pp-viewer-hex-bytes">{r.hex}</td>
              <td className="pp-viewer-hex-ascii">{r.ascii}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 兜底认领（`catchAll`）：无认领表——接的是「谁都没认领」那一档。
 *  `bytesKind: 'auto'` = 先文本行窗口（未知扩展名大多是文本 ⇒ 有界、无 base64 膨胀），
 *  文本读失败（真二进制）才走 read_base64；两条路都带体积闸。 */
export const hexViewer: ViewerDef = {
  id: VIEWER_CATCHALL_ID,
  exts: [],
  catchAll: true,
  needsBytes: true,
  bytesKind: 'auto',
  readLines: 4000,
  maxBytes: 256 * 1024,
  component: HexViewer,
};
