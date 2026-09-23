// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 笔记本查看器登记（P3 · B11）——**重**：markdown 单元格要复用应用侧 markdown 渲染器
// （`app/paper/builtin-renderers.tsx` 的 MarkdownBody），产物域拿不到它 ⇒ 走 `heavy` 通道
// （本体 `app/paper/viewers/ipynb.tsx`，目录即白名单）。

import { VIEWER_IPYNB_EXTS } from '../../../../paper/viewer-exts';
import type { ViewerDef } from '../viewer-registry';

export const ipynbViewer: ViewerDef = {
  id: 'ipynb',
  exts: VIEWER_IPYNB_EXTS,
  needsBytes: true,
  bytesKind: 'text',
  readLines: 6000,
  maxBytes: 8 * 1024 * 1024,
  heavy: 'ipynb',
};
