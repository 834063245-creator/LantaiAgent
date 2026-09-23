// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// Markdown 独立查看登记（P3 · B14）——**重**：复用应用侧 markdown 渲染器（标题树 + 正文），
// 不在产物里塞第二份 markdown 解析 ⇒ 走 `heavy` 通道（本体 `app/paper/viewers/markdown-doc.tsx`）。

import { VIEWER_MARKDOWN_EXTS } from '../../../../paper/viewer-exts';
import type { ViewerDef } from '../viewer-registry';

export const markdownDocViewer: ViewerDef = {
  id: 'markdown-doc',
  exts: VIEWER_MARKDOWN_EXTS,
  needsBytes: true,
  bytesKind: 'text',
  readLines: 8000,
  maxBytes: 4 * 1024 * 1024,
  heavy: 'markdown-doc',
};
