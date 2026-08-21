// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/selection — V3a 抽纸条（paper-shell 待定 #10 定案：混合方案，重心选区拖出）。
//
// 语义（用户拍板 2026-08-21）：
//   - 块级为默认粒度（流视觉密度不涨、id 稳定性不伤）——整块拖出钉住
//     走 D-R2-1 既有通道（活引用）。
//   - **选中一段文字拖离流 = 抽纸条**（与 D-R2-3「塞纸条」隐喻同构）——
//     选区块是**拷贝语义**（纸条本体），活引用仅块级保留。
//   - 转译层不做段落预拆（块 id 续命机制保持现状）。
//
// 本文件是纸条的真相层模型 + 纯操作：
//   纸条 = 用户层物件（设计文档 §2.2 用户自定义层），文字快照自选区抽出，
//   世界坐标唯一真相（D-R2-4 同款纪律），不挂消息源（拷贝非活引用——
//   源消息更新不追纸条，源消息删除纸条照活）。

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
}

/** 纸条 id 前缀（与块 id 空间区分） */
export const STRIP_ID_PREFIX = 'strip';

let stripSeq = 0;

export function nextStripId(): string {
  stripSeq += 1;
  return STRIP_ID_PREFIX + stripSeq;
}

/** 测试复位（生产不调用）。 */
export function resetStripIdCounterForTests(): void {
  stripSeq = 0;
}

/** 从文本选区抽纸条（纯函数——壳层负责拿到选区文本与世界落点）。 */
export function makeStrip(text: string, x: number, y: number, w = 480): PaperStrip {
  return { id: nextStripId(), text: text.trim(), x, y, w };
}

/** 纸条拖动（每 move 一帧——与块级 movePinned 同款语义）。 */
export function moveStrip(s: PaperStrip, x: number, y: number): PaperStrip {
  return { ...s, x, y };
}

/**
 * 从选区锚点/焦点算选中文本（DOM Selection 语义的纯函数化投影）。
 * 输入是「块文本 + 选区两端偏移」——壳层从 window.getSelection() 换算
 * offset，本函数只做切片与边界夹取。拷贝语义的抽取原语。
 */
export function sliceSelection(text: string, start: number, end: number): string {
  const s = Math.max(0, Math.min(text.length, Math.min(start, end)));
  const e = Math.max(0, Math.min(text.length, Math.max(start, end)));
  return text.slice(s, e);
}

/**
 * 抽纸条守卫：空选区/纯空白不抽（拖出无物 = 手势落空，不是纸条）。
 * 返回 null 表示该手势不产生纸条。
 */
export function tryMakeStripFromSelection(
  text: string,
  start: number,
  end: number,
  x: number,
  y: number,
): PaperStrip | null {
  const sel = sliceSelection(text, start, end);
  if (sel.trim().length === 0) return null;
  return makeStrip(sel, x, y);
}
