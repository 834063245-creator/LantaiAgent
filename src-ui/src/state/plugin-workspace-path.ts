// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 工作区根围栏（插件工作区授权 · P1）——纯函数，无 RPC、无 DOM。
//
// 纪律：窗只能报「根令牌 + 工作区相对路径」；绝对路径的解释与围栏都在宿主。
// 这里做三件事：
//   ① 相对路径归一（拒绝绝对路径 / 盘符 / 回溯 / 反斜杠 / 控制字符）；
//   ② 根 + 相对路径拼接（Windows 盘符、POSIX 根、UNC 都认）；
//   ③ 判断一个绝对路径是否仍在根内（Windows 盘符/UNC 不区分大小写）。
//
// 注意：这是**宿主侧的粗围栏**，不是文件系统权限本身；真正的读写仍走
// fs_cap（其 resolve_* 会做 workspace/canonicalize）。两层都在，越界才稳。

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** 统一分隔符；保留 UNC 的前导 `//`。 */
export function toPosixPath(value: string): string {
  const raw = String(value ?? '').replace(/\\/g, '/');
  if (raw.startsWith('//')) return `//${raw.slice(2).replace(/\/+/g, '/')}`;
  return raw.replace(/\/+/g, '/');
}

/** 工作区根归一：去尾斜杠；盘符根保留 `D:/`；POSIX 根保留 `/`。 */
export function normalizeWorkspaceRoot(root: string): string {
  const posix = toPosixPath(root);
  if (!posix || posix === '/') return posix;
  const trimmed = posix.replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}/`;
  return trimmed;
}

/**
 * 相对路径归一。空串 = 根本身；其余必须落在根内。
 * @returns 归一后的相对路径（`a/b`），非法返回 null
 */
export function normalizeRelPath(rel: string): string | null {
  if (typeof rel !== 'string') return null;
  if (rel.includes('\0')) return null;
  for (const ch of rel) {
    if (ch.charCodeAt(0) < 0x20) return null;
  }
  const posix = rel.replace(/\\/g, '/');
  if (posix.startsWith('/') || WINDOWS_DRIVE.test(posix)) return null;
  if (posix.includes(':')) return null;
  const out: string[] = [];
  for (const segment of posix.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    out.push(segment);
  }
  return out.join('/');
}

/** 根 + 相对路径 → 绝对路径；非法返回 null。 */
export function joinWorkspacePath(root: string, rel: string): string | null {
  const rootNorm = normalizeWorkspaceRoot(root);
  if (!rootNorm) return null;
  const relNorm = normalizeRelPath(rel);
  if (relNorm == null) return null;
  if (!relNorm) return rootNorm;
  return rootNorm.endsWith('/') ? `${rootNorm}${relNorm}` : `${rootNorm}/${relNorm}`;
}

function foldCaseForRoot(root: string): (value: string) => string {
  return /^[A-Za-z]:/.test(root) || root.startsWith('//') ? (value) => value.toLowerCase() : (value) => value;
}

/** 绝对路径是否仍在根内（根自身算在内）。 */
export function isWithinWorkspace(root: string, absolutePath: string): boolean {
  const rootNorm = normalizeWorkspaceRoot(root);
  if (!rootNorm) return false;
  const target = toPosixPath(absolutePath).replace(/\/+$/, '');
  if (!target) return false;
  const fold = foldCaseForRoot(rootNorm);
  const rootFolded = fold(rootNorm).replace(/\/+$/, '');
  const targetFolded = fold(target);
  return (
    targetFolded === rootFolded ||
    targetFolded.startsWith(`${rootFolded}/`) ||
    (rootFolded.endsWith('/') && targetFolded.startsWith(rootFolded))
  );
}

/** 绝对路径 → 相对根的路径；不在根内返回 null。 */
export function relativeWorkspacePath(root: string, absolutePath: string): string | null {
  if (!isWithinWorkspace(root, absolutePath)) return null;
  const rootNorm = normalizeWorkspaceRoot(root);
  const target = toPosixPath(absolutePath).replace(/\/+$/, '');
  const fold = foldCaseForRoot(rootNorm);
  const rootFolded = fold(rootNorm).replace(/\/+$/, '');
  const targetFolded = fold(target);
  if (targetFolded === rootFolded) return '';
  return target.slice(rootFolded.length).replace(/^\/+/, '');
}

/** 内容版本（冲突检测/外部变更用；非加密）。 */
export function contentRevision(text: string): string {
  let hash = 0x811c9dc5;
  const source = String(text ?? '');
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${source.length.toString(36)}.${hash.toString(16).padStart(8, '0')}`;
}
