// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 流区纸性（材质批 2026-09-01）：每卷一张真纸——种子 = 卷 id 哈希（FNV-1a），
// 同卷恒同纸（重启/换页不换脸），卷卷大概率不重样（纹理相位 + 深浅抖动）。
// 纯函数、无环境依赖。消费面：PaperPanel 流区 style 注入 --sheet-ox/oy/j，
// CSS 侧（PaperPanel.css .pp-region）按参数取纸纹相位与水洗深浅。

/** FNV-1a 32 位（非密码学——短串稳定散布够用）；seed 变体让同串出多路独立哈希 */
function hash32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 一张流区纸的性格：纹理相位（px）+ 深浅抖动 j ∈ [0,1)（水洗 7% + 6%·j） */
export interface SheetCharacter {
  ox: number;
  oy: number;
  j: number;
}

/** 卷 id → 纸性。相位取 [0,1024)：大步长保证相邻卷大概率落进不同纤维区；
 *  j 取 h1 高 16 位——与 ox（低 10 位）位段不相交，近似独立。 */
export function sheetCharacter(sessionId: string): SheetCharacter {
  const h1 = hash32(sessionId, 0x811c9dc5);
  const h2 = hash32(sessionId, 0x9e3779b9);
  return {
    ox: h1 % 1024,
    oy: h2 % 1024,
    j: ((h1 >>> 16) % 1000) / 1000,
  };
}
