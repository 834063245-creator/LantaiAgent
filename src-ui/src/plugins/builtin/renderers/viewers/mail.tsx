// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 邮件查看器（渲染面补全 B13，2026-09-23）——RFC 5322 头字段（From / To / Cc / Subject /
// Date / Message-ID 有则显示）+ 正文 + 附件列表（`Content-Disposition: attachment` 的
// 文件名 / 内容类型 / 声明大小；附件本身走各自查看器，本件**不解码附件内容**）。
//
// 认领表真源 = `paper/viewer-exts.ts` 的 `VIEWER_MAIL_EXTS`；读取形态 = 文本行窗口
// （`bytesKind:'text'` + `readLines`，宿主按 `readLines + 1` 开窗——不整份进 IPC）。
//
// 正文取舍（**如实说明，不假装完整**）：
//   - `text/plain` 优先；`multipart/*` 取第一个 `text/plain` 部分并出提示
//     「MIME multipart：仅显示第 N 部分（共 M 部分）」——不静默只给一部分；
//   - 非 text/plain 的正文（text/html 等）按原文显示并注明类型（不做 HTML 渲染）；
//   - `Content-Transfer-Encoding: quoted-printable | base64` 解码（base64 走 `atob` +
//     `TextDecoder`——多字节 UTF-8 靠字节流解码，不是 `atob` 的 latin1 直读）；
//   - `Content-Type` 的 `charset` 生效；`TextDecoder` 不认这个标签 ⇒ 退 utf-8 **并说明**。
//
// 失败面**可读**（不空白、不 JSON 兜底）：头解析失败（没有分隔空行 / 没有一行是
// 「字段: 值」形态）⇒ 错误行 + **原文照显**（错误即导航：坏邮件也要能看到原样）。

import { VIEWER_MAIL_EXTS } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import './mail.css';

const { useMemo } = rendererHooks;

/** 行窗口（与注册面 `readLines` **同值**——宿主多读 1 行作「文件更长」判据）。 */
const MAIL_LINE_CAP = 4000;

/** 体积闸（近似：按窗口文本字符数判，与宿主同一口径）。 */
const MAIL_MAX_BYTES = 2 * 1024 * 1024;

/** MIME 展开深度上限（multipart 套 multipart 的常见形态是 mixed→alternative；更深不再展开）。 */
const MAX_MIME_DEPTH = 3;

/** 显示的头字段（有则显示；顺序 = 读信习惯，不是文件里的出现序）。 */
const HEADER_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['from', 'From'],
  ['to', 'To'],
  ['cc', 'Cc'],
  ['subject', 'Subject'],
  ['date', 'Date'],
  ['message-id', 'Message-ID'],
];

/** 头条目（**保序**：折叠续行接回上一条，字段序即原文序）。 */
type HeaderEntry = readonly [name: string, value: string];

interface ContentType {
  type: string;
  params: Record<string, string>;
}

interface MimePart {
  contentType: ContentType;
  disposition: ContentType;
  /** Content-Transfer-Encoding（小写；缺省 = 7bit 直读） */
  cte: string | undefined;
  filename: string | undefined;
  /** 原始未解码载荷 */
  payload: string;
}

interface MailAttachment {
  key: string;
  filename: string;
  contentType: string;
  sizeText: string;
}

interface MailView {
  fields: Array<{ label: string; value: string }>;
  bodyText: string;
  bodyNote?: string;
  attachments: MailAttachment[];
  /** 头解析失败的可读错误（有值 ⇒ 渲染原文照显分支） */
  error?: string;
  malformedHeaders: number;
  raw: string;
}

/** 失败原因（Error / 非 Error 都成句；空消息不落成空白）。 */
function reasonOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const text = String(e);
  return text === '[object Object]' ? '未知原因' : text;
}

/** 字节 → 读数（上限 MB 级；一位小数）。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 多条提示合成一行（缺省 = undefined，空串不占位）。 */
function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const kept = notes.filter((n): n is string => typeof n === 'string' && n.length > 0);
  return kept.length > 0 ? kept.join('；') : undefined;
}

/** 头字段取值（大小写不敏感；缺省 = undefined）。 */
function headerOf(entries: readonly HeaderEntry[], name: string): string | undefined {
  for (const [key, value] of entries) if (key.toLowerCase() === name) return value;
  return undefined;
}

/** 头块 → 条目表 + 无法解析的行数（**计数不吞**：渲染面出「N 行头部无法解析」）。 */
function parseHeaderBlock(block: string): { entries: HeaderEntry[]; malformed: number } {
  const entries: HeaderEntry[] = [];
  let malformed = 0;
  for (const line of block.split('\n')) {
    if (/^[ \t]/.test(line)) {
      // RFC 5322 折叠续行：接回上一条的值（原样保留单个空格）
      const last = entries.length > 0 ? entries[entries.length - 1] : null;
      if (last) entries[entries.length - 1] = [last[0], `${last[1]} ${line.trim()}`];
      else malformed++;
      continue;
    }
    const at = line.indexOf(':');
    if (at <= 0) {
      malformed++;
      continue;
    }
    entries.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return { entries, malformed };
}

/** `type; key=value; key2="value2"` → 类型 + 参数表（引号剥离）。 */
function parseParams(raw: string): ContentType {
  const segments = raw.split(';');
  const type = (segments.shift() ?? '').trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq < 0) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    let value = segment.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key.length > 0 && value.length > 0) params[key] = value;
  }
  return { type, params };
}

function contentTypeOf(entries: readonly HeaderEntry[]): ContentType {
  const raw = headerOf(entries, 'content-type');
  return raw ? parseParams(raw) : { type: '', params: {} };
}

/** RFC 2231 扩展参数（`UTF-8''%E4%B8%AD`）——CJK 附件名靠它，按声明字符集解码。 */
function decodeRfc2231(raw: string): string {
  const first = raw.indexOf("'");
  const second = first >= 0 ? raw.indexOf("'", first + 1) : -1;
  if (first < 0 || second < 0) return raw;
  const charset = raw.slice(0, first);
  const encoded = raw.slice(second + 1);
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const hex = encoded.slice(i + 1, i + 3);
    if (encoded[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    bytes.push(encoded.charCodeAt(i));
  }
  return decodeBytes(new Uint8Array(bytes), charset).text;
}

/** 附件名：Content-Disposition 的 filename / filename* 优先，退 Content-Type 的 name。 */
function filenameOf(entries: readonly HeaderEntry[]): string | undefined {
  const disposition = headerOf(entries, 'content-disposition');
  const contentType = headerOf(entries, 'content-type');
  const params = disposition ? parseParams(disposition).params : {};
  const extended = params['filename*'];
  const plain = params.filename ?? (contentType ? parseParams(contentType).params.name : undefined);
  const name = extended ? decodeRfc2231(extended) : plain;
  return name && name.length > 0 ? name : undefined;
}

/** 一个 MIME 块（首部 + 载荷）→ 结构化部分。 */
function splitPart(chunk: string): MimePart {
  const at = chunk.indexOf('\n\n');
  const head = at < 0 ? '' : chunk.slice(0, at);
  const payload = at < 0 ? chunk : chunk.slice(at + 2);
  const { entries } = parseHeaderBlock(head);
  return {
    contentType: contentTypeOf(entries),
    disposition: parseParams(headerOf(entries, 'content-disposition') ?? ''),
    cte: headerOf(entries, 'content-transfer-encoding')?.trim().toLowerCase(),
    filename: filenameOf(entries),
    payload,
  };
}

/** `multipart` 体 → 各分块原文（前导 preamble 丢弃；缺收尾边界时容忍取到文末）。 */
function splitMimeParts(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const parts: string[][] = [];
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    if (line.startsWith(marker)) {
      const rest = line.slice(marker.length).trim();
      if (rest === '--') {
        if (current) parts.push(current);
        current = null;
        break;
      }
      if (current) parts.push(current);
      current = [];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) parts.push(current);
  return parts.map((lines) => lines.join('\n'));
}

/** 递归展开到叶子部分（嵌套 multipart 是常见形态：mixed→alternative）；超深度按叶子计。 */
function collectLeaves(part: MimePart, out: MimePart[], depth: number): void {
  const { type, params } = part.contentType;
  if (depth < MAX_MIME_DEPTH && type.startsWith('multipart/') && params.boundary) {
    for (const chunk of splitMimeParts(part.payload, params.boundary)) {
      collectLeaves(splitPart(chunk), out, depth + 1);
    }
    return;
  }
  out.push(part);
}

/** 载荷 → 字节数（base64 / quoted-printable 按解码后算，其余按字符数近似）。 */
function payloadBytes(payload: string, cte: string | undefined): number {
  if (cte === 'base64') {
    const clean = payload.replace(/\s+/g, '');
    const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
  }
  if (cte === 'quoted-printable') return qpToBytes(payload).length;
  return payload.trimEnd().length;
}

function base64ToBytes(payload: string): Uint8Array {
  const binary = atob(payload.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** quoted-printable → 字节（`=XX` 十六进制 + `=` 软换行；非转义的 `=` 原样保留）。 */
function qpToBytes(payload: string): Uint8Array {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal.length === 0) return;
    for (const b of encoder.encode(literal)) bytes.push(b);
    literal = '';
  };
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (ch !== '=') {
      literal += ch;
      continue;
    }
    const next = payload[i + 1];
    if (next === '\n') {
      i += 1;
      continue;
    }
    if (next === '\r' && payload[i + 2] === '\n') {
      i += 2;
      continue;
    }
    const hex = payload.slice(i + 1, i + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      flush();
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    literal += '=';
  }
  flush();
  return new Uint8Array(bytes);
}

/** 字节流 → 文本（charset 生效；`TextDecoder` 不认这个标签 ⇒ 退 utf-8 **并说明**）。 */
function decodeBytes(bytes: Uint8Array, charset: string | undefined): { text: string; note?: string } {
  const label = (charset ?? '').trim().toLowerCase() || 'utf-8';
  try {
    return { text: new TextDecoder(label).decode(bytes) };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), note: `charset=${label} 不受支持——已按 utf-8 解码` };
  }
}

/** 载荷 → 正文文本（按 Content-Transfer-Encoding 解码；失败 ⇒ 原文 + 可读说明）。 */
function decodePayload(
  payload: string,
  cte: string | undefined,
  charset: string | undefined,
): { text: string; note?: string } {
  if (cte === 'base64') {
    try {
      return decodeBytes(base64ToBytes(payload), charset);
    } catch (e) {
      return { text: payload.trimEnd(), note: `base64 解码失败（${reasonOf(e)}）——已按原文显示` };
    }
  }
  if (cte === 'quoted-printable') return decodeBytes(qpToBytes(payload), charset);
  return { text: payload.replace(/^\n+/, '').trimEnd() };
}

/** 邮件原文 → 视图（纯函数：头解析 + MIME 分块 + 正文取舍 + 附件清单）。 */
function parseMail(raw: string): MailView {
  const text = raw.replace(/\r\n?/g, '\n');
  const blank: MailView = { fields: [], bodyText: '', attachments: [], malformedHeaders: 0, raw: text };
  const sep = text.indexOf('\n\n');
  if (sep < 0) {
    return { ...blank, error: '邮件头解析失败：没找到头部与正文的分隔空行（SMTP 头以空行结束）' };
  }
  const head = text.slice(0, sep);
  const body = text.slice(sep + 2);
  const { entries, malformed } = parseHeaderBlock(head);
  if (entries.length === 0) {
    return {
      ...blank,
      malformedHeaders: malformed,
      error: `邮件头解析失败：没有一行是「字段: 值」形态（前 120 字符：${head.slice(0, 120)}）`,
    };
  }

  const fields = HEADER_FIELDS.map(([key, label]) => ({ label, value: headerOf(entries, key) ?? '' })).filter(
    (field) => field.value.length > 0,
  );
  const ct = contentTypeOf(entries);
  const cte = headerOf(entries, 'content-transfer-encoding')?.trim().toLowerCase();
  const disposition = parseParams(headerOf(entries, 'content-disposition') ?? '');
  const attachments: MailAttachment[] = [];
  const asAttachment = (part: MimePart): MailAttachment => ({
    key: `att-${attachments.length}`,
    filename: part.filename ?? '（未命名附件）',
    contentType: part.contentType.type || 'application/octet-stream',
    sizeText: `约 ${formatBytes(payloadBytes(part.payload, part.cte))}`,
  });

  let bodyText = '';
  let bodyNote: string | undefined;
  if (ct.type.startsWith('multipart/') && ct.params.boundary) {
    const leaves: MimePart[] = [];
    for (const chunk of splitMimeParts(body, ct.params.boundary)) collectLeaves(splitPart(chunk), leaves, 0);
    for (const part of leaves) {
      // 附件判据：显式 `attachment`；或**没有 Disposition**却带文件名（`Content-Type: name=` 的老形态）。
      // `inline` 部分不列（正文内嵌图不是附件，混进清单会把「有几件附件」说假）。
      const isAttachment = part.disposition.type === 'attachment' || (part.disposition.type === '' && !!part.filename);
      if (isAttachment) attachments.push(asAttachment(part));
    }
    const at = leaves.findIndex((part) => part.contentType.type === 'text/plain');
    if (at >= 0) {
      const chosen = leaves[at];
      const decoded = decodePayload(chosen.payload, chosen.cte, chosen.contentType.params.charset);
      bodyText = decoded.text;
      bodyNote = joinNotes(`MIME multipart：仅显示第 ${at + 1} 部分（共 ${leaves.length} 部分）`, decoded.note);
    } else {
      const tail = attachments.length > 0 ? '，附件见下' : '';
      bodyNote = `MIME multipart：没有 text/plain 部分可显示（共 ${leaves.length} 部分${tail}）`;
    }
  } else if (ct.type.startsWith('multipart/')) {
    bodyNote = 'MIME multipart 缺 boundary 参数——按原文显示正文';
    bodyText = body.replace(/^\n+/, '').trimEnd();
  } else if (disposition.type === 'attachment') {
    attachments.push({
      key: 'att-0',
      filename: filenameOf(entries) ?? '（未命名附件）',
      contentType: ct.type || 'application/octet-stream',
      sizeText: `约 ${formatBytes(payloadBytes(body, cte))}`,
    });
    bodyNote = '整封邮件是附件（Content-Disposition: attachment）——没有正文';
  } else {
    const decoded = decodePayload(body, cte, ct.params.charset);
    bodyText = decoded.text;
    bodyNote = joinNotes(
      ct.type && ct.type !== 'text/plain' ? `正文类型 ${ct.type}——按原文显示（不做渲染）` : undefined,
      decoded.note,
    );
  }

  return { fields, bodyText, bodyNote, attachments, malformedHeaders: malformed, raw: text };
}

function MailViewer({ bytes, mode }: ViewerProps) {
  const text = bytes?.kind === 'text' ? bytes.value : '';
  const view = useMemo(() => parseMail(text), [text]);
  // 邮件没有放大形态（浮层由宿主渲染，但「点击看大图」语义对信文无意义）
  if (mode === 'overlay') return null;
  if (text.trim().length === 0) return <div className="pp-viewer-empty">邮件为空（文件无内容）</div>;
  if (view.error) {
    return (
      <div className="pp-viewer-mail">
        <div className="pp-viewer-error">{view.error}</div>
        <div className="pp-viewer-box">
          <div className="pp-viewer-note">原文照显（头解析失败，不做字段拆分）</div>
          <pre className="pp-viewer-mail-raw">{view.raw}</pre>
        </div>
      </div>
    );
  }
  return (
    <div className="pp-viewer-mail">
      <div className="pp-viewer-mail-head">
        {view.fields.map((field) => (
          <div key={field.label} className="pp-viewer-mail-field">
            <span className="pp-viewer-mail-fieldName">{field.label}</span>
            <span className="pp-viewer-mail-fieldValue">{field.value}</span>
          </div>
        ))}
        {view.malformedHeaders > 0 && (
          <div className="pp-viewer-mail-field">
            <span className="pp-viewer-mail-fieldName">注意</span>
            <span className="pp-viewer-mail-fieldValue">{view.malformedHeaders} 行头部无法解析（已忽略）</span>
          </div>
        )}
      </div>
      <div className="pp-viewer-box">
        {view.bodyNote && <div className="pp-viewer-note">{view.bodyNote}</div>}
        <pre className="pp-viewer-mail-body">{view.bodyText.length > 0 ? view.bodyText : '（无 text/plain 正文）'}</pre>
      </div>
      {view.attachments.length > 0 && (
        <div className="pp-viewer-mail-attach">
          <div className="pp-viewer-mail-attachTitle">
            附件 {view.attachments.length} 个（只列名与声明大小，不解码内容）
          </div>
          <ul className="pp-viewer-mail-attachList">
            {view.attachments.map((att) => (
              <li key={att.key} className="pp-viewer-mail-attachItem">
                <span className="pp-viewer-mail-attachName">{att.filename}</span>
                <span className="pp-viewer-mail-attachType">{att.contentType}</span>
                <span className="pp-viewer-mail-attachSize">{att.sizeText}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export const mailViewer: ViewerDef = {
  id: 'mail',
  exts: VIEWER_MAIL_EXTS,
  needsBytes: true,
  bytesKind: 'text',
  readLines: MAIL_LINE_CAP,
  maxBytes: MAIL_MAX_BYTES,
  component: MailViewer,
};
