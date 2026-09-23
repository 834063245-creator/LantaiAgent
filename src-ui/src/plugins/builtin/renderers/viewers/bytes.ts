// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 查看器共用字节工具（P1）——`bytesOfDataUri` / UTF-8 嗅探。
// 产物域没有 Node Buffer；`atob` 在浏览器与 jsdom 都有。
// 取不到字节 = 空数组（调用方按空输入出可读提示，**不静默**）。

/** `data:<mime>;base64,<b64>` → 原始字节。非法 base64 → 空数组（调用方报可读错误）。 */
export function bytesOfDataUri(uri: string | undefined): Uint8Array {
  if (!uri) return new Uint8Array(0);
  const at = uri.indexOf('base64,');
  const b64 = at >= 0 ? uri.slice(at + 7) : uri;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

/** 严格 UTF-8 解码（失败 = null）——兜底查看器的「文本 vs 二进制」第一判据。 */
export function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 可打印字符占比（制表/换行/回车算可打印；用于把「能解码」升级成「像文本」）。 */
export function printableRatio(text: string): number {
  if (text.length === 0) return 0;
  let ok = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) ok++;
    else if (code >= 32 && code !== 127) ok++;
  }
  return ok / text.length;
}

/** 字节数 → 人类可读（B/KB/MB；归档列表与提示行共用）。 */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
