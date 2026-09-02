// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/sel-ink — 划词朱线（2026-09-02 视觉迭代：流区选区高亮从「洗底」改「手写朱笔」）。
//
// 语义（用户拍板 2026-09-02）：纸不动、只落墨——选中的文字以手写朱笔下划线
// 标记（古籍圈点/着重语汇），原生 ::selection 洗底在 .pp-region 内退役（壳层 CSS）。
// 朱砂=人：被人手划过的字落朱线，不刷颜料。
//
// 本文件是纯几何/纯绘制函数，零依赖纪律（同 selection.ts）：
//   - mergeSelectionLines：Range.getClientRects() 的碎片矩形 → 行盒
//     （同一行的多个内联片段合并成一条线，跨块选区天然多行）。
//   - selInkPaths：行盒 → 手写朱线 SVG path d 串（主笔 + 淡墨 echo 第二笔）。
//     手写感 = 逐点正弦微伏，相位由选区文本 hash 派生——同选区恒同线，
//     重排/重渲染不闪；末行收笔小挑钩（朱笔离纸的尾巴）。

/** 行盒（屏幕坐标——壳层渲染期现算，Range 活矩形随视口刷新，同 fabPos 范式） */
export interface SelInkLine {
  x0: number;
  x1: number;
  /** 下划线基线 y（行盒底上方一点——笔画落在字脚） */
  y: number;
  h: number;
}

/** 选中行（合并产物，供测试与壳层共用形状） */
interface Frag {
  left: number;
  top: number;
  right: number;
  bottom: number;
  h: number;
}

/**
 * 选区碎片矩形 → 行盒。Range.getClientRects() 对同一行会吐多个内联片段
 * （跨 inline 元素/标点断片），按「垂直重叠过半即同行」合并（比固定容差稳，
 * 行高自适应）；零宽/零高碎片（折叠边缘）跳过。
 */
export function mergeSelectionLines(
  rects: ArrayLike<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>,
): SelInkLine[] {
  const frags: Frag[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.width <= 0.5 || r.height <= 0.5) continue;
    frags.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, h: r.height });
  }
  frags.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: SelInkLine[] = [];
  let cur: Frag | null = null;
  for (const f of frags) {
    if (cur && f.top <= cur.bottom - Math.min(cur.h, f.h) * 0.5) {
      cur.left = Math.min(cur.left, f.left);
      cur.right = Math.max(cur.right, f.right);
      cur.bottom = Math.max(cur.bottom, f.bottom);
      cur.h = Math.max(cur.h, f.h);
    } else {
      if (cur) lines.push(toLine(cur));
      cur = { ...f };
    }
  }
  if (cur) lines.push(toLine(cur));
  return lines;
}

function toLine(f: Frag): SelInkLine {
  return {
    x0: Math.round(f.left * 2) / 2,
    x1: Math.round(f.right * 2) / 2,
    y: Math.round((f.bottom - Math.max(2.5, f.h * 0.16)) * 2) / 2,
    h: Math.round(f.h * 2) / 2,
  };
}

/** 选区种子：文本 hash（djb2）——同选区恒同线（相位稳定不闪） */
export function selSeedOf(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h;
}

/** 划词朱线绘制产物：主笔（seal 实线）+ echo（淡墨第二笔，浸墨双笔手法） */
export interface SelInkArt {
  mains: string[];
  echoes: string[];
}

/**
 * 行盒 → 手写朱线 SVG path d 串。
 * wobble：逐点正弦微伏 ±1.4px 内（相位/频率由种子与行序派生，末行收笔挑钩）；
 * echo：整体下移 1.2px 的淡墨第二笔（alpha 墨残影手法，同 folio-title 的浸墨语言）。
 */
export function selInkPaths(lines: SelInkLine[], seed: number): SelInkArt {
  const mains: string[] = [];
  const echoes: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const w = ln.x1 - ln.x0;
    if (w < 4) continue;
    const phase = (((seed ^ Math.imul(i + 1, 2654435761)) >>> 0) % 628) / 100;
    const n = Math.max(4, Math.min(22, Math.round(w / 46)));
    const amp = Math.min(1.4, 0.9 + ln.h * 0.02);
    const pts: Array<[number, number]> = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = ln.x0 + w * t;
      const y = ln.y + Math.sin(phase + t * (4.2 + (i % 3))) * amp * (0.55 + 0.45 * Math.sin(t * Math.PI));
      pts.push([x, y]);
    }
    // 末行收笔挑钩（向右上挑起再微微回落——朱笔离纸）
    if (lines.length > 0 && i === lines.length - 1) {
      const [ex, ey] = pts[pts.length - 1];
      pts.push([ex + 7, ey - 3.2], [ex + 11, ey - 2.4]);
    }
    mains.push(smoothPath(pts));
    echoes.push(
      smoothPath(pts.map(([x, y], k) => [x - (k === pts.length - 1 ? 2 : 0.8), y + 1.2] as [number, number])),
    );
  }
  return { mains, echoes };
}

/** 折线 → 平滑 path（相邻点中点为二次贝塞尔端点，控制点取原点——经典手绘平滑） */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return '';
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  let d = `M ${r1(pts[0][0])} ${r1(pts[0][1])}`;
  for (let k = 1; k < pts.length - 1; k++) {
    const mx = r1((pts[k][0] + pts[k + 1][0]) / 2);
    const my = r1((pts[k][1] + pts[k + 1][1]) / 2);
    d += ` Q ${r1(pts[k][0])} ${r1(pts[k][1])} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${r1(last[0])} ${r1(last[1])}`;
}
