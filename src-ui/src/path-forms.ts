// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// path-forms — 跨层路径形态归一（无状态叶模块）。
//
// 由来（2026-11-24 会话文件引用批）：MSYS 的 `/d/HoloGramHG` 在 shell 侧
// 一直由 `agent/sticky-cwd` 归一；但会话流把同一串当 POSIX 绝对路径塞给
// Windows，点击必然 not found。归一判据只应有一份——本文件是唯一真源，
// shell 粘性 cwd 与会话文件引用共用。
//
// 只认两种 MSYS 盘符形态（其余返回 null，交给调用方按原语义处理）：
//   - MSYS2 标准 `/<drive>/...`（`/d/HoloGramHG`）
//   - Cygwin `/cygdrive/<drive>/...`（bundle 根缺 etc/fstab 时的退化形态）
// **单字母后必须紧跟 `/` 或结束**——否则 `/home/u/a.md` 会被误切成
// `h:/ome/u/a.md`（真正的 POSIX 绝对路径必须原样保留）。

const CYGDRIVE_PREFIX = /^\/cygdrive(\/|$)/i;
const CYGDRIVE_DRIVE = /^\/cygdrive\/([a-zA-Z])(?:\/|$)/i;
const MSYS_DRIVE = /^\/([a-zA-Z])(?:\/|$)/;

/** MSYS/Cygwin 盘符路径 → Windows 盘符路径（小写盘符；非该形态返回 null）。
 *  已经是 Windows 风格（`D:\` / `D:/`）的原样返回。 */
export function normalizeMsysPath(raw: string): string | null {
  const t = raw.trim();
  // cygdrive 形态必须先行判定（否则会被下面的单字母分支当成盘符 c）
  if (CYGDRIVE_PREFIX.test(t)) {
    const m = CYGDRIVE_DRIVE.exec(t);
    if (!m?.[1]) return null;
    const drive = m[1].toLowerCase();
    const rest = t.slice(m[0].length).replace(/^\/+/, '');
    return rest === '' ? `${drive}:/` : `${drive}:/${rest}`;
  }
  const m = MSYS_DRIVE.exec(t);
  if (m?.[1]) {
    const drive = m[1].toLowerCase();
    const rest = t.slice(m[0].length).replace(/^\/+/, '');
    return rest === '' ? `${drive}:/` : `${drive}:/${rest}`;
  }
  // 已经是 Windows 风格（pwsh 捕获路径）— 原样接受
  if (/^[a-zA-Z]:[\\/]/.test(t)) return t;
  return null;
}
