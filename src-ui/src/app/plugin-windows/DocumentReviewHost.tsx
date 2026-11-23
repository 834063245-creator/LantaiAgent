// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 改稿单确认面（文档通道 · 批 2）——app 根挂一次，与插件窗层并列。
//
// 纪律：这是**宿主**的确认面，不是插件的。窗只交正文，差分与计数由宿主算；
//
// 措辞（2026-11-23 用户定）：否定键叫「取消」不叫「退回」——改稿单的**作者是用户自己**
// （他在窗里亲手改的），没有「驳回谁的稿」这回事；「退回」留给将来『Agent 提请改动、
// 人审不通过』那种语义（那时才真有一个被退回的对象）。
// 用户看到的路径也来自令牌解析的真路径。插件无法伪造这张单子。

import { settleDocumentReview } from '../../state/plugin-document-review';
import { useDocumentReviewStore } from '../../state/plugin-document-review-store';
import { ConfirmDialog } from '../ConfirmDialog';
import './document-review.css';

export function DocumentReviewHost() {
  const review = useDocumentReviewStore((s) => s.review);
  if (!review) return null;
  const message = (
    <div className="doc-review">
      <p className="doc-review-path">{review.path}</p>
      <p className="doc-review-count">
        <span className="plus">+{review.added}</span> <span className="minus">−{review.removed}</span>
        <span className="src"> · 来自插件「{review.pluginName}」</span>
      </p>
      <pre className="doc-review-diff">{review.diff}</pre>
    </div>
  );
  return (
    <ConfirmDialog
      open
      title="改稿单：写入这一页？"
      message={message}
      confirmLabel="写入"
      cancelLabel="取消"
      onConfirm={() => settleDocumentReview(review.reviewId, true)}
      onCancel={() => settleDocumentReview(review.reviewId, false)}
    />
  );
}
