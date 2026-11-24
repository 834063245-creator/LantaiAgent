// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/file-ref — 「会话里引用到的文件」解析（2026-11-23 文件引用可点 · 相对路径批；
// 2026-11-24 可点判定收紧批）。
//
// 病灶（2026-11-24 真机复盘）：旧判据是「末尾有 .字母就算路径」，于是
// `doc.save` / `ctx.windows` / `.ts` / `composer-*.tsx` 全被做成可点；
// 相对路径只按工作区根拼，裸文件名/子目录相对写法全错；`~/.lantai/...` 被
// 拼上工作区根（Rust 明明会展开 `~`）；shell 的 MSYS `/d/...` 被当 POSIX
// 绝对路径。结果：可点 1306 个，971 个点开是 os error 2。
//
// 本文件只负责「这串文本像不像本机文件引用、逻辑绝对路径是什么」：
//   ① 绝对路径（盘符 / UNC / POSIX 根）原样归一；MSYS/Cygwin 盘符形态先转
//      Windows（判据真源 `path-forms.ts`）；
//   ② `~/` / `~\` 原样保留（Rust `resolve_path_user_read` 会展开；
//      前端拼根反而把 home 路径变成工作区内不存在的垃圾）；
//   ③ 相对路径：`./ ../` 前缀，或「有非空文件名前缀 + 已知文件后缀」——
//      纯后缀（`.ts`）与点号标识符（`doc.save`/`ctx.windows`）一律 null；
//   ④ glob/占位符（`*` `?` `[]` `{}` `<>` `…`）一律 null（不是文件）；
//   ⑤ URL / 页内锚点 / 含空白 → null；`#L24` 与 `:24` 行后缀剥掉；
//   ⑥ 返回逻辑绝对路径（正斜杠）；**不做存在性检查**——存在性/是否目录/
//      是否文卷可打开，统一由渲染前的 `fs_cap stat` 门禁裁决（见
//      `plugins/builtin/paper-renderers/file-open.ts`）。

import { normalizeMsysPath } from '../path-forms';
import { fileUrlToLocalPath } from './markdown';

/** 盘符形态 D:\ 或 D:/（Windows 绝对路径）。 */
const DRIVE_RE = /^[A-Za-z]:[\\/]/;
/** 任一 URL scheme（盘符会被本判据误读成 d:，故调用方先排除盘符）。 */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** glob / 占位符：这些不是可打开的文件路径。 */
const GLOB_RE = /[*?[\]{}<>…]/;
/** 行后缀 :24 / :24-30（纯数字才剥，避免吃掉路径里的冒号）。 */
const LINE_SUFFIX_RE = /:\d+(?:-\d+)?$/;

/** 文卷能打开的文本/代码后缀——与 `examples/plugins/md-editor/app/js/pure.js`
 *  的 `docKindOf` 同一集（那边是产品白名单；新增类型两边同步）。 */
const OPENABLE_DOC_EXT = new Set([
  'md',
  'markdown',
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
  'js',
  'javascript',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'json',
  'jsonc',
  'py',
  'pyw',
  'rs',
  'go',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'cs',
  'dart',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'psm1',
  'sql',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'xml',
  'svg',
  'yml',
  'yaml',
  'toml',
  'dockerfile',
  'lua',
  'r',
  'php',
  'rb',
  'swift',
  'scala',
  'groovy',
  'pl',
  'sol',
]);

/** 无后缀特殊文件名（文卷可打开；与 `docKindOf` 的 SPECIAL_NAMES 同集）。 */
const SPECIAL_DOC_NAMES = new Set([
  'makefile',
  'gnumakefile',
  'dockerfile',
  'containerfile',
  'readme',
  'license',
  'licence',
  'notice',
  'changelog',
  'authors',
  'contributing',
]);

/** 「像文件」的后缀——比文卷可打开集宽：图片/压缩/可执行也算文件引用
 *  （可交给别的插件或系统程序），只用来把点号标识符挡在门外。 */
const KNOWN_FILE_EXT = new Set([
  ...OPENABLE_DOC_EXT,
  // 图片 / 文档 / 压缩 / 可执行 / 媒体 / 数据
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'ico',
  'tif',
  'tiff',
  'avif',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'zip',
  'gz',
  'tgz',
  'tar',
  '7z',
  'rar',
  'bz2',
  'xz',
  'exe',
  'msi',
  'dll',
  'so',
  'dylib',
  'asar',
  'node',
  'wasm',
  'bin',
  'jar',
  'class',
  'pyc',
  'mp3',
  'wav',
  'flac',
  'ogg',
  'm4a',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  'db',
  'sqlite',
  'sqlite3',
  'ldb',
  'ndjson',
  'jsonl',
  'lock',
  'map',
  'min',
  'tsbuildinfo',
  'bak',
  'tmp',
]);

/** 无前缀的根级点文件（.gitignore 这类没有「文件名前缀」但确实是文件）。 */
const ROOT_DOTFILES = new Set([
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.env',
  '.dockerignore',
  '.prettierignore',
  '.prettierrc',
  '.eslintignore',
  '.eslintrc',
  '.babelrc',
  '.nvmrc',
]);

/** 绝对路径形态（盘符 / UNC / POSIX 根）。 */
export function isAbsoluteLocalPath(p: string): boolean {
  return DRIVE_RE.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

/** 逻辑路径归一：反斜杠换正斜杠、消 . / .. 段、去空段与尾斜杠。
 *  .. 越过盘符根/POSIX 根时**夹住**（D:/../x → D:/x）；相对形态才留 ..。 */
export function normalizeLocalPath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  const prefix = slashed.startsWith('//') ? '//' : slashed.startsWith('/') ? '/' : '';
  const body = prefix === '//' ? slashed.slice(2) : prefix === '/' ? slashed.slice(1) : slashed;
  const out: string[] = [];
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      const last = out[out.length - 1];
      // 根边界：盘符根（D:）/ UNC 根（//server/share）不参与弹栈；POSIX 根弹空即止
      const atRoot =
        prefix === '//'
          ? out.length <= 2
          : prefix === '/'
            ? out.length === 0
            : out.length === 1 && DRIVE_RE.test(`${last}/`);
      if (last !== undefined && last !== '..') {
        if (!atRoot) out.pop(); // 越过根的 .. 夹住：丢掉，不落进路径
      } else if (prefix === '') {
        out.push('..'); // 相对形态才留 ..（调用方拼根后再归一时夹根）
      }
      continue;
    }
    out.push(seg);
  }
  return prefix + out.join('/');
}

/** %XX 解码（畸形转义原样交付——读取端自会报错，不在此静默丢）。 */
function decodePercent(s: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? '';
}

function extOf(name: string): string {
  const base = baseName(name).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

/** 文卷/文档通道能直接打开的路径（存在性另由 stat 门禁裁决）。 */
export function isOpenableDocumentPath(p: string): boolean {
  const base = baseName(p).toLowerCase();
  if (base === '') return false;
  if (SPECIAL_DOC_NAMES.has(base)) return true;
  const ext = extOf(base);
  return ext !== '' && OPENABLE_DOC_EXT.has(ext);
}

/** 「像文件」：已知文件后缀，或根级点文件/无后缀特殊文件名。 */
function hasKnownFileExt(name: string): boolean {
  const base = baseName(name);
  const lower = base.toLowerCase();
  if (SPECIAL_DOC_NAMES.has(lower) || ROOT_DOTFILES.has(lower)) return true;
  const ext = extOf(lower);
  return ext !== '' && KNOWN_FILE_EXT.has(ext);
}

/** 文件名前缀非空（`.ts` / `.png` 这类纯后缀不是文件）。 */
function hasStem(name: string): boolean {
  const base = baseName(name);
  const lower = base.toLowerCase();
  if (ROOT_DOTFILES.has(lower) || SPECIAL_DOC_NAMES.has(lower)) return true;
  return base.lastIndexOf('.') > 0;
}

/** 相对路径判据：显式 ./ ../ 前缀，或「非空文件名前缀 + 已知文件后缀」。 */
function isRelativeRef(s: string): boolean {
  if (/^\.\.?[\\/]/.test(s)) return true;
  return hasStem(s) && hasKnownFileExt(s);
}

/** 一段**完整**文本（Markdown 链接 destination / 行内码全文）→ 逻辑绝对路径。
 *  不是本机文件引用 ⇒ null（调用方据此决定「可不可点」）。 */
export function resolveFileReference(raw: string, root: string): string | null {
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  if (s === '' || s.startsWith('#')) return null;
  // 空白 = 不是单个路径（旧绝对路径判据同款；含空白的路径请用 %20 编码）
  if (/\s/.test(s)) return null;
  // 页内锚点 / 行锚片段：docs/a.md#L24 → docs/a.md
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  if (s === '') return null;
  // Windows 扩展前缀 \\?\ 剥壳；设备命名空间 \\.\ 一律不认
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  else if (s.startsWith('\\\\.\\')) return null;
  s = s.replace(LINE_SUFFIX_RE, '');
  if (s === '') return null;
  // glob / 占位符：不是单个文件
  if (GLOB_RE.test(s)) return null;

  // ~ 路径原样保留：Rust resolve_path_user_read 会展开（先于方案检查）
  if (s.startsWith('~')) {
    if (s !== '~' && !s.startsWith('~/') && !s.startsWith('~\\')) return null;
    const rest = s.slice(1).replace(/\\/g, '/');
    return rest === '' ? '~' : `~${rest.startsWith('/') ? rest : `/${rest}`}`;
  }
  if (s.startsWith('file:')) {
    const p = fileUrlToLocalPath(s);
    if (p === undefined) return null;
    const decoded = decodePercent(p);
    const msys = normalizeMsysPath(decoded);
    return normalizeLocalPath(msys ?? decoded);
  }
  if (SCHEME_RE.test(s) && !DRIVE_RE.test(s)) return null;
  const decoded = decodePercent(s);
  const msys = normalizeMsysPath(decoded);
  if (msys !== null) return normalizeLocalPath(msys);
  if (isAbsoluteLocalPath(decoded)) return normalizeLocalPath(decoded);
  if (!isRelativeRef(decoded)) return null;
  const base = normalizeLocalPath(root);
  if (base === '') return null;
  return normalizeLocalPath(`${base}/${decoded}`);
}

/** 本机文件引用形态（含 `~` / MSYS / 绝对 / 相对）——链接面据此区分
 *  「外部 URL」与「本地路径」；外部 URL 返回 null。 */
export function isLocalFileReference(raw: string, root: string): boolean {
  return resolveFileReference(raw, root) !== null;
}

/** 相对引用在常见子根下的候选（模型常把 `src-ui/src` 下的路径写成
 *  `src/...` / `tests/...`；工作区根解析不中时再按这些子根试）。
 *  裸文件名不猜（同名文件太多，猜错比不可点更糟）；绝对路径 / `~` 不猜。 */
const RELATIVE_BASES = [
  'src-ui',
  'src-ui/src',
  'src-ui/src/app',
  'src-ui/src/plugins',
  'src-ui/src/plugins/builtin',
  'src-ui/tests',
  'src-tauri',
  'src-tauri/src',
  'engine',
  'docs',
  'plugins',
  'scripts',
  'tests',
];

export function candidateFileRefs(raw: string, root: string): string[] {
  const direct = resolveFileReference(raw, root);
  if (direct === null) return [];
  const trimmed = raw.trim();
  // 绝对 / ~ / file: / URL 形态不猜子根（只有「相对写法」才可能写短）
  if (
    trimmed.startsWith('~') ||
    trimmed.startsWith('file:') ||
    isAbsoluteLocalPath(trimmed) ||
    SCHEME_RE.test(trimmed)
  ) {
    return [direct];
  }
  const base = normalizeLocalPath(root);
  if (base === '' || !direct.startsWith(`${base}/`)) return [direct];
  const rel = direct.slice(base.length + 1);
  if (!rel.includes('/') || rel.includes('..')) return [direct];
  const out = [direct];
  for (const b of RELATIVE_BASES) {
    const p = normalizeLocalPath(`${base}/${b}/${rel}`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
