// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 电子书查看器（渲染面补全 P3 · B11）——epub = ZIP + `container.xml` + OPF + XHTML，
// **零新依赖**（不引 epubjs）：
//   EOCD + 中央目录自绘（与 B8 归档查看器同族手法，区别是本件要**取条目内容**）
//   → 条目内容：`method 0` 直取 / `method 8` 走 WebView2·Chromium 原生
//     `DecompressionStream('deflate-raw')`
//   → `META-INF/container.xml` 的 `<rootfile full-path>` → OPF（manifest + spine）
//   → 逐章 XHTML 用 `DOMParser` 抽标题（h1..h3，取不到则用文件名）与正文段落
//     （结构化取块级文本，**不是**一整坨 pre）。
// 认领表真源 = `paper/viewer-exts.ts` 的 `VIEWER_EPUB_EXTS`（宿主层单一真源）；
// 阅读顺序 = **spine 序**（目录列表 + 上一章/下一章），不用 `nav.xhtml`/NCX 的层级。
//
// 两段读取（体积纪律）：开卷只为取章节标题把每章解压一遍（目录要显示真标题而不是文件名），
// 正文**按需解压**（切章时只读当前这一章）。单章正文超 `CHAPTER_CHAR_CAP` 截断 + 吸顶横幅。
//
// 本件**不做**、也不假装支持的（遇到时按可读错误/空态说话）：
//   DRM·加密封装（含加密字体）·EPUB 内嵌 CSS 样式 · 内嵌图片/字体等资源 · 脚注跳转 ·
//   `nav.xhtml` 的层级目录（目录 = spine 平铺）· 非 UTF-8 的条目名（按 UTF-8 宽容读）。
//
// 失败面一律一行可读、点明哪一步哪个文件：非 ZIP / 无 `container.xml` / 无 `<rootfile>` /
// OPF 不在包内 / OPF 非法 / 无 `<spine>`（空 spine 出空态）/ 条目加密 / 压缩方式不支持 /
// 条目解压失败 / 环境没有 `DecompressionStream`（jsdom 即这一档；真机由 WebView2 原生覆盖）。

import { VIEWER_EPUB_EXTS } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import { bytesOfDataUri, sizeText, strictUtf8 } from './bytes';
import './epub.css';

const { useEffect, useMemo, useState } = rendererHooks;

/** 中央目录扫描上限 = 章节扫描上限（超出**如实标注**，不静默截断）。 */
const SCAN_CAP = 2000;

/** 单章正文上限（字符）——超出截断 + 吸顶横幅（`.pp-viewer-note`）。 */
const CHAPTER_CHAR_CAP = 200_000;

/** 体积闸（宿主 preflight 拦 + 读后复核；超出 ⇒ 可读错误 + 文件壳，不静默截断）。 */
const EPUB_MAX_BYTES = 32 * 1024 * 1024;

/** EPUB 容器固定入口（OPF 2 / 3 一致）。 */
const CONTAINER_PATH = 'META-INF/container.xml';

/** 正文块级元素（嵌套块只取最外层——`blockquote > p` / `li > p` 不重复取）。 */
const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, pre';

/** 书级说明行上限（一本 300 章都非 UTF-8 的书不该把提示行撑成正文）。 */
const NOTE_CAP = 5;

const utf8Loose = new TextDecoder('utf-8');

/** 错误 → 一行可读文本（`TypeError` 在浏览器里 message 常为空，不留空话）。 */
function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return '未知错误（环境未给出原因）';
}

/** 空白归一（含全角空格 U+3000——CJK 排版里它不是空白，会让段落粘连）。 */
function collapse(text: string): string {
  return text.replace(/[\s\u3000]+/g, ' ').trim();
}

/* ── ZIP（EOCD + 中央目录 + 本地头）──────────────────────────────────────────── */

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
  /** 通用位 bit0 = 加密（DRM / 加密封装——本查看器不持解密能力，按可读错误说话）。 */
  encrypted: boolean;
}

interface ZipIndex {
  entries: ZipEntry[];
  /** 中央目录声明的总条目数（`entries` 被 `SCAN_CAP` 截过时二者不等） */
  total: number;
}

/** EOCD（`0x06054b50`，最多回扫 65557 字节）→ 中央目录逐条（签名 `0x02014b50`）。 */
function parseCentralDirectory(bytes: Uint8Array): ZipIndex {
  if (bytes.length < 22) throw new Error('不是有效的 EPUB（ZIP 容器）：文件太短，放不下中央目录结尾记录');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 EPUB（ZIP 容器）：找不到中央目录结尾记录（EOCD）');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const count = Math.min(total, SCAN_CAP);
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length) throw new Error(`ZIP 中央目录第 ${i + 1} 条越界（文件被截断？）`);
    if (dv.getUint32(p, true) !== 0x02014b50) {
      throw new Error(`ZIP 中央目录第 ${i + 1} 条签名不对（文件可能被截断）`);
    }
    const flags = dv.getUint16(p + 8, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    entries.push({
      name: utf8Loose.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      method: dv.getUint16(p + 10, true),
      compSize: dv.getUint32(p + 20, true),
      uncompSize: dv.getUint32(p + 24, true),
      localOffset: dv.getUint32(p + 42, true),
      encrypted: (flags & 0x1) !== 0,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, total };
}

/** 本地头（`0x04034b50`）→ 数据段区间——名字/额外字段长度**以本地头为准**
 *  （它与中央目录可以不等；拿中央目录的长度去切片会错位）。 */
function localDataRange(bytes: Uint8Array, entry: ZipEntry): { start: number; end: number } {
  const at = entry.localOffset;
  if (at + 30 > bytes.length) throw new Error(`条目「${entry.name}」的本地头越界（文件被截断？）`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(at, true) !== 0x04034b50) {
    throw new Error(`条目「${entry.name}」的本地头签名不对（文件可能被截断）`);
  }
  const nameLen = dv.getUint16(at + 26, true);
  const extraLen = dv.getUint16(at + 28, true);
  const start = at + 30 + nameLen + extraLen;
  if (start > bytes.length) throw new Error(`条目「${entry.name}」的数据段起点越界（文件被截断？）`);
  return { start, end: Math.min(start + entry.compSize, bytes.length) };
}

/** 环境没有解压能力（jsdom 即这一档；真机由 WebView2/Chromium 原生覆盖）。 */
const NO_DEFLATE = '当前环境不支持 deflate 解压（DecompressionStream 不可用）';

/** 读干一个 ReadableStream（`deflate-raw` 的排空段）。 */
async function readAllChunks(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** 压缩数据 → 原始字节（原生 `DecompressionStream('deflate-raw')`）。
 *  先起读、后写：压缩变换靠读端排空，写完再读会在大条目上互相等（背压死锁）。 */
async function inflateRaw(raw: Uint8Array, name: string): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: new (format: string) => DecompressionStream })
    .DecompressionStream;
  if (typeof Ctor !== 'function') throw new Error(`${NO_DEFLATE}——无法解压「${name}」`);
  let stream: DecompressionStream;
  try {
    stream = new Ctor('deflate-raw');
  } catch {
    throw new Error(`${NO_DEFLATE}（本环境的 DecompressionStream 不接受 deflate-raw）——无法解压「${name}」`);
  }
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const drained = readAllChunks(reader);
  try {
    // TS 6 起 `Uint8Array` 默认 `ArrayBufferLike`（含 SharedArrayBuffer），而 streams 的
    // `BufferSource` 只收 `ArrayBuffer` 背书的视图：本项目字节一律来自 `new Uint8Array`
    // （非共享），按仓库先例（image-intake.ts）在边界收窄一次类型——**不复制字节**
    // （注意必须带上 byteOffset/length：`raw` 是整包上的子视图，拿 `raw.buffer` 写会把整包写进去）。
    const view = new Uint8Array(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength);
    await writer.write(view);
    await writer.close();
    return await drained;
  } catch {
    await reader.cancel().catch(() => undefined);
    await drained.catch(() => undefined);
    throw new Error(`条目「${name}」deflate 解压失败——数据不是有效的 deflate 流`);
  }
}

/** 条目内容（加密 / 压缩方式 / 尺寸三类失败各给可读原因，绝不静默给空数组）。 */
async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.encrypted) throw new Error(`条目「${entry.name}」是加密条目（DRM/加密封装本查看器不支持）`);
  const range = localDataRange(bytes, entry);
  const raw = bytes.subarray(range.start, range.end);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    if (entry.compSize === 0 && entry.uncompSize > 0) {
      throw new Error(`条目「${entry.name}」没有压缩后大小（流式写入的 ZIP？本查看器按中央目录取尺寸）`);
    }
    return inflateRaw(raw, entry.name);
  }
  throw new Error(`条目「${entry.name}」的压缩方式 ${entry.method} 不支持（只支持 0=直存 / 8=deflate）`);
}

/** 条目内容 → 文本（OPF / container 这类 XML 必须是 UTF-8：解不出就是可读错误）。 */
async function readEntryText(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const text = strictUtf8(await readEntry(bytes, entry));
  if (text === null) throw new Error(`条目「${entry.name}」不是 UTF-8 文本（EPUB 的 XML 必须是 UTF-8）`);
  return text;
}

/* ── XHTML / XML 解析（`DOMParser`——只解析字符串，不自建游离 DOM）──────────────── */

function hasParserError(doc: Document): boolean {
  const root = doc.documentElement;
  if (root && root.localName === 'parsererror') return true;
  return doc.getElementsByTagName('parsererror').length > 0;
}

/** XML（container / OPF）严格解析：不合法 ⇒ 可读错误（带是哪个文件）。 */
function parseXmlOrThrow(text: string, what: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (hasParserError(doc)) throw new Error(`${what} 不是合法 XML（解析失败）`);
  return doc;
}

interface ChapterDoc {
  doc: Document;
  /** 章节标题（首个 h1..h3；没有 = null → 调用方用文件名） */
  title: string | null;
  /** 宽容处理说明（非 UTF-8 / 非合法 XHTML）；null = 一切正常 */
  note: string | null;
}

/** 章节 XHTML → 文档。严格 XHTML 优先；不合法退 HTML 宽容解析并**说明**（不静默降级）。 */
function parseChapterDoc(raw: Uint8Array): ChapterDoc {
  const strict = strictUtf8(raw);
  const text = strict ?? utf8Loose.decode(raw);
  const notes: string[] = [];
  if (strict === null) notes.push('不是合法 UTF-8——已按宽容解码（字符可能有误）');
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, 'application/xhtml+xml');
  const forgiving = hasParserError(xmlDoc);
  const doc = forgiving ? parser.parseFromString(text, 'text/html') : xmlDoc;
  if (forgiving) notes.push('不是合法 XHTML——已按 HTML 宽容解析');
  // 脚本/样式不是正文（留着会被段落抽取与整段兜底读进去）
  for (const el of [...doc.getElementsByTagName('script'), ...doc.getElementsByTagName('style')]) el.remove();
  return { doc, title: extractChapterTitle(doc), note: notes.length > 0 ? notes.join('；') : null };
}

/** 章节标题 = 首个非空 h1..h3（取不到 = null，调用方退文件名）。 */
function extractChapterTitle(doc: Document): string | null {
  for (const tag of ['h1', 'h2', 'h3']) {
    const text = collapse(doc.getElementsByTagName(tag)[0]?.textContent ?? '');
    if (text) return text;
  }
  return null;
}

/** 正文块（`level` = 标题层级 1..6；0 = 普通段落——标题也是正文，别丢）。 */
interface Block {
  text: string;
  level: number;
}

/** 正文块（块级元素的最外层文本，**标题按层级留着**；一个块都没有时退整篇文本，绝不静默空白）。 */
function extractBlocks(doc: Document): Block[] {
  const body = doc.getElementsByTagName('body')[0] ?? doc.documentElement;
  if (!body) return [];
  const out: Block[] = [];
  for (const el of body.querySelectorAll(BLOCK_SELECTOR)) {
    if (el.parentElement?.closest(BLOCK_SELECTOR)) continue; // 嵌套块只取最外层
    const text = collapse(el.textContent ?? '');
    if (!text) continue;
    const head = /^h([1-6])$/.exec(el.localName);
    out.push({ text, level: head?.[1] ? Number(head[1]) : 0 });
  }
  if (out.length === 0) {
    const flat = collapse(body.textContent ?? '');
    if (flat) out.push({ text: flat, level: 0 });
  }
  return out;
}

/** OPF 元数据取值（按 localName 找——`dc:title` 换个前缀也认）。 */
function firstElementText(doc: Document, localName: string): string | null {
  for (const el of doc.getElementsByTagName('*')) {
    if (el.localName !== localName) continue;
    const text = collapse(el.textContent ?? '');
    if (text) return text;
  }
  return null;
}

/* ── OPF / spine ────────────────────────────────────────────────────────────── */

/** href / full-path → 压缩包内路径（去锚点、解百分号编码、吃掉 `./` 与 `..`）。 */
function resolveZipPath(baseFile: string, href: string): string {
  const cut = href.split('#')[0] ?? '';
  let rel = cut;
  try {
    rel = decodeURIComponent(cut);
  } catch {
    rel = cut; // 名字里有裸 `%`（非法编码）——按原样用，别把路径整条丢掉
  }
  if (rel.startsWith('/')) return normalizeSegments(rel.slice(1));
  const at = baseFile.lastIndexOf('/');
  return normalizeSegments(`${at >= 0 ? baseFile.slice(0, at + 1) : ''}${rel}`);
}

function normalizeSegments(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** 压缩包内路径 → 章节名（XHTML 里没有 h1..h3 时的兜底标题）。 */
function fileNameOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

interface Chapter {
  /** 章节文件在压缩包内的路径（经 OPF 目录解析 + 归一） */
  name: string;
  /** 目录标题（首个 h1..h3；取不到 = 文件名） */
  title: string;
  /** 标题来自文件名（目录里用淡墨标出——不冒充真标题） */
  fromName: boolean;
}

interface Book {
  title: string;
  creator: string | null;
  opfPath: string;
  chapters: Chapter[];
  /** 书级说明（条目上限 / 悬空 itemref / 宽容解析…）——如实标注 */
  notes: string[];
  zip: Uint8Array;
  byPath: Map<string, ZipEntry>;
}

function capNotes(notes: string[]): string[] {
  if (notes.length <= NOTE_CAP) return notes;
  return [...notes.slice(0, NOTE_CAP), `另有 ${notes.length - NOTE_CAP} 条同类说明（略）`];
}

/** epub 字节 → 书（zip → container.xml → OPF → spine → 逐章标题）。失败 = 可读 `Error`。 */
async function openEpub(zip: Uint8Array): Promise<Book> {
  const index = parseCentralDirectory(zip);
  const byPath = new Map(index.entries.map((e) => [e.name, e]));
  const notes: string[] = [];
  if (index.total > index.entries.length) {
    notes.push(`压缩包共 ${index.total} 条目——只读前 ${SCAN_CAP} 条（超出部分不参与解析）`);
  }

  const containerEntry = byPath.get(CONTAINER_PATH);
  if (!containerEntry) throw new Error(`缺少 ${CONTAINER_PATH}（不是有效的 EPUB 容器）`);
  const containerDoc = parseXmlOrThrow(await readEntryText(zip, containerEntry), CONTAINER_PATH);
  const opfPath = (containerDoc.getElementsByTagName('rootfile')[0]?.getAttribute('full-path') ?? '').trim();
  if (!opfPath) throw new Error(`${CONTAINER_PATH} 里没有 <rootfile full-path>——无法定位 OPF`);
  const opfEntry = byPath.get(normalizeSegments(opfPath));
  if (!opfEntry) throw new Error(`OPF 不在压缩包内：${opfPath}（${CONTAINER_PATH} 指向的文件缺失）`);
  const opfDoc = parseXmlOrThrow(await readEntryText(zip, opfEntry), `OPF（${opfPath}）`);

  const manifest = new Map<string, string>();
  for (const item of opfDoc.getElementsByTagName('item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) manifest.set(id, resolveZipPath(opfPath, href));
  }
  if (!opfDoc.getElementsByTagName('spine')[0]) {
    throw new Error(`OPF（${opfPath}）里没有 <spine>——不是有效的 EPUB 包`);
  }
  const spine: string[] = [];
  let dangling = 0;
  for (const ref of opfDoc.getElementsByTagName('itemref')) {
    const idref = ref.getAttribute('idref');
    const path = idref ? manifest.get(idref) : undefined;
    if (!path || !byPath.has(path)) {
      dangling++;
      continue;
    }
    spine.push(path);
  }
  if (dangling > 0) notes.push(`spine 里 ${dangling} 条 itemref 找不到对应文件（已跳过）`);

  const chapters: Chapter[] = [];
  const scan = Math.min(spine.length, SCAN_CAP);
  if (spine.length > scan) notes.push(`spine 共 ${spine.length} 章——目录只取前 ${scan} 章`);
  for (let i = 0; i < scan; i++) {
    const name = spine[i];
    let fileTitle: string | null = null;
    const entry = byPath.get(name);
    if (entry) {
      try {
        const parsed = parseChapterDoc(await readEntry(zip, entry));
        fileTitle = parsed.title;
        if (parsed.note) notes.push(`「${name}」${parsed.note}`);
      } catch {
        // 取不到标题不拦开卷：切到该章时正文路径会给出带文件名的可读错误（不静默）
        fileTitle = null;
      }
    }
    chapters.push({ name, title: fileTitle ?? fileNameOf(name), fromName: fileTitle === null });
  }

  return {
    title: firstElementText(opfDoc, 'title') ?? '',
    creator: firstElementText(opfDoc, 'creator'),
    opfPath,
    chapters,
    notes: capNotes(notes),
    zip,
    byPath,
  };
}

/* ── 章节正文（按需解压 + 截断）────────────────────────────────────────────── */

interface ChapterBody {
  title: string | null;
  blocks: Block[];
  truncated: boolean;
  note: string | null;
}

/** 单章正文（切章时读这一章；超 `CHAPTER_CHAR_CAP` 截断——截断可见，不静默）。 */
async function loadChapterBody(book: Book, name: string): Promise<ChapterBody> {
  const entry = book.byPath.get(name);
  if (!entry) throw new Error(`章节文件不在压缩包内：${name}`);
  const parsed = parseChapterDoc(await readEntry(book.zip, entry));
  const blocks: Block[] = [];
  let used = 0;
  let truncated = false;
  for (const block of extractBlocks(parsed.doc)) {
    if (used >= CHAPTER_CHAR_CAP) {
      truncated = true;
      break;
    }
    const room = CHAPTER_CHAR_CAP - used;
    if (block.text.length > room) {
      blocks.push({ text: `${block.text.slice(0, room)}…`, level: block.level });
      truncated = true;
      break;
    }
    blocks.push(block);
    used += block.text.length;
  }
  return { title: parsed.title, blocks, truncated, note: parsed.note };
}

/* ── 组件 ──────────────────────────────────────────────────────────────────── */

type OpenState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; book: Book }
  | { status: 'error'; message: string };

type ChapterState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; title: string | null; blocks: Block[]; truncated: boolean; note: string | null }
  | { status: 'error'; message: string };

function EpubViewer({ bytes, mode }: ViewerProps) {
  const uri = bytes?.kind === 'data-uri' ? bytes.value : undefined;
  const zip = useMemo(() => bytesOfDataUri(uri), [uri]);
  const [open, setOpen] = useState<OpenState>({ status: 'loading' });
  const [at, setAt] = useState(0);
  const [chapter, setChapter] = useState<ChapterState>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    if (zip.length === 0) {
      setOpen({ status: 'empty' });
      return;
    }
    setOpen({ status: 'loading' });
    openEpub(zip).then(
      (book) => {
        if (!cancelled) setOpen({ status: 'ready', book });
      },
      (err: unknown) => {
        if (!cancelled) setOpen({ status: 'error', message: messageOf(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [zip]);

  const book = open.status === 'ready' ? open.book : null;
  const chapters = book?.chapters ?? [];
  const current = chapters.length > 0 ? Math.min(at, chapters.length - 1) : 0;
  const currentName = chapters[current]?.name;

  useEffect(() => {
    if (!book || currentName === undefined) {
      setChapter({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setChapter({ status: 'loading' });
    loadChapterBody(book, currentName).then(
      (body) => {
        if (!cancelled) setChapter({ status: 'ready', ...body });
      },
      (err: unknown) => {
        if (!cancelled) setChapter({ status: 'error', message: `无法读取章节「${currentName}」：${messageOf(err)}` });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [book, currentName]);

  // 纯文本阅读没有放大形态（浮层由宿主渲染，「点击看大图」语义对正文无意义）
  if (mode === 'overlay') return null;
  if (open.status === 'empty') {
    return <div className="pp-viewer-empty">读取到的字节为空（文件可能是空的，或读口返回了非法 base64）</div>;
  }
  if (open.status === 'loading') return <div className="pp-viewer-empty">正在解析 EPUB…</div>;
  if (open.status === 'error') return <div className="pp-viewer-error">无法解析 EPUB：{open.message}</div>;
  if (chapters.length === 0) {
    return <div className="pp-viewer-empty">EPUB 的 spine 为空——没有可读章节（0 章）</div>;
  }

  const identity = [book?.title, book?.creator].filter((part): part is string => Boolean(part)).join(' · ');
  const tocNote = [`目录 · ${chapters.length} 章`, ...(book?.notes ?? [])].join(' · ');
  const bodyParts = [`第 ${current + 1}/${chapters.length} 章`];
  if (chapter.status === 'ready') {
    if (chapter.title) bodyParts.push(chapter.title);
    if (chapter.truncated) bodyParts.push(`已截断：只显示前 ${CHAPTER_CHAR_CAP} 字（本章更长）`);
    if (chapter.note && currentName) bodyParts.push(`「${currentName}」${chapter.note}`);
  }

  return (
    <div className="pp-viewer-epub">
      <nav className="pp-viewer-box pp-viewer-epub-toc" aria-label="章节目录">
        <div className="pp-viewer-note">{tocNote}</div>
        <ol className="pp-viewer-epub-tocList">
          {chapters.map((chapterAt, i) => (
            <li key={chapterAt.name}>
              <button
                type="button"
                className={`pp-viewer-epub-tocItem${i === current ? ' pp-viewer-epub-tocItem-on' : ''}${
                  chapterAt.fromName ? ' pp-viewer-epub-tocItem-fromName' : ''
                }`}
                aria-current={i === current ? 'true' : undefined}
                onClick={() => setAt(i)}
              >
                <span className="pp-viewer-epub-tocNo">{i + 1}</span>
                <span className="pp-viewer-epub-tocName">{chapterAt.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <section className="pp-viewer-box pp-viewer-epub-body">
        <div className="pp-viewer-note">{bodyParts.join(' · ')}</div>
        <div className="pp-viewer-epub-nav">
          <button
            type="button"
            onClick={() => setAt(Math.max(0, current - 1))}
            disabled={current === 0}
            className="pp-viewer-epub-navBtn"
          >
            上一章
          </button>
          <button
            type="button"
            onClick={() => setAt(Math.min(chapters.length - 1, current + 1))}
            disabled={current >= chapters.length - 1}
            className="pp-viewer-epub-navBtn"
          >
            下一章
          </button>
        </div>
        {chapter.status === 'error' ? (
          <div className="pp-viewer-error">{chapter.message}</div>
        ) : chapter.status === 'ready' && chapter.blocks.length > 0 ? (
          <div className="pp-viewer-epub-text">
            {chapter.blocks.map((block, i) => {
              const cls =
                block.level > 0 ? `pp-viewer-epub-h pp-viewer-epub-h${Math.min(block.level, 4)}` : 'pp-viewer-epub-p';
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: 块按文档序渲染（同文块合法重复，无稳定 id）
                <p key={i} className={cls}>
                  {block.text}
                </p>
              );
            })}
          </div>
        ) : chapter.status === 'ready' ? (
          <div className="pp-viewer-empty">本章没有可显示的文本（可能是封面/图片页——本查看器不渲染内嵌资源）</div>
        ) : (
          <div className="pp-viewer-empty">正在解压章节…</div>
        )}
      </section>
      <div className="pp-viewer-epub-meta">
        {identity ? `${identity} · ` : ''}
        包体 {sizeText(zip.length)} · 纯文本阅读：不渲染 EPUB 内嵌 CSS / 图片 / 脚注，DRM 加密封装不支持
      </div>
    </div>
  );
}

export const epubViewer: ViewerDef = {
  id: 'epub',
  exts: VIEWER_EPUB_EXTS,
  needsBytes: true,
  bytesKind: 'data-uri',
  mimes: { epub: 'application/epub+zip' },
  maxBytes: EPUB_MAX_BYTES,
  component: EpubViewer,
};
