// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 改稿单编排（文档通道 · 批 2）——桥面 `doc.save` 与宿主确认面之间的那条线。
//
// 为什么桥回执不等用户：桥调用有超时（窗内 SDK 也有），而用户可能盯着差分看几分钟；
// 所以 `doc.save` **立刻回 `pending-review`**，用户决定后再经事件回推：
//   · 批准 → 宿主写盘 → `doc-saved`；
//   · 退回 / 写盘失败 → `doc-rejected`（带 reason）。
//
// 一窗一笔：同窗已有待审时，新申请直接拒（防用户面前堆两张改稿单互相打架）。

import { type PendingDocumentReview, useDocumentReviewStore } from './plugin-document-review-store';

interface PendingEntry {
  review: PendingDocumentReview;
  resolve: (approved: boolean) => void;
}

const entries = new Map<string, PendingEntry>();
let seq = 0;

/** 该窗是否已有待审改稿（防叠单）。 */
export function hasPendingReviewForWindow(windowId: string): boolean {
  for (const e of entries.values()) if (e.review.windowId === windowId) return true;
  return false;
}

/** 提交一笔改稿单：挂进 store（UI 渲染）并返回「用户是否批准」的 Promise。 */
export function requestDocumentReview(review: Omit<PendingDocumentReview, 'reviewId'>): {
  reviewId: string;
  approved: Promise<boolean>;
} {
  seq += 1;
  const reviewId = `review#${seq}`;
  const full: PendingDocumentReview = { ...review, reviewId };
  const approved = new Promise<boolean>((resolve) => {
    entries.set(reviewId, { review: full, resolve });
  });
  useDocumentReviewStore.getState().show(full);
  return { reviewId, approved };
}

/** 用户裁决（确认面调用）：批准 = 走落盘；退回 = 不写盘。 */
export function settleDocumentReview(reviewId: string, approved: boolean): void {
  const entry = entries.get(reviewId);
  if (!entry) return;
  entries.delete(reviewId);
  const current = useDocumentReviewStore.getState().review;
  if (current && current.reviewId === reviewId) useDocumentReviewStore.getState().hide();
  entry.resolve(approved);
}

/** 测试复位（vitest 同 worker 模块态跨用例共享）。 */
export function resetDocumentReviewsForTests(): void {
  for (const e of entries.values()) e.resolve(false);
  entries.clear();
  useDocumentReviewStore.getState().hide();
  seq = 0;
}
