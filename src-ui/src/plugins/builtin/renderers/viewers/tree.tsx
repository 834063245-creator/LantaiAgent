// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 结构化数据树查看器（P1 · B7 之一）——json / jsonl / yaml / toml / xml：折叠树
// （键名 + 类型徽记 + 值预览；默认展开 6 层、更深折叠；节点上限 2000 + 截断横幅）。
//
// 解析一件一档（全部本地；`yaml` 是项目既有依赖，产物域 esbuild 内联——零新增依赖）：
//   json  → JSON.parse（报错带解析器原话，含位置）
//   jsonl → **逐行独立根**：每行一个 JSON 值；坏行单独出「第 N 行无法解析」，好行照常
//   yaml  → `yaml` 的 parse（多文档源会如实报错并出原文，不静默只取第一份）
//   toml  → 自绘最小解析器：[a.b] 表头 / key = value / 基本与字面字符串 / 数字 / 布尔 /
//           行内数组（可嵌套）。**未支持的特性不静默丢**（[[数组表]] / 内联表 {…} /
//           多行字符串 / 点号键 / 日期时间 / 重复键）：按行原文挂进「未支持的 TOML 特性」组
//   xml   → DOMParser（浏览器 / WebView2 原生）；parsererror 折成可读错误行
//
// 失败纪律（宪法「错误不静默」）：整份读不了 ⇒ 一行可读错误（带解析器原话）+
// **窗口内原文 mono 继续显示**（不丢内容、不空白、不 JSON 兜底）；空输入 ⇒ 空态文案。
//
// 认领表真源 = `paper/viewer-exts.ts` 的 `VIEWER_TREE_EXTS`（宿主层单一真源：
// 认领与静态测高同一张表）；行窗口 readLines = 4000（宿主读 4001 行），体积闸 2 MiB。

import { parse as parseYaml } from 'yaml';
import { VIEWER_TREE_EXTS } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import './tree.css';

const { useEffect, useMemo, useState } = rendererHooks;

/** 行窗口（与注册面 `readLines` **同值**——宿主多读 1 行作「文件更长」判据）。 */
const TREE_LINE_CAP = 4000;

/** 体积闸（近似：按窗口文本**字符数**判，文案里如实说「约」）。 */
const TREE_MAX_CHARS = 2 * 1024 * 1024;

/** 默认展开深度（更深的一律折叠；用户可逐节点展开）。 */
const DEFAULT_OPEN_DEPTH = 6;

/** 节点上限（超出只显示前 N 个——截断**可见**，不静默）。 */
const NODE_CAP = 2000;

/** 单条值预览的字符上限（字符串 / 原文行；超出加省略号）。 */
const PREVIEW_CAP = 120;

/** 节点类型徽记（机器语汇，与 JSON / YAML 生态同词）。 */
type TreeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'error';

interface TreeNode {
  /** 键名 / 数组下标 `[0]` 形态 / jsonl 的 `第 N 行` */
  key: string;
  kind: TreeKind;
  /** 值预览（叶子 = 值本身；容器 = 项数摘要） */
  preview: string;
  children: TreeNode[];
  /** 该节点自带的可读错误（jsonl 坏行 / TOML 未支持行）——渲染成行下的朱砂注 */
  error?: string;
}

interface TreeModel {
  roots: TreeNode[];
  /** 整份读不了（json / yaml / toml / xml）——渲染 = 错误行 + 窗口内原文 */
  error: string | null;
  /** 非致命提示（行窗口截断 / 节点上限 / jsonl 坏行 / TOML 未支持特性） */
  warnings: string[];
}

/** 空白折叠成一行（解析器原话常带多行代码框——折成一行仍保留原词）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 预览截断（换行折成空格——预览是单行）。 */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CAP ? `${flat.slice(0, PREVIEW_CAP)}…` : flat;
}

/** 字符串值预览：带引号（内容形态一眼可辨）。 */
function quote(text: string): string {
  return `"${clip(text)}"`;
}

function messageOf(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error));
}

function kindOf(value: unknown): TreeKind {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'object':
      return 'object';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string'; // bigint / symbol 等罕见形态按字符串显示（不静默丢）
  }
}

function leafPreview(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return clip(String(value));
}

function containerPreview(kind: 'object' | 'array', count: number): string {
  const [open, close] = kind === 'array' ? ['[', ']'] : ['{', '}'];
  return count === 0 ? `${open} ${close}` : `${open} ${count} 项 ${close}`;
}

/** 建树累加器（`shown` 受 NODE_CAP 约束；`total` 是树的真实节点数）。 */
interface Build {
  roots: TreeNode[];
  shown: number;
  total: number;
  warnings: string[];
  error: string | null;
  /** 循环引用守卫（YAML 锚点别名可指回自身——不守卫会无限递归） */
  seen: Set<object>;
}

function newBuild(warnings: string[]): Build {
  return { roots: [], shown: 0, total: 0, warnings, error: null, seen: new Set<object>() };
}

/** 真实节点数（与 buildNode 同规则；环安全——共享锚点按出现次数计）。 */
function countNodes(value: unknown, seen: Set<object>): number {
  const kind = kindOf(value);
  if (kind !== 'object' && kind !== 'array') return 1;
  const holder = value as object;
  if (seen.has(holder)) return 1;
  seen.add(holder);
  const values = kind === 'array' ? Array.from(value as unknown[]) : Object.values(value as Record<string, unknown>);
  let count = 1;
  for (const item of values) count += countNodes(item, seen);
  seen.delete(holder);
  return count;
}

function entriesOf(value: object, kind: 'object' | 'array'): Array<[string, unknown]> {
  if (kind === 'array') return (value as unknown[]).map((item, i): [string, unknown] => [`[${i}]`, item]);
  return Object.entries(value as Record<string, unknown>);
}

/** 值 → 节点（`NODE_CAP` 到顶即停止下钻；截断由横幅说明）。 */
function buildNode(key: string, value: unknown, b: Build): TreeNode {
  b.shown++;
  const kind = kindOf(value);
  if (kind !== 'object' && kind !== 'array') return { key, kind, preview: leafPreview(value), children: [] };
  const holder = value as object;
  if (b.seen.has(holder)) {
    return { key, kind: 'error', preview: '（锚点别名指回自身）', children: [] };
  }
  b.seen.add(holder);
  const entries = entriesOf(holder, kind);
  const children: TreeNode[] = [];
  for (const [childKey, childValue] of entries) {
    if (b.shown >= NODE_CAP) break;
    children.push(buildNode(childKey, childValue, b));
  }
  b.seen.delete(holder);
  return { key, kind, preview: containerPreview(kind, entries.length), children };
}

/** 推入一个值根（计数与建树分开——超上限后只计数，横幅才有「共 N 个」可报）。 */
function pushValueRoot(b: Build, key: string, value: unknown): void {
  b.total += countNodes(value, new Set<object>());
  if (b.shown >= NODE_CAP) return;
  b.roots.push(buildNode(key, value, b));
}

/** 推入一个错误根（jsonl 坏行：好行照常、坏行单独标出）。 */
function pushErrorRoot(b: Build, key: string, preview: string, error: string): void {
  b.total++;
  if (b.shown >= NODE_CAP) return;
  b.shown++;
  b.roots.push({ key, kind: 'error', preview, error, children: [] });
}

/* ── json / jsonl ───────────────────────────────────────────────────────── */

function buildJson(text: string, b: Build): void {
  try {
    pushValueRoot(b, '$', JSON.parse(text));
  } catch (e) {
    b.error = `JSON 解析失败：${messageOf(e)}`;
  }
}

function buildJsonl(lines: string[], b: Build): void {
  let bad = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue; // 空行是 jsonl 常态，不算坏行
    const key = `第 ${i + 1} 行`;
    try {
      pushValueRoot(b, key, JSON.parse(raw));
    } catch (e) {
      bad++;
      pushErrorRoot(b, key, quote(raw), `第 ${i + 1} 行无法解析：${messageOf(e)}`);
    }
  }
  if (bad > 0) b.warnings.push(`${bad} 行无法解析（已逐行标出，原文保留在预览里）`);
}

/* ── yaml ───────────────────────────────────────────────────────────────── */

function buildYaml(text: string, b: Build): void {
  try {
    pushValueRoot(b, '$', parseYaml(text));
  } catch (e) {
    b.error = `YAML 解析失败：${messageOf(e)}`;
  }
}

/* ── toml（自绘最小解析器）──────────────────────────────────────────────── */

/** 值解析结局：`ok:false` = **未支持的写法**（原文会挂进「未支持的 TOML 特性」组）。 */
type TomlValue = { ok: true; value: unknown } | { ok: false; reason: string };

interface TomlUnsupported {
  line: number;
  text: string;
  reason: string;
}

/** 剥行内注释（`#` 在字符串里不算注释）。 */
function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/** 顶层 `=` 的位置（引号内不算）；找不到 = -1。 */
function findTomlEquals(line: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '=') return i;
  }
  return -1;
}

/** 按分隔符切分（引号内 / `[]` `{}` 内不切）；括号或引号不配对 = null。 */
function splitTopLevel(text: string, separator: string): string[] | null {
  const out: string[] = [];
  let field = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      field += ch;
      if (quote === '"' && ch === '\\') {
        field += text[i + 1] ?? '';
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      field += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (depth < 0) return null;
    if (ch === separator && depth === 0) {
      out.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  if (quote !== null || depth !== 0) return null;
  out.push(field);
  return out;
}

/** 基本字符串 `"…"`（含 `\n \t \r \" \\ \uXXXX \UXXXXXXXX` 转义）。 */
function parseTomlBasicString(text: string): TomlValue {
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\\') {
      if (ch === '"') {
        if (text.slice(i + 1).trim().length > 0) return { ok: false, reason: '字符串后有多余内容' };
        return { ok: true, value: out };
      }
      out += ch;
      continue;
    }
    const next = text[i + 1];
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
    if (next === undefined) return { ok: false, reason: '字符串转义未闭合' };
    if (simple[next] !== undefined) {
      out += simple[next];
      i++;
      continue;
    }
    if (next === 'u' || next === 'U') {
      const width = next === 'u' ? 4 : 8;
      const hex = text.slice(i + 2, i + 2 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return { ok: false, reason: '未支持的写法：\\u 转义' };
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += 1 + width;
      continue;
    }
    return { ok: false, reason: '未支持的写法：转义序列' };
  }
  return { ok: false, reason: '字符串未闭合' };
}

/** 字面字符串 `'…'`（无反斜杠转义）。 */
function parseTomlLiteralString(text: string): TomlValue {
  const end = text.indexOf("'", 1);
  if (end < 0) return { ok: false, reason: '字面字符串未闭合' };
  if (text.slice(end + 1).trim().length > 0) return { ok: false, reason: '字符串后有多余内容' };
  return { ok: true, value: text.slice(1, end) };
}

/** 行内数组 `[1, 2]`（可嵌套；跨行数组未支持）。 */
function parseTomlArray(text: string): TomlValue {
  if (!text.endsWith(']')) return { ok: false, reason: '未支持的写法：跨行数组' };
  const inner = text.slice(1, -1).trim();
  if (inner.length === 0) return { ok: true, value: [] };
  const parts = splitTopLevel(inner, ',');
  if (parts === null) return { ok: false, reason: '行内数组无法切分' };
  const out: unknown[] = [];
  for (const part of parts) {
    const item = part.trim();
    if (item.length === 0) continue; // 尾逗号是合法 TOML
    const parsed = parseTomlValue(item);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return { ok: true, value: out };
}

function parseTomlValue(text: string): TomlValue {
  if (text.length === 0) return { ok: false, reason: '空值' };
  if (text.startsWith('"""') || text.startsWith("'''")) return { ok: false, reason: '未支持的写法：多行字符串' };
  if (text.startsWith('{')) return { ok: false, reason: '未支持的写法：内联表 {…}' };
  if (text.startsWith('"')) return parseTomlBasicString(text);
  if (text.startsWith("'")) return parseTomlLiteralString(text);
  if (text.startsWith('[')) return parseTomlArray(text);
  if (text === 'true' || text === 'false') return { ok: true, value: text === 'true' };
  if (/^[+-]?(inf|nan)$/.test(text)) {
    if (text.endsWith('nan')) return { ok: true, value: Number.NaN };
    return { ok: true, value: text.startsWith('-') ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY };
  }
  const plain = text.replace(/_/g, '');
  if (/^[+-]?\d+$/.test(plain)) return { ok: true, value: Number.parseInt(plain, 10) };
  if (/[.eE]/.test(plain) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(plain)) {
    return { ok: true, value: Number.parseFloat(plain) };
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(text) || /^\d{2}:\d{2}:\d{2}/.test(text)) {
    return { ok: false, reason: '未支持的写法：日期时间' };
  }
  return { ok: false, reason: '未支持的写法' };
}

/** 单个键（裸键 / 引号键）；点号键 = 未支持（返回 null）。 */
function parseTomlKey(text: string): string | null {
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text;
  const parsed = parseTomlValue(text);
  return parsed.ok && typeof parsed.value === 'string' ? parsed.value : null;
}

/** `a.b.c` 表头路径（各段裸键或引号键）。 */
function parseTomlPath(text: string): string[] | null {
  const parts = splitTopLevel(text, '.');
  if (parts === null || parts.length === 0) return null;
  const out: string[] = [];
  for (const part of parts) {
    const key = parseTomlKey(part.trim());
    if (key === null) return null;
    out.push(key);
  }
  return out;
}

/** 按表头路径下钻（沿途建表；撞上标量 = 冲突 → null）。 */
function descendTomlTables(root: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let current = root;
  for (const segment of path) {
    const existing = current[segment];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      current[segment] = next;
      current = next;
      continue;
    }
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) return null;
    current = existing as Record<string, unknown>;
  }
  return current;
}

/** 最小 TOML 文档解析：值树 + **未支持行**（原文与行号一并带出，绝不静默丢）。 */
function parseTomlDocument(text: string): { value: Record<string, unknown>; unsupported: TomlUnsupported[] } {
  const root: Record<string, unknown> = {};
  const unsupported: TomlUnsupported[] = [];
  const lines = text.split('\n');
  let table = root;
  /** 未支持的表头之后：键归属不可确定 ⇒ 后续键值一律如实标出（不静默塞错表）。 */
  let detached = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripTomlComment(raw).trim();
    if (line.length === 0) continue;
    const lineNo = i + 1;
    if (line.startsWith('[[')) {
      unsupported.push({ line: lineNo, text: raw.trim(), reason: '未支持的写法：数组表 [[…]]' });
      detached = true; // 之后的键归属不可确定——如实标出，不静默塞进上一张表
      continue;
    }
    if (line.startsWith('[')) {
      const header = /^\[(.*)\]$/.exec(line);
      const path = header ? parseTomlPath(header[1]) : null;
      const target = path ? descendTomlTables(root, path) : null;
      if (target === null) {
        unsupported.push({ line: lineNo, text: raw.trim(), reason: '未支持的表头写法' });
        detached = true;
        continue;
      }
      table = target;
      detached = false;
      continue;
    }
    const eq = findTomlEquals(line);
    if (eq < 0) {
      unsupported.push({ line: lineNo, text: raw.trim(), reason: '未支持的写法：不是 key = value' });
      continue;
    }
    const keyText = line.slice(0, eq).trim();
    const key = parseTomlKey(keyText);
    if (key === null) {
      unsupported.push({ line: lineNo, text: raw.trim(), reason: `未支持的写法：键名 ${keyText}` });
      continue;
    }
    const parsed = parseTomlValue(line.slice(eq + 1).trim());
    if (!parsed.ok) {
      unsupported.push({ line: lineNo, text: raw.trim(), reason: parsed.reason });
      continue;
    }
    if (detached) {
      unsupported.push({ line: lineNo, text: raw.trim(), reason: '未支持的表头之后——键归属无法确定（原行保留）' });
      continue;
    }
    if (Object.hasOwn(table, key)) {
      unsupported.push({ line: lineNo, text: raw.trim(), reason: `重复键 "${key}"（TOML 不允许；已保留后一次赋值）` });
    }
    table[key] = parsed.value;
  }
  return { value: root, unsupported };
}

function buildToml(text: string, b: Build): void {
  const doc = parseTomlDocument(text);
  pushValueRoot(b, '$', doc.value);
  if (doc.unsupported.length === 0) return;
  b.warnings.push(`未支持的 TOML 特性 ${doc.unsupported.length} 处（原文见树内「未支持的 TOML 特性」组）`);
  b.total += 1 + doc.unsupported.length;
  if (b.shown >= NODE_CAP) return;
  const budget = Math.max(0, NODE_CAP - b.shown - 1);
  const children: TreeNode[] = doc.unsupported.slice(0, budget).map((item) => ({
    key: `第 ${item.line} 行`,
    kind: 'error',
    preview: quote(item.text),
    error: item.reason,
    children: [],
  }));
  b.shown += 1 + children.length;
  b.roots.push({
    key: '未支持的 TOML 特性',
    kind: 'error',
    preview: `${doc.unsupported.length} 行（原文见下）`,
    children,
  });
}

/* ── xml（DOMParser）────────────────────────────────────────────────────── */

/** 元素 → 节点：属性 `@名`、文本 `#text`、注释 `#comment`、子元素按标签名（分组陈列）。 */
function xmlToNode(el: Element, b: Build): TreeNode {
  b.shown++;
  const attrs: TreeNode[] = [];
  for (const attr of Array.from(el.attributes)) {
    if (b.shown >= NODE_CAP) break;
    b.shown++;
    attrs.push({ key: `@${attr.name}`, kind: 'string', preview: quote(attr.value), children: [] });
  }
  const elements: TreeNode[] = [];
  const comments: TreeNode[] = [];
  let text = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 1) {
      if (b.shown >= NODE_CAP) continue; // 到顶不再下钻（截断横幅已说明）
      elements.push(xmlToNode(child as Element, b));
    } else if (child.nodeType === 3 || child.nodeType === 4) {
      text += child.nodeValue ?? '';
    } else if (child.nodeType === 8) {
      if (b.shown >= NODE_CAP) continue;
      b.shown++;
      comments.push({ key: '#comment', kind: 'string', preview: quote(child.nodeValue ?? ''), children: [] });
    }
  }
  const trimmed = text.trim();
  const isLeaf = attrs.length === 0 && elements.length === 0 && comments.length === 0;
  if (isLeaf) {
    return trimmed.length > 0
      ? { key: el.tagName, kind: 'string', preview: quote(trimmed), children: [] }
      : { key: el.tagName, kind: 'null', preview: '（空元素）', children: [] };
  }
  const children = [...attrs];
  if (trimmed.length > 0 && b.shown < NODE_CAP) {
    b.shown++;
    children.push({ key: '#text', kind: 'string', preview: quote(trimmed), children: [] });
  }
  children.push(...elements, ...comments);
  return { key: el.tagName, kind: 'object', preview: containerPreview('object', children.length), children };
}

/** 真实节点数（与 xmlToNode 同规则）。 */
function countXmlNode(el: Element): number {
  const elementChildren = Array.from(el.children);
  let text = '';
  let comments = 0;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 || child.nodeType === 4) text += child.nodeValue ?? '';
    else if (child.nodeType === 8) comments++;
  }
  let count = 1 + el.attributes.length + comments;
  for (const child of elementChildren) count += countXmlNode(child);
  const isLeaf = elementChildren.length === 0 && el.attributes.length === 0 && comments === 0;
  if (!isLeaf && text.trim().length > 0) count++;
  return count;
}

function buildXml(text: string, b: Build): void {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const parseError = doc.getElementsByTagName('parsererror')[0];
  if (parseError) {
    b.error = `XML 解析失败：${oneLine(parseError.textContent ?? '解析器未给出原因')}`;
    return;
  }
  const root = doc.documentElement;
  if (!root) {
    b.error = 'XML 解析失败：文档没有根元素';
    return;
  }
  b.total += countXmlNode(root);
  if (b.shown >= NODE_CAP) return;
  b.roots.push(xmlToNode(root, b));
}

/* ── 视图模型 ───────────────────────────────────────────────────────────── */

function buildTreeModel(text: string, ext: string): TreeModel {
  const lines = text.split('\n');
  const moreLines = lines.length > TREE_LINE_CAP;
  const windowLines = moreLines ? lines.slice(0, TREE_LINE_CAP) : lines;
  const warnings = moreLines ? [`已截断：只读前 ${TREE_LINE_CAP} 行（文件更长）`] : [];
  const b = newBuild(warnings);
  const windowText = windowLines.join('\n');
  if (ext === 'jsonl') buildJsonl(windowLines, b);
  else if (ext === 'yaml' || ext === 'yml') buildYaml(windowText, b);
  else if (ext === 'toml') buildToml(windowText, b);
  else if (ext === 'xml') buildXml(windowText, b);
  else buildJson(windowText, b);
  if (b.total > b.shown) b.warnings.push(`已截断：只显示前 ${NODE_CAP} 个节点（共 ${b.total} 个）`);
  return { roots: b.roots, error: b.error, warnings: b.warnings };
}

/* ── 渲染 ───────────────────────────────────────────────────────────────── */

/** 吸顶提示（截断 / 坏行 / 未支持特性）——多条并成一行，不堆叠吸顶条。 */
function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return <div className="pp-viewer-note">{notes.join(' · ')}</div>;
}

/** 单行节点（键名 + 类型徽记 + 值预览）；子层靠嵌套容器缩进（免内联样式）。 */
function renderNode(
  node: TreeNode,
  depth: number,
  path: string,
  toggled: ReadonlySet<string>,
  toggle: (path: string) => void,
) {
  const hasChildren = node.children.length > 0;
  const open = hasChildren && (depth < DEFAULT_OPEN_DEPTH ? !toggled.has(path) : toggled.has(path));
  return (
    <div className="pp-viewer-tree-node" key={path}>
      <div className="pp-viewer-tree-row">
        {hasChildren ? (
          <button
            type="button"
            className="pp-viewer-tree-toggle"
            aria-expanded={open}
            aria-label={`${open ? '折叠' : '展开'} ${node.key}`}
            onClick={() => toggle(path)}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="pp-viewer-tree-toggle" aria-hidden="true" />
        )}
        <span className="pp-viewer-tree-key">{node.key}</span>
        <span className="pp-viewer-tree-kind">{node.kind}</span>
        <span className="pp-viewer-tree-value">{node.preview}</span>
      </div>
      {node.error !== undefined && <div className="pp-viewer-tree-error">{node.error}</div>}
      {open && (
        <div className="pp-viewer-tree-children">
          {node.children.map((child, i) => renderNode(child, depth + 1, `${path}.${i}`, toggled, toggle))}
        </div>
      )}
    </div>
  );
}

function TreeViewer({ bytes, ext, mode }: ViewerProps) {
  const text = bytes?.kind === 'text' ? bytes.value : '';
  const model = useMemo(() => buildTreeModel(text, ext), [text, ext]);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set<string>());

  // 同一实例里换了内容（同路径重读）⇒ 折叠态归零；宿主换文件时本就换实例（key）
  useEffect(() => {
    setToggled(new Set<string>());
  }, [text]);

  // 结构化数据没有放大形态（浮层由宿主渲染，「看大图」语义对树无意义）
  if (mode === 'overlay') return null;
  if (text.trim().length === 0) return <div className="pp-viewer-empty">文件为空（无内容可解析）</div>;

  const toggle = (path: string) => {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (model.error !== null) {
    return (
      <div className="pp-viewer-box pp-viewer-tree">
        <Notes notes={model.warnings} />
        <div className="pp-viewer-error">{model.error}</div>
        <pre className="pp-viewer-tree-raw">{text}</pre>
      </div>
    );
  }
  return (
    <div className="pp-viewer-box pp-viewer-tree">
      <Notes notes={model.warnings} />
      {model.roots.map((node, i) => renderNode(node, 0, `r${i}`, toggled, toggle))}
    </div>
  );
}

export const treeViewer: ViewerDef = {
  id: 'tree',
  exts: VIEWER_TREE_EXTS,
  needsBytes: true,
  bytesKind: 'text',
  readLines: TREE_LINE_CAP,
  maxBytes: TREE_MAX_CHARS,
  component: TreeViewer,
};
