// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/toc-ink — 目次带识别层（乙）的墨迹聚合：行盒 → 带内桶（纯几何/纯数值，零 DOM）。
//
// 职责：canvas 只负责把桶画出来，桶怎么算由本模块单一决定——测试在纯层钉算法。
//
// 算法（2026-09-14 用户拍板「F」：形 + 墨量 + 族色 + 错；原型
// prototype/toc-thumb-ab.html 逐案实测定档，不入库）：
//   - **形状** = 桶内最宽行的右缘（剪影——「散文参差 / 代码成 slab / 表格整宽」）；
//   - **墨量** = 桶内墨面积（行宽和）开方归一 → alpha 深浅（答「哪里长／哪里密」）；
//   - **族色** = 桶内最宽行的块 kind（调用方映射 inkBarColorOf——墨色真源仍在
//     paper/ink.ts；形状行定色：那根就是你眼睛看的那根）；
//   - **错**   = 桶内任一行属报错块 → err 旗（调用方另立 `--fail` 短规：错要最响）。
//
// 为什么按桶而不逐行直画：带内缩放比常见 0.005–0.012（长卷 10 万世界 px → 1 千 px 带），
// 行距 / 缩进 / 块间留白 **全在 1px 之下**——逐行直画即糊。v2 的「每块首行一根
// 1.2px 细条 + 块级降级」更退化成等距点阵（实机空行率 0.42–0.81），用户读作
// 「滚动条」；桶是带内唯一诚实的竖向原语（同款判据见规格书 §13）。
// 淘汰案（同一把尺子判死，勿复活）：缩进剪影（缩进 19 世界 px = 带内 0.1px，
// 与剪影案像素差 0.001）、阶段分带（阶段界已由可点层承担，差 0.003）。

import type { TocRange } from './toc';

/** 带内桶高（px）——原型 F 同值（3px：长卷带高千余 px → 三四百桶，桶内 3–6 行）。 */
export const TOC_INK_BUCKET = 3;
/** 墨量档下限（alpha）——最疏的有墨桶也留可见墨（空桶不着墨，故下限不服务空处）。 */
export const TOC_INK_ALPHA_FLOOR = 0.18;

/** 行盒 → 桶的最小输入——调用方（TocStrip）负责世界坐标换算与夹紧，本模块不碰槽位。 */
export interface TocInkLine {
  /** 行盒顶相对内容顶的带内偏移（px；值域 0 ↔ 带高） */
  rel: number;
  /** 行盒右缘（带内 px，已夹到 [0, 带宽]） */
  right: number;
  /** 行盒墨面积（带内 px = 行宽 × 横向缩放） */
  area: number;
  /** 块 kind（墨色族真源：inkBarColorOf） */
  kind: string;
  /** 该行所属块是否报错（deriveMarks 的 error 集） */
  err: boolean;
}

/** 带内墨桶（绘制面：TocStrip 逐条 fillRect + 错桶另立 fail 短规）。 */
export interface TocInkBucket {
  /** 桶顶（页面坐标 = range.stripTop + k × bucket）——恒 ≥ stripTop（不越出带体顶） */
  top: number;
  /** 桶高（末桶夹到带底；恒 ≤ bucket） */
  height: number;
  /** 形状：桶内最宽行的右缘 */
  width: number;
  /** 墨量：TOC_INK_ALPHA_FLOOR + (1−floor) × √(桶内面积 / 全带最大桶面积) */
  alpha: number;
  /** 族色：定形那行的块 kind */
  kind: string;
  /** 桶内任一行报错 */
  err: boolean;
}

/** 行盒序列 → 带内墨桶（竖向有序；带外桶不出）。 */
export function buildTocInkBuckets(
  lines: readonly TocInkLine[],
  range: TocRange,
  bucket: number = TOC_INK_BUCKET,
): TocInkBucket[] {
  const bins = new Map<number, { w: number; area: number; kind: string; err: boolean }>();
  for (const l of lines) {
    const k = Math.floor(l.rel / bucket);
    const cur = bins.get(k);
    if (!cur) {
      bins.set(k, { w: l.right, area: l.area, kind: l.kind, err: l.err });
      continue;
    }
    cur.area += l.area;
    if (l.right > cur.w) {
      // 形状行定色：桶里你看得见的那根决定「这是什么」
      cur.w = l.right;
      cur.kind = l.kind;
    }
    if (l.err) cur.err = true;
  }
  let maxArea = 1;
  for (const v of bins.values()) if (v.area > maxArea) maxArea = v.area;

  const out: TocInkBucket[] = [];
  // 桶序 = 竖向序（Map 插入序在输入乱序时不可靠；绘制序与读数序必须一致）
  for (const k of [...bins.keys()].sort((a, b) => a - b)) {
    const v = bins.get(k);
    if (!v) continue;
    const top = range.stripTop + k * bucket;
    const height = Math.min(bucket, range.stripBottom - top);
    if (height <= 0) continue; // 桶落在带底之下 → 不出（带外不画）
    out.push({
      top,
      height,
      width: v.w,
      alpha: TOC_INK_ALPHA_FLOOR + (1 - TOC_INK_ALPHA_FLOOR) * Math.sqrt(v.area / maxArea),
      kind: v.kind,
      err: v.err,
    });
  }
  return out;
}
