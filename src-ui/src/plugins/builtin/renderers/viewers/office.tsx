// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// Office 查看器（渲染面补全 P3 · B4，2026-09-23）——docx / xlsx / pptx。
//
// 内容**不经字节**：Office 是 OOXML 容器（zip + XML），要读出可读内容得走 OfficeCLI
// （随包单二进制）。本查看器是**用户路径**，只能经 `process_cap{action:'office_exec',
// is_agent:false}` 受控 spawn——**不能**调 `office` 域工具（那是 agent 面 + 目标文件
// 门禁，见施工单 §B4「走哪条口」）。故 `needsBytes: false`：宿主只给
// `filePath`/`label`/`ext`，一个字节都不读（不白读一份本进程打不开的 zip）。
//
// argv 形状与 `agent/tools/office.ts::buildOfficeArgv` **同源**（照抄，不自创）：
//   view  → `['view', file, mode, ...--json, ...--page]`（office.ts L157-163）
//   get   → `['get', file, path, ...--depth, ...--json]`（L164-168）
//   query → `['query', file, selector, ...--json]`（L169-172）
// 本文件只发**读动词**（view/get/query/validate）；targets 只声明目标文件且
// `write: false`（`officeTargets` 的只读分支）。写动作一个都不发——查看器不提供写入口，
// 写走 `office(action,…)`，权限面不混淆（施工单 §B4「只读」）。超时沿用口内缺省
// （`process_cap.rs` 的 `timeout_ms.unwrap_or(120_000)`），本层不另立数字。
//
// 三个格式的读法（都**一次调用**取全：officecli 每次调用自成一次 open/parse——
// Rust 侧钉 `OFFICECLI_NO_AUTO_RESIDENT=1`，不逐表/逐页起进程）：
//   · docx → `view <f> annotated`：一行一条
//     `[/body/p[@paraId=…]] 「文」 ← Heading1 | 等线 11pt` ⇒ 正文 + 样式，标题/正文分得开。
//     **为什么不用 `text`**：`view text` 不带样式，标题与正文无从区分；`annotated` 是同一
//     `view` 动词下带样式的形态，单次调用即可（`text` + `outline` 两次要多付一次 open/parse）。
//     表格那类节点在 annotated 里是 `[Table: 3×3]` 标记行——如实转出，不画假表。
//   · xlsx → `view <f> text`：`=== Sheet: 名字 ===` 分段 + `[/Sheet1/row[1]] A1=地区⇥B1=销量`
//     ⇒ 一次拿全多表（不逐 sheet 起进程）。表体交 **`grid` 原语**（`GridBody`）渲染——
//     同一张表在流内与查看器里同貌；多表出页签，**切换只重渲不重读**（数据在一次调用里已全在）。
//     列头 = 列号（A/B/C…，officecli 不给「表头行」概念，不替用户猜第一行是表头）。
//   · pptx → `view <f> text`：`=== /slide[1] ===` 分段 + 每页文本行 ⇒ 页序 + 逐页文本。
//     （`view outline` 只有标题、`view text` 是逐页全文；两者都一次取全 ⇒ 取全文。）
//
// 失败面（每种都出**一行可读错误**，点明哪个文件、哪一步，且带 officecli 原话——
// 不静默、不 JSON 兜底）：officecli 缺失 / 文件不是 OOXML（corrupted）/ 超时 /
// 没退出码（结果未知，绝不当成功）/ 口内形态变了（返回 JSON 而非 shell 文本）。
//
// 形态纪律：docx 走 annotated 的是正文块序列（**不是一整坨 pre**）；读数行与截断
// （officecli 输出超 32K 字符时强制层 head+tail 截断）都出可见读数，不静默。

import type { SourcedBlock } from '../../../../paper/block-model';
import { VIEWER_OFFICE_EXTS } from '../../../../paper/viewer-exts';
// 表体复用 `grid` 原语（施工单 §B4）：本 import 让「components ↔ viewers/index ↔ 本文件」
// 成环——环在两种运行时都安全，前提是**求值入口仍是 renderers/index.tsx 或 viewers/index.ts**
// （components 先求值 ⇒ viewers/index 建表时本模块的 `officeViewer` 已初始化）。反向顺序
// （某处把 `viewers/office` 当**首个**求值点静态 import）会在 viewers/index 建表时撞 TDZ，
// 所以测试面取件走**动态 import**（tests/viewer-office.test.tsx 的 ensureOfficeRegistered）。
import { GridBody } from '../components';
import { rendererHooks, rendererRpc } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import './office.css';

const { useEffect, useState } = rendererHooks;

/** 读动词白名单（Rust 口内 11 动词的**只读子集**）——本文件一个写动词都不发。 */
const READ_VERBS: readonly string[] = ['view', 'get', 'query', 'validate'];

/** 单表显示行上限（超出出可见读数，不静默截断；`grid` 原语在 >1000 行时自转虚拟滚动）。 */
const SHEET_ROW_CAP = 1000;
/** 逐页文本的页上限（officecli 输出自有 32K 字符护栏，这里再收一道防 DOM 过大）。 */
const SLIDE_CAP = 300;

/** 退出码前缀。形状真源 = `src-tauri/src/commands/process_cap.rs`：成功补 `[exit code: 0]`，
 *  失败/超时带 `[exit code: N|-1]`（`office_result_with_exit_code`）。 */
const EXIT_RE = /^\s*\[exit(?:\s+code:)?\s*(-?\d+)\]/;
/** officecli 往 stderr 打的环境提示（强制层把 stdout + stderr 拼在一起返回）——剔掉，别当正文。 */
const LOCALE_NOTE_RE = /^Note: locale '.*' inferred from OS user culture/;
/** 「没装 officecli」判定：与 `agent/tools/office.ts::cleanShellOutput` 同款**收窄**口径
 *  （要求 officecli 与错误文案相邻——否则「目标文件不存在」也会被误报成「没装二进制」）。 */
const MISSING_BIN_RE = /officecli(\.exe)?["']?:\s*(command not found|no such file or directory)/i;

/** 正文块（docx）——`annotated` 一行一块。 */
interface DocBlock {
  kind: 'title' | 'heading' | 'para' | 'table';
  /** 标题层级（1..6；非标题 = 0） */
  level: number;
  text: string;
}

/** 一张工作表（xlsx）——列号补全到表内最大列，行按列对齐（`view text` 不给空单元格）。 */
interface SheetTable {
  /** React key（xlsx 里同名工作表合法 ⇒ 键由「序 + 名」定，不靠名唯一） */
  key: string;
  name: string;
  columns: string[];
  rows: string[][];
  /** 行数超 SHEET_ROW_CAP ⇒ 只显示前 N 行（可见读数） */
  capped: boolean;
}

/** 一页（pptx）——页序 + 该页文本块。 */
interface SlideText {
  /** React key（页路径 `/slide[N]` 本已唯一，仍带序以防畸形态重名） */
  key: string;
  path: string;
  lines: string[];
}

type OfficeModel =
  | { format: 'docx'; blocks: DocBlock[] }
  | { format: 'xlsx'; sheets: SheetTable[] }
  | { format: 'pptx'; slides: SlideText[] };

type OfficeState =
  | { status: 'shell' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; model: OfficeModel; truncated: boolean };

/** 文件名（错误文案点名的对象——长路径下也读得懂）。 */
function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/** 原话截断（错误文案里保留最有信息量的开头）。 */
function clip(text: string, max = 200): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** officecli 原话 → 一行分类提示（原话仍照旧附在后面，不吞）。 */
function failureHint(body: string): string {
  if (MISSING_BIN_RE.test(body)) {
    return '没找到 officecli 可执行文件（解析序：$OFFICECLI_PATH → ~/.lantai/tools/officecli/officecli.exe → 随包件 → PATH）';
  }
  if (/File not found/i.test(body)) return '文件不存在或不可读';
  if (/corrupted data|not a valid|Invalid/i.test(body))
    return '打不开——不是有效的 OOXML（.docx/.xlsx/.pptx），或文件已损坏';
  return '';
}

/** 三格式各自的 argv 与「第几步」标签（一份判据同时喂 RPC 与错误文案，不两处各写一遍）。 */
function readPlan(ext: string, filePath: string): { argv: string[]; step: string } | null {
  if (ext === 'docx') return { argv: ['view', filePath, 'annotated'], step: '读正文（view annotated）' };
  if (ext === 'xlsx') return { argv: ['view', filePath, 'text'], step: '读工作表（view text）' };
  if (ext === 'pptx') return { argv: ['view', filePath, 'text'], step: '读逐页文本（view text）' };
  return null;
}

type ReadOutcome = { ok: true; body: string; truncated: boolean } | { ok: false; error: string };

/** 经**用户路径能力口**读 Office：`process_cap{action:'office_exec', is_agent:false}`。
 *  targets 只声明目标文件且 `write: false`；写动词在这里就被挡下（构造上不会发生）。 */
async function readOffice(filePath: string, argv: readonly string[], step: string): Promise<ReadOutcome> {
  const file = baseName(filePath);
  const verb = argv[0] ?? '';
  if (!READ_VERBS.includes(verb)) {
    return { ok: false, error: `「${file}」${step}：查看器只发读动词（${READ_VERBS.join('/')}），收到 "${verb}"` };
  }
  let raw: unknown;
  try {
    raw = await rendererRpc('process_cap', {
      action: 'office_exec',
      office: { argv: [...argv], targets: [{ path: filePath, write: false }] },
      is_agent: false,
    });
  } catch (e) {
    // 能力口本身拒绝（权限卡被拒 / 载荷不合法 / 口被摘掉）：原话照给，别只说「失败」
    return { ok: false, error: `「${file}」${step}没走通（process_cap office_exec）：${messageOf(e)}` };
  }
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const m = EXIT_RE.exec(text);
  if (!m) {
    // 没退出码 = 结果未知：不当作成功，也不把原始载荷当内容渲染（不 JSON 兜底）
    return { ok: false, error: `「${file}」${step}的返回里没有退出码（读口没按 shell 文本形态回）：${clip(text)}` };
  }
  const exit = Number(m[1]);
  const body = text
    .slice(m[0].length)
    .split('\n')
    .filter((line) => !LOCALE_NOTE_RE.test(line.trim()))
    .join('\n')
    .trim();
  if (exit !== 0) {
    const hint = failureHint(body);
    const why = exit === -1 ? '超时（officecli 没在超时窗口内返回）' : `officecli 退出码 ${exit}`;
    return {
      ok: false,
      error: `「${file}」${step}失败：${why}${hint ? ` · ${hint}` : ''} · 原话：${clip(body) || '(无输出)'}`,
    };
  }
  if (body.startsWith('{')) {
    return {
      ok: false,
      error: `「${file}」${step}返回的是 JSON 而不是 officecli 的 shell 文本——读口形态变了？前 200 字符：${clip(body)}`,
    };
  }
  // 32K 字符护栏（强制层 head+tail 截断）留下可见标记 ⇒ 读数行照实说「本页不完整」
  return { ok: true, body, truncated: body.includes('[output truncated:') };
}

/* ── docx：`annotated` 一行 → 一块 ── */

/** `[路径] 正文` —— 路径里自带 `[N]`（`/body/tbl[1]`），故路径段**非贪婪**取到
 *  第一个「后面跟空白的 `]`」为止（贪婪写法会把 `] ` 吃进正文，表格标记行因此认不出）。 */
const ANNOTATED_RE = /^\[.*?\]\s+(.*)$/;
const QUOTED_RE = /^「([\s\S]*)」(?:\s*←\s*(.*))?$/;
const TABLE_MARK_RE = /^\[Table:\s*(.*)\]$/;
const HEADING_STYLE_RE = /^Heading\s*([1-9])$/i;

function parseAnnotatedLine(line: string): DocBlock | null {
  const rest = (ANNOTATED_RE.exec(line)?.[1] ?? line).trim();
  const quoted = QUOTED_RE.exec(rest);
  const text = (quoted ? quoted[1] : rest).trim();
  if (text.length === 0) return null; // 空段落（annotated 的间隔行）不入正文
  if (TABLE_MARK_RE.test(text)) return { kind: 'table', level: 0, text };
  const style = (quoted?.[2] ?? '').split('|')[0].trim();
  const heading = HEADING_STYLE_RE.exec(style);
  if (heading) return { kind: 'heading', level: Number(heading[1]), text };
  if (/^Title$/i.test(style)) return { kind: 'title', level: 0, text };
  return { kind: 'para', level: 0, text };
}

function buildDocx(body: string): OfficeModel {
  const blocks: DocBlock[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const block = parseAnnotatedLine(trimmed);
    if (block) blocks.push(block);
  }
  return { format: 'docx', blocks };
}

/* ── xlsx：`=== Sheet: 名 ===` 分段 + `[path] A1=值⇥B1=值` 行 ── */

const SHEET_HEAD_RE = /^===\s*Sheet:\s*(.*?)\s*===$/;
/** `[路径] 单元格行` —— 同 ANNOTATED_RE：路径段非贪婪（路径自带 `[N]`）。 */
const ROW_RE = /^\[.*?\]\s+(.*)$/;
const CELL_RE = /^([A-Za-z]{1,3})(\d+)=(.*)$/;

/** 列号（A/B/…/AA）→ 0-based 下标。 */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0-based 下标 → 列号（表格列头用它——officecli 不给「表头行」概念，不替用户猜）。 */
function colName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function buildXlsx(body: string): OfficeModel | { error: string } {
  const raw: Array<{ name: string; rows: Array<Map<number, string>> }> = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const head = SHEET_HEAD_RE.exec(trimmed);
    if (head) {
      raw.push({ name: head[1] ?? '', rows: [] });
      continue;
    }
    if (raw.length === 0) continue; // 分段之前的杂行不入表（首段头是格式锚）
    const cells = (ROW_RE.exec(trimmed)?.[1] ?? '').trim();
    const row = new Map<number, string>();
    for (const part of cells.split('\t')) {
      const cell = CELL_RE.exec(part.trim());
      if (cell) row.set(colIndex(cell[1]), cell[3]);
    }
    if (row.size > 0) raw[raw.length - 1].rows.push(row);
  }
  if (body.length > 0 && raw.length === 0) {
    return { error: '输出里没有 `=== Sheet: … ===` 分段' };
  }
  const sheets: SheetTable[] = raw.map((sheet, index) => {
    const capped = sheet.rows.length > SHEET_ROW_CAP;
    const kept = capped ? sheet.rows.slice(0, SHEET_ROW_CAP) : sheet.rows;
    let width = 0;
    for (const row of kept) for (const col of row.keys()) width = Math.max(width, col + 1);
    const columns = Array.from({ length: width }, (_, i) => colName(i));
    return {
      key: `${index}:${sheet.name}`,
      name: sheet.name,
      columns,
      rows: kept.map((row) => columns.map((_, i) => row.get(i) ?? '')),
      capped,
    };
  });
  return { format: 'xlsx', sheets };
}

/* ── pptx：`=== /slide[N] ===` 分段 + 每页文本行 ── */

const SLIDE_HEAD_RE = /^===\s*(\/slide\[\d+\])\s*===$/;

function buildPptx(body: string): OfficeModel | { error: string } {
  const slides: SlideText[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const head = SLIDE_HEAD_RE.exec(trimmed);
    if (head) {
      const path = head[1] ?? '';
      slides.push({ key: `${slides.length}:${path}`, path, lines: [] });
      continue;
    }
    if (slides.length === 0) continue;
    slides[slides.length - 1].lines.push(trimmed);
  }
  if (body.length > 0 && slides.length === 0) {
    return { error: '输出里没有 `=== /slide[N] ===` 分段' };
  }
  return { format: 'pptx', slides };
}

function buildModel(ext: string, body: string): OfficeModel | { error: string } {
  if (ext === 'docx') return buildDocx(body);
  if (ext === 'xlsx') return buildXlsx(body);
  return buildPptx(body);
}

/** 截断横幅文案（读数行共用一份）。 */
const TRUNC_NOTE = ' · officecli 输出超 32K 字符，已被 head+tail 截断（本页不完整）';

/** 文件壳（未认领/无路径时的同一形态；与宿主 components.tsx 的 FileShell 同款）。 */
function OfficeFileShell({ ext, filePath }: { ext: string; filePath?: string }) {
  return (
    <div className="pp-media-file">
      {ext && <span className="pp-media-ext">{ext}</span>}
      <span className="pp-media-path">{filePath ?? ''}</span>
    </div>
  );
}

/** 块 → 类名（标题三档；Heading4+ 收进第三档）。 */
function docBlockClass(block: DocBlock): string {
  if (block.kind === 'title') return 'pp-viewer-office-title';
  if (block.kind === 'heading') return `pp-viewer-office-h pp-viewer-office-h${Math.min(block.level, 3)}`;
  if (block.kind === 'table') return 'pp-viewer-office-table';
  return 'pp-viewer-office-p';
}

/** docx 正文块序列（读数行 + 逐块；不整坨 pre）。 */
function DocxBody({ model, truncated }: { model: OfficeModel; truncated: boolean }) {
  const blocks = model.format === 'docx' ? model.blocks : [];
  const headings = blocks.filter((b) => b.kind === 'heading' || b.kind === 'title').length;
  const tables = blocks.filter((b) => b.kind === 'table').length;
  return (
    <div className="pp-viewer-box pp-viewer-office">
      <div className="pp-viewer-note">
        {blocks.length} 段正文 · {headings} 处标题{tables > 0 ? ` · ${tables} 处表格` : ''}
        {truncated && TRUNC_NOTE}
      </div>
      {blocks.length === 0 ? (
        <div className="pp-viewer-empty">没有正文（officecli 的 view annotated 未返回段落）</div>
      ) : (
        blocks.map((b, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 正文块按文档序渲染，序即身份
          <div key={i} className={docBlockClass(b)}>
            {b.text}
          </div>
        ))
      )}
    </div>
  );
}

/** xlsx 多表：页签切换**只重渲不重读**（读一次已拿全）；表体走 `grid` 原语。 */
function XlsxBody({ block, model, truncated }: { block: SourcedBlock; model: OfficeModel; truncated: boolean }) {
  const sheets = model.format === 'xlsx' ? model.sheets : [];
  const [active, setActive] = useState(0);
  const index = Math.min(Math.max(active, 0), Math.max(sheets.length - 1, 0));
  const sheet = sheets[index];
  const totalRows = sheets.reduce((n, s) => n + s.rows.length, 0);
  return (
    <div className="pp-viewer-box pp-viewer-office">
      <div className="pp-viewer-note">
        {sheets.length} 张工作表 · 共 {totalRows} 行
        {sheet && ` · 本表 ${sheet.rows.length} 行 × ${sheet.columns.length} 列`}
        {sheet?.capped && `（只显示前 ${SHEET_ROW_CAP} 行）`}
        {truncated && TRUNC_NOTE}
      </div>
      {sheets.length > 1 && (
        <div className="pp-viewer-office-tabs">
          {sheets.map((s, i) => (
            <button
              key={s.key}
              type="button"
              className={`pp-viewer-office-tab${i === index ? ' pp-viewer-office-tab--on' : ''}`}
              onClick={() => setActive(i)}
            >
              {s.name || `表 ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      {!sheet ? (
        <div className="pp-viewer-empty">工作簿里没有工作表</div>
      ) : sheet.columns.length === 0 ? (
        <div className="pp-viewer-empty">工作表「{sheet.name}」没有非空单元格</div>
      ) : (
        <GridBody block={{ ...block, payload: { columns: sheet.columns, rows: sheet.rows, caption: sheet.name } }} />
      )}
    </div>
  );
}

/** pptx 逐页（页序 + 每页文本块）。 */
function PptxBody({ model, truncated }: { model: OfficeModel; truncated: boolean }) {
  const slides = model.format === 'pptx' ? model.slides : [];
  const shown = slides.length > SLIDE_CAP ? slides.slice(0, SLIDE_CAP) : slides;
  const lines = shown.reduce((n, s) => n + s.lines.length, 0);
  return (
    <div className="pp-viewer-box pp-viewer-office">
      <div className="pp-viewer-note">
        {slides.length} 页 · {lines} 处文本
        {slides.length > SLIDE_CAP && ` · 只显示前 ${SLIDE_CAP} 页`}
        {truncated && TRUNC_NOTE}
      </div>
      {shown.length === 0 ? (
        <div className="pp-viewer-empty">没有幻灯片（officecli 的 view text 未返回页）</div>
      ) : (
        shown.map((slide, i) => (
          <div key={slide.key} className="pp-viewer-office-slide">
            <div className="pp-viewer-office-page">
              第 {i + 1} 页 · {slide.path}
            </div>
            {slide.lines.length === 0 ? (
              <div className="pp-viewer-empty">（本页没有文本）</div>
            ) : (
              slide.lines.map((text, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 页内文本块按页序渲染，序即身份
                <div key={j} className="pp-viewer-office-p">
                  {text}
                </div>
              ))
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** Office 查看器（B4）：查表读 → 解析 → 三种格式各自的渲染。 */
function OfficeViewer({ block, ext, filePath, mode }: ViewerProps) {
  const [state, setState] = useState<OfficeState>({ status: 'shell' });
  useEffect(() => {
    let cancelled = false;
    if (!filePath) {
      setState({ status: 'shell' });
      return;
    }
    const file = baseName(filePath);
    const plan = readPlan(ext, filePath);
    if (!plan) {
      setState({ status: 'error', error: `「${file}」：Office 查看器不认 .${ext}（只认 docx / xlsx / pptx）` });
      return;
    }
    setState({ status: 'loading' });
    void (async () => {
      const out = await readOffice(filePath, plan.argv, plan.step);
      if (cancelled) return; // 卸载/换文件：丢弃在途结果（useMediaData 同款守卫）
      if (!out.ok) {
        setState({ status: 'error', error: out.error });
        return;
      }
      const built = buildModel(ext, out.body);
      if ('error' in built) {
        setState({
          status: 'error',
          error: `「${file}」${plan.step}认不出来：${built.error} · 输出的前 200 字符：${clip(out.body)}`,
        });
        return;
      }
      setState({ status: 'ready', model: built, truncated: out.truncated });
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, ext]);

  // 放大形态：内容放大要**再读一次** officecli（跨挂载不缓存）——浮层无增量信息，不重复起进程
  if (mode === 'overlay') return null;
  if (state.status === 'shell') return <OfficeFileShell ext={ext} filePath={filePath} />;
  if (state.status === 'loading') return <div className="pp-media-loading">读取中…（officecli）</div>;
  if (state.status === 'error') return <div className="pp-viewer-error">{state.error}</div>;
  if (state.model.format === 'docx') return <DocxBody model={state.model} truncated={state.truncated} />;
  if (state.model.format === 'xlsx') return <XlsxBody block={block} model={state.model} truncated={state.truncated} />;
  return <PptxBody model={state.model} truncated={state.truncated} />;
}

export const officeViewer: ViewerDef = {
  id: 'office',
  exts: VIEWER_OFFICE_EXTS,
  // 内容经 officecli 读（走 process_cap 用户路径）⇒ **不读字节**：
  // 宿主只给 filePath/label/ext，一个字节都不进 IPC。
  needsBytes: false,
  component: OfficeViewer,
};
