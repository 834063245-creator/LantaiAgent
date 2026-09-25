// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/measure-contract — 测量引擎**契约面**（批 9c-4a，2026-09-26）。
//
// 背景（账本 §6.5 的 9c-4 判定 + 施工单 `measure-engine-seam-design.md`）：`paper/measure.ts`
// （2,016 行）与 `paper/type-tokens.ts`（807 行）是**同一台机器**——墨迹走查路径引用了 25 个镜像
// 常量里的 23 个、十张 token 表在测高里出现 200+ 次 ⇒ **机械切分不成立**；唯一可行路径是把整台
// 引擎做成产物登记的实现（批 6/7/8 同款接缝）。
//
// 本文件是那条路的第一步（9c-4a）：**内核读面**的形状定义。内核侧只有两个真读点——
//   - `paper/ink.ts`：`inkSourcesFor` / `measureSignature`（墨迹走查与块级测高同一台引擎）；
//   - `state/messages-store.ts`：`clearObservedHeightsForSession`（会话切换清观察高度账）。
// 其余导出（十张表、几十个派生常量、测高 API）目前由**同一批产物**（paper-shell 与经宿主桥的
// 其它产物）消费，随 9c-4b 一起进包；因此本契约面**只上收内核真读的三个动词**——契约面越小越稳
// （几何面/工具面的演化不该触发内核契约变更）。

import type { RichInlineItem } from '@chenglou/pretext/rich-inline';
import type { SourcedBlock } from './block-model';

/** 一处墨迹（逐字上收自 `measure.ts`；`inkSourcesFor` 的产出元素）。
 *  纵向位置现在只有**一个**产出者：测高走查（墨迹与测高共用同一把尺子）。 */
export interface InkSource {
  text: string;
  font: string;
  lineHeight: number;
  /** 横向内缩（世界单位——墨条起点 = 块左缘 + inset） */
  inset: number;
  /** 纵向偏移（世界单位——源顶距块顶，含块级 chrome 与元素间间距） */
  y: number;
  /** 行条上限（pre/output 族按 PRE_MAX_H/OUT 族镜像，缺省不封顶） */
  cap?: number;
  /** 富行内片段（2026-09-20 富行内折行批）：**仅当测高走查走的是富行内路径**
   *  （`mdHasRichInline(inl)`）时在场——加粗/斜体/行内码/行内公式的字体与字宽
   *  与纯文本不同，按 text 走查会得到与 DOM 不同的折行点。在场时墨迹改走
   *  `walkRichInlineLineRanges` 逐片段落墨（片段各自字体直绘），折行点与
   *  测高（measureRichItemsHeight）**同一把尺子**。 */
  rich?: RichInlineItem[];
}

/** 测量引擎实现面（内核读面三动词；9c-4b 起由 `paper-shell` 产物登记）。 */
export interface MeasureImplementation {
  /** 块墨迹走查（与块级测高共用 payload 语义与镜像常量）。 */
  inkSourcesFor(block: SourcedBlock, folded: boolean): InkSource[];
  /** 测量签名（几何 + 内容指纹；`ink.ts` 的墨迹缓存键用它）。 */
  measureSignature(block: SourcedBlock, folded: boolean, sidecarFolded?: boolean, sidecarOut?: boolean): string;
  /** 清「观察高度账」的会话级切片（切卷/清态调用）。 */
  clearObservedHeightsForSession(): void;
}
