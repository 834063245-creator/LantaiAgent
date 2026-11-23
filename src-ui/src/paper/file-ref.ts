// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/file-ref — 「会话里引用到的文件」解析（2026-11-23 文件引用可点 · 相对路径批）。
//
// 病灶：可点三面（来文附件卡 / 工具卡参数 / 正文行内码）原先只认**绝对路径**
// （旧 firstAbsolutePath + 一条 ABS_PATH_RE），正文里的 Markdown 链接 [x](docs/a.md)
// 更只是 target=_blank 的裸 <a>——相对路径没有「从哪算起」的共识，宿主拿到读不了，
// 于是模型最自然的写法（仓库相对路径）恰好点不开。
//
// 判据（本文件 = 唯一真源）：
//   ① 基准 = **工作区根**（useShellStore.projectPath）——与工具面「相对路径按工作区根
//      解析」同一条约定；不取 shell 粘性 cwd（跨域不耦合 shell 状态）；
//   ② 绝对路径（盘符 / UNC / POSIX 根）原样归一，不查根；
//   ③ 相对路径：./ ../ 前缀、带分隔符、或带文件扩展名（裸词 npm 不算路径）——
//      拼根后消 . / .. 段；越过盘符根的 .. 夹在根上（不把 .. 甩给 Rust）；
//   ④ 非本机文件（http/https/mailto/data/其它 scheme）与页内锚点（#...）一律 null；
//   ⑤ #L24 片段与 :24 / :24-30 行后缀剥掉（行号当前无落点面，路径才是打开目标）；
//   ⑥ 含空白的一律不认（旧判据同款：命令/句子不是路径）；%20 这类编码在判定后解码。
//
// 返回**逻辑绝对路径**（正斜杠——Rust 沙箱两种分隔符都认）；不做存在性检查：同步渲染面
// 无法 stat，读失败由窗内可读错误承担（错误不静默），不在此假装成功也不假装不存在。

import { fileUrlToLocalPath } from './markdown';

/** 盘符形态 D:\ 或 D:/（Windows 绝对路径）。 */
const DRIVE_RE = /^[A-Za-z]:[\\/]/;
/** 任一 URL scheme（盘符会被本判据误读成 d:，故调用方先排除盘符）。 */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** 文件扩展名：点 + 字母开头（v1.2.3 的 .3 不算，.md/.ts 算）。 */
const FILE_EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,11}$/;
/** 工具卡参数里的候选 token 分隔（含全角冒号：键名与值拆开；反引号用 \x60 写，免与模板字面量冲突）。 */
const TOKEN_SPLIT_RE = /[\s,;:：，；、"'()（）[\]<>\x60]+/;
/** token 尾部标点（句读/括号后的路径不至于连标点一起进路径）。 */
const TOKEN_TRAIL_RE = /[.,;:!?，。；：！？]+$/;
/** 绝对路径扫描（与旧 ABS_PATH_RE 逐字同款——工具卡参数/正文同一判据）。 */
const ABS_PATH_RE = /(?:^|[\s"'([=:])([A-Za-z]:[\\/][^\s"'<>|,)\]]+|\\\\[^\s"'<>|,)\]]+|\/[\w.-]+(?:\/[\w.-]+)*)/;

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
            : out.length === 1 && DRIVE_RE.test(last + '/');
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

/** 相对路径判据：显式 ./ ../ 前缀，或**末段带扩展名**。
 *  只带分隔符不算（2026/11/23 这类日期/分数以及无扩展名目录 token 会误判）。 */
function isRelativeRef(s: string): boolean {
  if (/^\.\.?[\\/]/.test(s)) return true;
  return FILE_EXT_RE.test(s);
}

/** 一段**完整**文本（Markdown 链接 destination / 行内码全文）→ 逻辑绝对路径。
 *  不是本机文件引用、或相对路径但无工作区根 ⇒ null（调用方据此决定「可不可点」）。 */
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
  // 行后缀 :24 / :24-30（纯数字才剥，避免吃掉路径里的冒号）
  s = s.replace(/:\d+(?:-\d+)?$/, '');
  if (s === '') return null;

  if (s.startsWith('file:')) {
    const p = fileUrlToLocalPath(s);
    return p === undefined ? null : normalizeLocalPath(decodePercent(p));
  }
  if (SCHEME_RE.test(s) && !DRIVE_RE.test(s)) return null;
  const decoded = decodePercent(s);
  if (isAbsoluteLocalPath(decoded)) return normalizeLocalPath(decoded);
  if (!isRelativeRef(decoded)) return null;
  const base = normalizeLocalPath(root);
  if (base === '') return null;
  return normalizeLocalPath(base + '/' + decoded);
}

/** 展示文本（工具卡参数面）里第一条文件引用——绝对路径优先，其次带扩展名的相对 token。
 *  只服务「段头打开签」：自由文本里捞路径必须保守，裸词/日期/URL 都不算。 */
export function firstFileReference(text: string, root: string): string | null {
  const abs = ABS_PATH_RE.exec(text);
  if (abs) {
    const hit = resolveFileReference(abs[1], root);
    if (hit !== null) return hit;
  }
  for (const token of text.split(TOKEN_SPLIT_RE)) {
    const t = token.replace(TOKEN_TRAIL_RE, '');
    if (t === '' || isAbsoluteLocalPath(t)) continue;
    // 相对候选：带扩展名，或显式 ./ ../；纯目录 token（2026/11/23）不认
    if (!/^\.\.?[\\/]/.test(t) && !FILE_EXT_RE.test(t)) continue;
    const hit = resolveFileReference(t, root);
    if (hit !== null) return hit;
  }
  return null;
}
