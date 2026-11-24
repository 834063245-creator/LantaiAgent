// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 文卷窗内的纯函数层——不碰 DOM、不碰桥、不碰宿主。
// 单测在 src-ui/tests/wenjuan-pure.test.ts（Node 环境直接 import）。

/** 路径最后一段（同时认 / 与 \）。 */
export function basename(path) {
  const text = String(path ?? '').replace(/\\/g, '/');
  const idx = text.lastIndexOf('/');
  return idx >= 0 ? text.slice(idx + 1) : text;
}

/** 目录部分（不含末尾 /）；根目录返回空串。 */
export function dirname(path) {
  const text = String(path ?? '').replace(/\\/g, '/');
  const idx = text.lastIndexOf('/');
  return idx >= 0 ? text.slice(0, idx) : '';
}

/** 插件数据地盘内的相对路径围栏：只许向下的相对路径，禁止盘符/回溯/空段。 */
export function isSafeRelPath(path) {
  if (typeof path !== 'string') return false;
  if (!path || path.length > 1024) return false;
  if (/[\u0000-\u001f]/.test(path)) return false;
  if (path.includes('\\') || path.includes(':')) return false;
  if (path.startsWith('/') || path.endsWith('/')) return false;
  const segments = path.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return false;
  return true;
}

/** 新建文档名归一：非法字符换 -，去首尾点/空白，补 .md；空名返回 null。 */
export function normalizeDocName(input) {
  if (typeof input !== 'string') return null;
  let name = input.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!name) return null;
  if (!/\.md$/i.test(name)) name += '.md';
  if (name.length > 120) name = `${name.slice(0, 112).replace(/\.md$/i, '')}.md`;
  return name;
}

/* ── 文件分类：Markdown / 代码 / 纯文本 ──
 * 只认明确白名单；二进制/未知扩展名一律不冒充文本（树里仍可看见，点开时具名拒绝）。
 * language 供 CodeMirror 选 parser；plain = 可编辑但无语法高亮。 */
const MARKDOWN_EXT = new Set(['md', 'markdown']);
const TEXT_EXT = new Set([
  'txt',
  'text',
  'log',
  'csv',
  'tsv',
  'diff',
  'patch',
  'ini',
  'cfg',
  'conf',
  'properties',
  'env',
]);
const CODE_LANG = Object.freeze({
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  dart: 'dart',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  xml: 'html',
  svg: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  dockerfile: 'dockerfile',
  lua: 'plain',
  r: 'plain',
  php: 'plain',
  rb: 'plain',
  swift: 'plain',
  scala: 'plain',
  groovy: 'plain',
  pl: 'plain',
  sol: 'plain',
});
const SPECIAL_NAMES = Object.freeze({
  makefile: 'plain',
  gnumakefile: 'plain',
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  readme: 'plain',
  license: 'plain',
  licence: 'plain',
  notice: 'plain',
  changelog: 'plain',
  authors: 'plain',
  contributing: 'plain',
});

/**
 * 文件名 → { kind: 'markdown'|'code'|'text', language }；不认识返回 null。
 * 代码文件 language 是 CM parser 名；text 用 'plain'（可编辑、无高亮）。
 */
export function docKindOf(name) {
  const base = basename(name).toLowerCase();
  if (!base) return null;
  const special = SPECIAL_NAMES[base];
  if (special) return { kind: special === 'markdown' ? 'markdown' : special === 'plain' ? 'text' : 'code', language: special };
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1) : '';
  if (!ext) return null;
  if (MARKDOWN_EXT.has(ext)) return { kind: 'markdown', language: 'markdown' };
  if (CODE_LANG[ext]) {
    const language = CODE_LANG[ext];
    return { kind: language === 'plain' ? 'text' : 'code', language };
  }
  if (TEXT_EXT.has(ext)) return { kind: 'text', language: 'plain' };
  return null;
}

/** 能进文卷文本面的文件（Markdown / 代码 / 纯文本）。 */
export function isDocumentName(name) {
  return docKindOf(name) != null;
}

/** 是否 Markdown（决定预览/大纲/分栏）。 */
export function isMarkdownName(name) {
  return docKindOf(name)?.kind === 'markdown';
}

/** CodeMirror 语言名（未知 → plain）。 */
export function languageOf(name) {
  return docKindOf(name)?.language ?? 'plain';
}

/** 插件自己的状态/草稿文件不冒充可编辑文档（state.json、drafts/ 下）。 */
export function isPluginInternalName(name) {
  const text = String(name ?? '').replace(/\\/g, '/');
  return basename(text).toLowerCase() === 'state.json' || text.startsWith('drafts/');
}

/** FNV-1a 32 位（非加密；只用于草稿键/外部变更判等）。 */
export function hashText(text) {
  let hash = 0x811c9dc5;
  const source = String(text ?? '');
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 草稿文件名：kind + 路径的稳定哈希（同一文档重开命中同一份草稿）。 */
export function draftFileName(kind, path) {
  return `${kind}-${hashText(`${kind}\u0000${path}`)}.json`;
}

function stripInline(raw) {
  return String(raw ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .trim();
}

/**
 * YAML frontmatter 拆分（只认首块；不解析嵌套结构，值按字面）。
 * 返回 bodyLineOffset = body 第一行在原文中的行下标（0 基）。
 */
export function splitFrontmatter(text) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  if (!/^---[ \t]*\r?$/.test(lines[0] ?? '')) {
    return { frontmatter: '', body: source, fields: [], bodyLineOffset: 0 };
  }
  let end = -1;
  for (let i = 1; i < Math.min(lines.length, 200); i += 1) {
    if (/^(---|\.\.\.)[ \t]*\r?$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { frontmatter: '', body: source, fields: [], bodyLineOffset: 0 };
  const fields = [];
  for (const line of lines.slice(1, end)) {
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields.push({ key: kv[1], value });
  }
  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
    fields,
    bodyLineOffset: end + 1,
  };
}

/**
 * 目录大纲：ATX + Setext 标题；跳过围栏代码块与 frontmatter。
 * @returns {{ level: number, text: string, line: number }[]} line 从 1 开始
 */
export function extractOutline(text) {
  const split = splitFrontmatter(text);
  const lines = split.body.split('\n');
  const offset = split.bodyLineOffset;
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(raw);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (atx) {
      out.push({ level: atx[1].length, text: stripInline(atx[2]), line: offset + i + 1 });
      continue;
    }
    if (i + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1]) && raw.trim()) {
      out.push({ level: lines[i + 1].trim()[0] === '=' ? 1 : 2, text: stripInline(raw), line: offset + i + 1 });
      i += 1;
    }
    if (out.length >= 800) break;
  }
  return out;
}

/** 字数：CJK 字符逐个计，拉丁按词计；另给行数与去空白字符数。 */
export function countText(text) {
  const source = String(text ?? '');
  const cjk = (source.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latinWords = (source.match(/[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*/g) || []).length;
  const chars = source.replace(/\s/g, '').length;
  return {
    chars,
    words: cjk + latinWords,
    lines: source ? source.split('\n').length : 0,
  };
}

/** 相对链接解析（Markdown 预览点击用）：只允许落在同一数据地盘内。 */
export function resolveLocalHref(href, currentPath) {
  const rawHref = String(href ?? '');
  if (!rawHref || rawHref.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawHref) || rawHref.startsWith('//')) {
    return { external: true, href: rawHref };
  }
  const rawPath = rawHref.split(/[?#]/)[0];
  if (!rawPath) return null;
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // 非法 percent 编码按原样处理（不静默丢链接）
  }
  if (decoded.startsWith('/') || decoded.includes('\\')) return null;
  const parts = (dirname(currentPath) ? dirname(currentPath).split('/') : []).concat(decoded.split('/'));
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return { external: false, path: stack.join('/') };
}

/** 模糊匹配：子序列命中；basename/路径段首命中加权。返回 -1 = 不匹配。 */
export function fuzzyScore(query, text) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return 1;
  const target = String(text ?? '').toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < target.length && qi < q.length; i += 1) {
    if (target[i] !== q[qi]) continue;
    score += i === last + 1 ? 3 : 1;
    if (i === 0 || /[/\\_. -]/.test(target[i - 1])) score += 2;
    last = i;
    qi += 1;
  }
  if (qi !== q.length) return -1;
  return score - target.length * 0.01;
}

/** 相对时间（状态栏/最近列表用）。 */
export function relativeTime(timestamp, now = Date.now()) {
  const delta = Math.max(0, now - Number(timestamp || 0));
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return '刚刚';
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
  if (delta < 30 * day) return `${Math.floor(delta / day)} 天前`;
  const date = new Date(Number(timestamp));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
