// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 归档查看器（P1 · B8 之一）——zip / tar / gz：**只列目录，不解压、不落盘**。
// 自绘解析（零依赖）：zip 走 EOCD + 中央目录；tar 走 512 字节头链；gz 走文件头 + ISIZE。
// 体积闸：中央目录在压缩包**尾部**，读口按行/整体读 ⇒ 大包只能整份进 IPC，
// 故 `maxBytes` 收到 8 MiB（超出 → 宿主出可读错误 + 文件壳，**不静默截断**）。
// 7z 需引库（= 重依赖，P2 级），本包不做——施工单 §11 记。

import { VIEWER_ARCHIVE_EXTS } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import { bytesOfDataUri, sizeText } from './bytes';
import './archive.css';

const { useMemo } = rendererHooks;

/** 条目显示上限（超出出横幅，不静默截断）。 */
const ENTRY_CAP = 500;

interface Entry {
  name: string;
  /** 原始大小（字节）；未知 = undefined（如 tar 的目录项 / gz 无名） */
  size?: number;
  /** 压缩后大小（zip 才有；用于压缩比读数） */
  packed?: number;
  kind?: string;
}

interface ArchiveView {
  kind: 'zip' | 'tar' | 'gz';
  entries: Entry[];
  error?: string;
  totalPacked?: number;
  totalSize?: number;
}

const decoder = new TextDecoder('utf-8');

/** zip：尾部 EOCD（0x06054b50，最多回扫 65557 字节）→ 中央目录逐条。 */
function parseZip(bytes: Uint8Array): Entry[] | string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return '不是有效的 ZIP（找不到中央目录结尾记录）';
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: Entry[] = [];
  for (let i = 0; i < count && p + 46 <= bytes.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return `ZIP 中央目录第 ${i + 1} 条签名不对（文件可能被截断）`;
    const packed = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, size, packed });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** tar：512 字节头链（name 0..100 / size 八进制 124..136 / typeflag 156）；两个零块结束。 */
function parseTar(bytes: Uint8Array): Entry[] | string {
  const out: Entry[] = [];
  let p = 0;
  let sawHeader = false;
  while (p + 512 <= bytes.length) {
    const block = bytes.subarray(p, p + 512);
    if (block.every((b) => b === 0)) break;
    const rawName = decoder.decode(block.subarray(0, 100)).replace(/\0.*$/, '');
    if (rawName.length === 0) break;
    const sizeText = decoder.decode(block.subarray(124, 136)).replace(/\0.*$/, '').trim();
    const size = /^[0-7]+$/.test(sizeText) ? Number.parseInt(sizeText, 8) : undefined;
    const type = String.fromCharCode(block[156] ?? 0);
    const prefix = decoder.decode(block.subarray(345, 500)).replace(/\0.*$/, '');
    out.push({
      name: prefix ? `${prefix}/${rawName}` : rawName,
      size: type === '5' ? undefined : size,
      kind: type === '5' ? '目录' : '文件',
    });
    sawHeader = true;
    const step = size != null ? 512 + Math.ceil(size / 512) * 512 : 512;
    p += step;
  }
  return sawHeader ? out : '不是有效的 TAR（没有读到任何 512 字节头）';
}

/** gz：头 10 字节（magic 1f 8b / CM=8 / FLG 的 FNAME 位带原文件名）；尾 4 字节 = 原始大小 LE。 */
function parseGz(bytes: Uint8Array): Entry[] | string {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return '不是有效的 GZIP（魔数不对）';
  const flg = bytes[3] ?? 0;
  let p = 10;
  let name: string | undefined;
  if (flg & 0x08) {
    const end = bytes.indexOf(0, p);
    name = decoder.decode(bytes.subarray(p, end < 0 ? bytes.length : end));
    p = (end < 0 ? bytes.length : end) + 1;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isize = dv.getUint32(bytes.length - 4, true);
  return [{ name: name || '（GZIP 未记录原文件名）', size: isize, packed: bytes.length, kind: '解压后' }];
}

function buildArchiveView(uri: string | undefined, ext: string): ArchiveView {
  const bytes = bytesOfDataUri(uri);
  if (bytes.length === 0)
    return { kind: 'gz', entries: [], error: '读取到的字节为空（文件可能是空的，或读口返回了非法 base64）' };
  const kind = (ext === 'zip' || ext === 'tar' || ext === 'gz' ? ext : 'zip') as ArchiveView['kind'];
  const parsed = kind === 'zip' ? parseZip(bytes) : kind === 'tar' ? parseTar(bytes) : parseGz(bytes);
  if (typeof parsed === 'string') return { kind, entries: [], error: parsed, totalPacked: bytes.length };
  const totalPacked = bytes.length;
  const totalSize = parsed.reduce((sum, e) => sum + (e.size ?? 0), 0);
  return { kind, entries: parsed, totalPacked, totalSize };
}

function ArchiveViewer({ ext, bytes }: ViewerProps) {
  const uri = bytes?.kind === 'data-uri' ? bytes.value : undefined;
  const view = useMemo(() => buildArchiveView(uri, ext), [uri, ext]);
  if (view.error) {
    return (
      <div className="pp-viewer-archive">
        <div className="pp-viewer-error">无法列出归档目录：{view.error}</div>
        <div className="pp-viewer-empty">只列目录、不解压——解析不了就不猜内容</div>
      </div>
    );
  }
  if (view.entries.length === 0) return <div className="pp-viewer-empty">归档里没有条目（0 项）</div>;
  const shown = view.entries.length > ENTRY_CAP ? view.entries.slice(0, ENTRY_CAP) : view.entries;
  return (
    <div className="pp-viewer-box pp-viewer-archive">
      <div className="pp-viewer-note">
        只列目录，不解压、不落盘 · {view.kind.toUpperCase()} · {view.entries.length} 条目
        {view.totalPacked != null && ` · 包体 ${sizeText(view.totalPacked)}`}
        {view.totalSize != null && view.totalSize > 0 && ` · 解压后约 ${sizeText(view.totalSize)}`}
        {view.entries.length > ENTRY_CAP && ` · 只列前 ${ENTRY_CAP} 条`}
      </div>
      <table className="pp-viewer-archive-table">
        <tbody>
          {shown.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 条目按目录序渲染（同名条目合法）
            <tr key={i}>
              <td className="pp-viewer-archive-name">{e.name}</td>
              <td className="pp-viewer-archive-kind">{e.kind ?? ''}</td>
              <td className="pp-viewer-archive-size">{e.size != null ? sizeText(e.size) : '—'}</td>
              <td className="pp-viewer-archive-size">
                {e.packed != null && e.size != null && e.size > 0 && e.packed < e.size
                  ? `压缩至 ${sizeText(e.packed)}`
                  : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const archiveViewer: ViewerDef = {
  id: 'archive',
  exts: VIEWER_ARCHIVE_EXTS,
  needsBytes: true,
  mimes: { zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip' },
  maxBytes: 8 * 1024 * 1024,
  component: ArchiveViewer,
};
