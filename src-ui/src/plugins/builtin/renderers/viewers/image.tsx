// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 图片查看器（渲染面补全 B1，2026-09-23）——从 components.tsx 的 MediaBody 原样迁入
// （图片 7 种：png/jpg/jpeg/gif/webp/bmp/svg），**行为等价**：流内是点击放大的缩略图，
// 放大态是同一 src 的大图（浮层本体由宿主渲染，查看器只触发 onOpenOverlay）。

import { VIEWER_IMAGE_EXTS, VIEWER_IMAGE_MIMES } from '../../../../paper/viewer-exts';
import type { ViewerDef, ViewerProps } from '../viewer-registry';

/* ext → MIME 表（原本文件 IMAGE_MIMES，2026-10 随正文本地图批上移至
 * `paper/viewer-exts.ts`——md 本地图 data URI 与本站共用一处，表内容逐字未动）。 */

function ImageViewer({ label, bytes, mode, onOpenOverlay }: ViewerProps) {
  const src = bytes?.kind === 'data-uri' ? bytes.value : undefined;
  if (mode === 'overlay') return <img className="pp-media-preview" src={src} alt={label} />;
  return (
    <button type="button" className="pp-media-open" onClick={() => onOpenOverlay?.()}>
      <img className="pp-media-img" src={src} alt={label} />
    </button>
  );
}

export const imageViewer: ViewerDef = {
  id: 'image',
  exts: VIEWER_IMAGE_EXTS,
  mimes: VIEWER_IMAGE_MIMES,
  needsBytes: true,
  component: ImageViewer,
};
