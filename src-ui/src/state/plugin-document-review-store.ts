// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件改稿单（文档通道 · 批 2）——「窗想写回宿主文档」的待审状态。
//
// 为什么是 app 级 store：改稿单是**宿主**给用户看的证据面（差分 + 路径 + 计数），
// 与插件窗并排渲染、不随窗关闭而消失（窗关了也得让用户决定）。
//
// 编排（谁在等、批准后落盘、回推哪个事件）不在本 store：见 plugins/document-review.ts。

import { create } from 'zustand';

/** 一笔待审改稿：宿主算的差分 + 插件交来的新正文（正文不展示，落盘时才用）。 */
export interface PendingDocumentReview {
  reviewId: string;
  windowId: string;
  pluginName: string;
  /** 真实路径（由令牌解析得到——插件自报的路径永远进不了这里）。 */
  path: string;
  /** 新正文。 */
  content: string;
  added: number;
  removed: number;
  /** 差分展示文本（宿主算，可截断；计数是全量）。 */
  diff: string;
}

interface DocumentReviewState {
  review: PendingDocumentReview | null;
  show: (review: PendingDocumentReview) => void;
  hide: () => void;
}

export const useDocumentReviewStore = create<DocumentReviewState>((set) => ({
  review: null,
  show: (review) => set({ review }),
  hide: () => set({ review: null }),
}));
