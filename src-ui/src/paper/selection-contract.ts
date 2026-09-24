// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/selection-contract — 纸条（paper-strip）**契约面**（批 9c-1，2026-09-26）。
//
// 为什么类型留内核：纸条是**跨层物件**——内核 `state/canvas-store.ts` 存它（用户层持久化），
// paper-shell 造它/画它（`selection.ts` 实现随包）。形状由两侧共享 ⇒ 落内核契约，
// 实现（造条/落点/遮罩几何）住产物包 `plugins/builtin/paper-shell/selection.ts`。
//
// 同批实测的口径修正：账本 §2.5 原写「measure.ts … 实现进 paper-shell」（把 measure 与
// selection/group/virtualize 归一档），实测 `paper/ink.ts` 亦依赖 measure 的墨迹走查
// ⇒ measure/type-tokens 的切法另立子批（见账本 §6.5 的 9c 落地段），本文件只收纸条形状。

/** 纸条来源元信息（只记录，不追踪同步——拷贝语义不变） */
export interface PaperStripSource {
  /** 源消息 _id */
  messageId: string;
  /** 消息内的 part 索引 */
  partIndex?: number;
  /** 选区在该块文本中的起止偏移 */
  startOffset?: number;
  endOffset?: number;
  /** 抽取那一刻的源卷显示名快照（2026-09-19 便条批：纸条报头「摘自 卷名」）。
   *  **快照不是活引用**——拷贝语义：剪下来的纸片上印着原纸当时的名字，源卷
   *  改名不追改（与块级钉的活卷名出处行是两套语义）。旧存档无此字段 ⇒ 报头
   *  行不渲染。 */
  label?: string;
}

/** 纸条物件（用户层——与块级 SourcedBlock 区分：无 source，拷贝语义） */
export interface PaperStrip {
  id: string;
  /** 快照文字（抽出时刻的选区内容，不再跟随源） */
  text: string;
  /** 世界坐标（唯一真相） */
  x: number;
  y: number;
  /** 纸条宽（世界单位） */
  w: number;
  /** 来源元信息（仅溯源，活引用仅块级保留） */
  source?: PaperStripSource;
}
