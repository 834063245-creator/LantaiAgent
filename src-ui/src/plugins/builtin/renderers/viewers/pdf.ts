// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// PDF 查看器登记（P2 · B3）——**重依赖**：本体在应用 bundle
// （`src-ui/src/app/paper/viewers/pdf.tsx`，pdfjs-dist 走 vite 真分片），产物域禁动态裸
// import（D3 修订），故产物侧这里只声明**认领 + 读取形态**，组件经宿主桥 `loadViewer('pdf')` 取。
//
// 取件键 = 应用侧文件名（`app/paper/viewers/pdf.tsx`，目录即白名单）。

import { VIEWER_PDF_EXTS } from '../../../../paper/viewer-exts';
import type { ViewerDef } from '../viewer-registry';

export const pdfViewer: ViewerDef = {
  id: 'pdf',
  exts: VIEWER_PDF_EXTS,
  needsBytes: true,
  mimes: { pdf: 'application/pdf' },
  /** 32 MiB：超过它的 PDF 已不是「翻一眼」的量级；P2 起宿主先做尺寸预检（不整份读）⇒
   *  超限只出可读错误，不会把 payload 推进 IPC。 */
  maxBytes: 32 * 1024 * 1024,
  heavy: 'pdf',
};
