// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// ipynb 查看器本体（渲染面补全 P3 · B11，2026-09-23）——**复用查看器**：markdown 单元格
// 交应用侧 markdown 渲染器（`app/paper/builtin-renderers.tsx` 的 `MarkdownBody`，经
// `builtinRendererDefs()` 取件），本件**不写第二份 markdown 解析**。产物域拿不到那个模块
// ⇒ 产物侧只登记认领与读取形态（`plugins/builtin/renderers/viewers/ipynb.ts` 的
// `heavy: 'ipynb'`），本体住应用 bundle（`app/paper/viewers/` 目录即白名单，vite 真分片）。
// 读取形态 = `bytesKind:'text'`（宿主走 `fs_cap read` 开行窗口，不整份进 IPC）。
//
// 单元格序列（nbformat 4）：
//   · markdown → 应用侧 markdown 渲染器（标题/列表/表格/围栏码/公式全套照旧）；
//   · code     → hljs 高亮（语言取 `metadata.language_info.name` / `kernelspec.name`；
//                `hljs.getLanguage` 不认的**不猜**，落原文 mono）。代码块挂纸面围栏码作用域
//                `.pp-md-code`——hljs 墨色映射的单一真源在 PaperPanel.css 的
//                `.pp-md-code` / `.pp-viewer-code` 选择器组，第三份配色必然漂（B2 纪律）；
//   · raw      → 原文 mono（nbformat 语义：raw 单元格本就不渲染）；
//   · outputs  → 按 `output_type` 分发：stream / execute_result / display_data 的
//                text/plain → 文本；image/* → 「不渲染」说明（**带 MIME 与字节数**）；
//                error → 错误块（traceback 剥 ANSI）；text/html / widget / 其余 MIME →
//                具名「不渲染」说明（**绝不把 notebook 里的 HTML 注入纸面**）。
//
// 失败面（宪法「错误不静默」）：无字节 / 字节形态不符（宿主声明 text 却给 data URI）/
// 空文件 / 行窗口满（JSON 可能被腰斩 ⇒ 不解析，明说）/ JSON 坏（带解析器原话）/
// 顶层不是对象 / 没有 cells 数组（列出顶层键）/ 空笔记本 —— 每种都出一行可读错误或空态，
// **不拿原始 JSON 兜底**。
//
// 如实标注的未支持项：widget（无运行时）· HTML/LaTeX/JSON 等富输出 · 图片内联（只报 MIME
// 与字节数）· markdown 单元格的 attachments 图片 · 单元格折叠与执行（无写入口）·
// 超过行窗口的笔记本（整份读的代价见 INVARIANTS #11）。

import hljs from 'highlight.js/lib/common';
import * as React from 'react';
import { createBlock } from '../../../paper/block-model';
import { sanitizePayloadText } from '../../../paper/tool-text';
import type { ViewerProps } from '../../../paper/viewer-contract';
import { builtinRendererDefs } from '../builtin-renderers';
import './ipynb.css';

/** 行窗口（与产物侧注册面 `readLines` **同值**——宿主多读 1 行作「文件更长」判据）。 */
export const IPYNB_LINE_CAP = 6000;

/** 单元格类型（`unknown` = nbformat 之外的类型：如实显示原名，不猜语义）。 */
export type IpyCellType = 'markdown' | 'code' | 'raw' | 'unknown';

/** 一条输出的渲染模型（**已解析**——渲染层不再碰原始 JSON）。 */
export type IpyOutput =
  | { kind: 'text'; label: string; text: string; stream: 'stdout' | 'stderr' | null }
  | { kind: 'error'; label: string; text: string }
  | { kind: 'note'; label: string; note: string };

export interface IpyCell {
  /** 1 起的序号（渲染与读数的稳定身份） */
  index: number;
  type: IpyCellType;
  /** 原始 `cell_type`（unknown 时如实显示） */
  rawType: string;
  /** code 单元格的 `execution_count`（null = 从未执行） */
  execCount: number | null;
  source: string;
  outputs: IpyOutput[];
  /** hljs 语言 id（该笔记本内核决定；不识别 = null → 原文 mono） */
  lang: string | null;
}

export interface IpyNotebook {
  cells: IpyCell[];
  total: number;
  counts: { markdown: number; code: number; raw: number; unknown: number };
  /** 内核名（`language_info.name` ?? `kernelspec.name`；缺 = null） */
  kernel: string | null;
}

/** 解析结局：坏输入走 `ok:false`（一行可读错误），**不抛也不 JSON 兜底**。 */
export type IpyParseResult = { ok: true; notebook: IpyNotebook } | { ok: false; error: string };

/** nbformat 的 `source` / `text` / `data[mime]`：字符串或字符串数组（数组按 Jupyter 约定直接拼接）。 */
function flattenText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string').join('');
  return '';
}

/** base64 长度 → 原始字节数（只用于读数，不解码：4 字符 3 字节，末尾 `=` 各扣 1）。 */
export function base64Bytes(b64: string): number {
  const clean = b64.replace(/\s+/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
}

/** 值的形态（错误行里说清「收到什么」，不打印内容本身）。 */
function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `数组（${v.length} 项）`;
  return typeof v;
}

/** 内核语言名 → hljs 语言 id（`lib/common` + 应用侧补注册的科研语言；不识别 = null）。 */
const HLJS_BY_KERNEL: Readonly<Record<string, string>> = {
  python: 'python',
  python2: 'python',
  python3: 'python',
  ipython: 'python',
  r: 'r',
  ir: 'r',
  julia: 'julia',
  javascript: 'javascript',
  js: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
  scala: 'scala',
  haskell: 'haskell',
  matlab: 'matlab',
  octave: 'matlab',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'csharp',
  'c#': 'csharp',
  java: 'java',
  go: 'go',
  golang: 'go',
  rust: 'rust',
  ruby: 'ruby',
  php: 'php',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  powershell: 'powershell',
  sql: 'sql',
  lua: 'lua',
  perl: 'perl',
  swift: 'swift',
  kotlin: 'kotlin',
  clojure: 'clojure',
  dockerfile: 'dockerfile',
  latex: 'latex',
  tex: 'latex',
  xml: 'xml',
  html: 'xml',
  css: 'css',
  markdown: 'markdown',
  yaml: 'yaml',
  json: 'json',
};

/** 内核名归一（小写去空格 + 收掉版本号：`Python 3.11.4` / `python3` → `python`）。 */
function hljsLangOf(name: string | null): string | null {
  if (!name) return null;
  const base = name.trim().toLowerCase().replace(/\s+/g, '');
  const unversioned = base.replace(/[0-9.]+$/, '');
  const id = HLJS_BY_KERNEL[base] ?? HLJS_BY_KERNEL[unversioned];
  return id !== undefined && hljs.getLanguage(id) ? id : null;
}

/** 内核名（笔记本级；code 单元格共用）。 */
function kernelNameOf(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const info = meta.language_info;
  const infoName = info && typeof info === 'object' ? (info as Record<string, unknown>).name : undefined;
  if (typeof infoName === 'string' && infoName.trim() !== '') return infoName;
  const spec = meta.kernelspec;
  if (spec && typeof spec === 'object') {
    const s = spec as Record<string, unknown>;
    if (typeof s.name === 'string' && s.name.trim() !== '') return s.name;
    if (typeof s.language === 'string' && s.language.trim() !== '') return s.language;
  }
  return null;
}

/** 图片 MIME（本查看器**不内联**，只报 MIME 与字节数）。 */
const IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

/** widget 输出 MIME（无运行时 ⇒ 具名说明）。 */
const WIDGET_MIME = 'application/vnd.jupyter.widget-view+json';

/** 图片输出 → 「不渲染」说明（MIME + 字节数；SVG 是内联文本，按字符数报）。 */
function imageNote(label: string, mime: string, value: unknown): IpyOutput {
  const raw = flattenText(value);
  const size = mime === 'image/svg+xml' ? `约 ${raw.length} 字符（内联 SVG 文本）` : `约 ${base64Bytes(raw)} 字节`;
  return { kind: 'note', label, note: `输出含图片，本查看器不渲染（MIME ${mime}，${size}）` };
}

/** `data` 字典 → 输出序列（text/plain 优先；图片 / HTML / widget / 其余 MIME 各自具名说明）。 */
function dataOutputs(data: Record<string, unknown>, base: string): IpyOutput[] {
  const out: IpyOutput[] = [];
  const consumed = new Set<string>();
  const plain = data['text/plain'];
  if (plain !== undefined) {
    consumed.add('text/plain');
    out.push({ kind: 'text', label: `${base} · text/plain`, text: flattenText(plain), stream: null });
  }
  for (const mime of IMAGE_MIMES) {
    if (data[mime] === undefined) continue;
    consumed.add(mime);
    out.push(imageNote(`${base} · ${mime}`, mime, data[mime]));
  }
  if (data['text/html'] !== undefined) {
    consumed.add('text/html');
    out.push({
      kind: 'note',
      label: `${base} · text/html`,
      note: '输出含 HTML，本查看器不渲染 HTML（不向纸面注入 notebook 里的标记）',
    });
  }
  if (data[WIDGET_MIME] !== undefined) {
    consumed.add(WIDGET_MIME);
    out.push({
      kind: 'note',
      label: `${base} · widget`,
      note: `输出含 Jupyter widget（${WIDGET_MIME}），本查看器无 widget 运行时，不渲染`,
    });
  }
  const rest = Object.keys(data).filter((k) => !consumed.has(k));
  if (rest.length > 0) {
    out.push({ kind: 'note', label: `${base} · 其余输出`, note: `另有输出 MIME：${rest.join(' / ')}——本查看器不渲染` });
  }
  return out;
}

/** 单元格 `outputs` → 输出序列（未知 output_type 也说话，不静默丢）。 */
function outputsOf(raw: unknown): IpyOutput[] {
  if (!Array.isArray(raw)) return [];
  const out: IpyOutput[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const type = typeof o.output_type === 'string' ? o.output_type : '';
    if (type === 'stream') {
      const stream = o.name === 'stderr' ? 'stderr' : 'stdout';
      const text = flattenText(o.text);
      if (text.length === 0) continue; // 空流输出无信息（不是丢失）
      out.push({ kind: 'text', label: `输出 · ${stream}`, text, stream });
      continue;
    }
    if (type === 'execute_result' || type === 'display_data') {
      const base = type === 'execute_result' ? '结果' : '显示';
      const data = o.data;
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const items = dataOutputs(data as Record<string, unknown>, base);
        if (items.length === 0)
          out.push({ kind: 'note', label: base, note: `输出的 data 是空字典（output_type=${type}）` });
        out.push(...items);
      } else {
        out.push({
          kind: 'note',
          label: base,
          note: `输出没有可显示的 data 字典（output_type=${type}，data=${describeValue(data)}）`,
        });
      }
      continue;
    }
    if (type === 'error') {
      const ename = typeof o.ename === 'string' && o.ename !== '' ? o.ename : 'Error';
      const evalue = typeof o.evalue === 'string' ? o.evalue : '';
      const tb = Array.isArray(o.traceback) ? o.traceback.filter((l): l is string => typeof l === 'string') : [];
      // traceback 满屏 `\u001b[0;31m`：洁净化**复用** paper/tool-text 的展示变换（ANSI/OSC/C0
      // 剔除 + CR 归一），本件不写第二份转义处理。
      const lines = [`${ename}: ${evalue}`, ...tb].map(sanitizePayloadText);
      out.push({ kind: 'error', label: '错误', text: lines.join('\n') });
      continue;
    }
    out.push({ kind: 'note', label: '输出', note: `未知输出类型「${type || '(缺 output_type)'}」，本查看器不渲染` });
  }
  return out;
}

/** markdown 单元格的附件图片 → 具名说明（本查看器不内联）。 */
function attachmentNotes(raw: unknown): IpyOutput[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length === 0) return [];
  return [
    {
      kind: 'note',
      label: '附件',
      note: `markdown 单元格含 ${keys.length} 个附件（${keys.join(' / ')}），本查看器不渲染附件图片`,
    },
  ];
}

/** 文本 → 笔记本模型（**纯函数**，导出 = 测试直呼面）。 */
export function parseNotebook(text: string): IpyParseResult {
  const lineCount = text.length === 0 ? 0 : text.split('\n').length;
  if (lineCount > IPYNB_LINE_CAP) {
    return {
      ok: false,
      error: `文件超过查看器行窗口 ${IPYNB_LINE_CAP} 行（读回 ${lineCount} 行）——JSON 可能被腰斩，本查看器不解析（行窗口是不整份进 IPC 的闸）`,
    };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `不是有效的 ipynb JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: `ipynb 顶层不是对象（收到 ${describeValue(doc)}）` };
  }
  const obj = doc as Record<string, unknown>;
  const rawCells = obj.cells;
  if (!Array.isArray(rawCells)) {
    const keys = Object.keys(obj);
    return {
      ok: false,
      error: `ipynb 里没有 cells 数组（cells=${describeValue(rawCells)}）——顶层键：${keys.length > 0 ? keys.join(' / ') : '（无）'}`,
    };
  }
  const meta =
    obj.metadata !== null && typeof obj.metadata === 'object' && !Array.isArray(obj.metadata)
      ? (obj.metadata as Record<string, unknown>)
      : null;
  const kernel = kernelNameOf(meta);
  const lang = hljsLangOf(kernel);
  const counts = { markdown: 0, code: 0, raw: 0, unknown: 0 };
  const cells: IpyCell[] = rawCells.map((raw, i) => {
    const index = i + 1;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      counts.unknown += 1;
      return {
        index,
        type: 'unknown' as const,
        rawType: `(非对象：${describeValue(raw)})`,
        execCount: null,
        source: '',
        outputs: [],
        lang: null,
      };
    }
    const c = raw as Record<string, unknown>;
    const rawType = typeof c.cell_type === 'string' && c.cell_type !== '' ? c.cell_type : '(缺 cell_type)';
    const type: IpyCellType = rawType === 'markdown' || rawType === 'code' || rawType === 'raw' ? rawType : 'unknown';
    counts[type] += 1;
    const outputs = type === 'code' ? outputsOf(c.outputs) : [];
    if (type === 'markdown') outputs.push(...attachmentNotes(c.attachments));
    if (type === 'unknown') {
      outputs.push({ kind: 'note', label: '单元格', note: `未知单元格类型「${rawType}」，本查看器不渲染` });
    }
    return {
      index,
      type,
      rawType,
      execCount: typeof c.execution_count === 'number' ? c.execution_count : null,
      source: flattenText(c.source),
      outputs,
      lang: type === 'code' ? lang : null,
    };
  });
  return { ok: true, notebook: { cells, total: cells.length, counts, kernel } };
}

/* ── 复用面：应用侧 markdown 渲染器 ──────────────────────────────── */

/** `builtinRendererDefs()` 是冻结表（模块装载期建一次）——取 kind='markdown' 那一行。 */
const MarkdownView = builtinRendererDefs().find((d) => d.kind === 'markdown')?.component ?? null;

/** markdown 单元格：构造一个 viewer 自己的 markdown 块，交给应用侧渲染器（零第二份解析）。 */
function MarkdownCell({ text }: { text: string }) {
  const block = React.useMemo(() => createBlock('markdown', { text }, { messageId: 'viewer', part: null }), [text]);
  if (!MarkdownView) {
    return (
      <div className="pp-viewer-ipynb-missing">
        应用侧 markdown 渲染器缺失（builtinRendererDefs 里没有 kind='markdown' 的行）——单元格原文：
        {text.slice(0, 200)}
      </div>
    );
  }
  return <>{React.createElement(MarkdownView, { block })}</>;
}

/** code 单元格：hljs 高亮（`.pp-md-code` 作用域 = 纸面围栏码的墨色真源）；不识别语言落原文 mono。 */
function CodeCell({ source, lang }: { source: string; lang: string | null }) {
  const html = React.useMemo(() => {
    if (lang === null || source.trim() === '') return null;
    try {
      // 半成型/超长行 tolerate：与流内围栏码同款 ignoreIllegals
      return hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [source, lang]);
  return (
    <pre className="pp-md-code">
      {html !== null ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: hljs 输出为可信本地渲染（非 notebook HTML；转义由 hljs 内建）
        <code dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code>{source}</code>
      )}
    </pre>
  );
}

/** 一条输出块（文本 / 错误 / 「不渲染」说明）。 */
function OutputBlock({ out }: { out: IpyOutput }) {
  if (out.kind === 'note') {
    return (
      <div className="pp-viewer-ipynb-note">
        <span className="pp-viewer-ipynb-outlabel">{out.label}</span>
        {out.note}
      </div>
    );
  }
  // 两条失败墨：stderr（流里的错）与 error（异常结果）——类名分开，判据面能各自点名
  const tone =
    out.kind === 'error' ? ' pp-viewer-ipynb-out--error' : out.stream === 'stderr' ? ' pp-viewer-ipynb-out--err' : '';
  return (
    <div className={`pp-viewer-ipynb-out${tone}`}>
      <div className="pp-viewer-ipynb-outlabel">{out.label}</div>
      <pre className="pp-viewer-ipynb-outtext">{out.text}</pre>
    </div>
  );
}

/** 单元格类型徽记（机器语汇：nbformat 的类型名，unknown 显示原名）。 */
function badgeOf(cell: IpyCell): string {
  return cell.type === 'markdown' ? 'md' : cell.type === 'unknown' ? cell.rawType : cell.type;
}

/** 单元格体（markdown 走复用渲染器 / code 走高亮 + 输出 / raw 原文 / unknown 说明）。 */
function cellBody(cell: IpyCell): React.ReactNode {
  if (cell.type === 'markdown') {
    return (
      <>
        <MarkdownCell text={cell.source} />
        {cell.outputs.map((out, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 输出按位渲染（同单元格内序即身份）
          <OutputBlock key={i} out={out} />
        ))}
      </>
    );
  }
  if (cell.type === 'code') {
    return (
      <>
        <CodeCell source={cell.source} lang={cell.lang} />
        {cell.outputs.map((out, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 输出按位渲染（同单元格内序即身份）
          <OutputBlock key={i} out={out} />
        ))}
      </>
    );
  }
  if (cell.type === 'unknown') {
    return cell.outputs.map((out, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: 同上
      <OutputBlock key={i} out={out} />
    ));
  }
  return <pre className="pp-viewer-ipynb-raw">{cell.source}</pre>;
}

/** 查看器本体（宿主渲染面契约见 viewer-registry 的 ViewerProps）。 */
export default function IpyNbViewer({ label, ext, filePath, bytes, mode }: ViewerProps) {
  const text = bytes?.kind === 'text' ? bytes.value : '';
  const result = React.useMemo(() => parseNotebook(text), [text]);
  // 文本查看器没有放大形态（同 code.tsx：浮层对文本无意义）
  if (mode === 'overlay') return null;
  if (!bytes) {
    return <div className="pp-viewer-empty">未取到笔记本内容（{label || ext || filePath || '文件'}）——无法查看</div>;
  }
  if (bytes.kind !== 'text') {
    return (
      <div className="pp-viewer-error">
        ipynb 查看器按文本形态读取（宿主声明 bytesKind:'text' 的行窗口），收到的是 base64 data URI（
        {bytes.value.length} 字符）——宿主读取形态与查看器声明不一致
      </div>
    );
  }
  const pathNote = filePath ? ` · ${filePath}` : '';
  if (text.trim().length === 0) {
    return <div className="pp-viewer-empty">笔记本为空（0 字符）——没有可显示的单元格{pathNote}</div>;
  }
  if (!result.ok) {
    return (
      <div className="pp-viewer-error">
        笔记本读不了：{result.error}
        {pathNote}
      </div>
    );
  }
  const nb = result.notebook;
  if (nb.total === 0) {
    return <div className="pp-viewer-empty">笔记本里没有单元格（cells 是空数组）{pathNote}</div>;
  }
  const { counts } = nb;
  return (
    <div className="pp-viewer-ipynb">
      <div className="pp-viewer-ipynb-bar">
        <span className="pp-viewer-ipynb-count">共 {nb.total} 个单元格</span>
        <span className="pp-viewer-ipynb-stat">markdown ×{counts.markdown}</span>
        <span className="pp-viewer-ipynb-stat">code ×{counts.code}</span>
        <span className="pp-viewer-ipynb-stat">raw ×{counts.raw}</span>
        {counts.unknown > 0 && <span className="pp-viewer-ipynb-stat">未知类型 ×{counts.unknown}</span>}
        {nb.kernel !== null && <span className="pp-viewer-ipynb-kernel">内核 {nb.kernel}</span>}
      </div>
      <div className="pp-viewer-ipynb-cells">
        {nb.cells.map((cell) => (
          <div key={cell.index} className={`pp-viewer-ipynb-cell pp-viewer-ipynb-cell--${cell.type}`}>
            <div className="pp-viewer-ipynb-cellhead">
              <span className="pp-viewer-ipynb-idx">{cell.index}</span>
              <span className="pp-viewer-ipynb-badge">{badgeOf(cell)}</span>
              {cell.type === 'code' && (
                <span className="pp-viewer-ipynb-exec">In [{cell.execCount === null ? ' ' : cell.execCount}]</span>
              )}
            </div>
            <div className="pp-viewer-ipynb-body">{cellBody(cell)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
