// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 图片查看器（渲染面补全 B1，2026-09-23）——从 components.tsx 的 MediaBody 原样迁入
// （图片 7 种：png/jpg/jpeg/gif/webp/bmp/svg），**行为等价**：流内是点击放大的缩略图，
// 放大态是同一 src 的大图（浮层本体由宿主渲染，查看器只触发 onOpenOverlay）。

import { VIEWER_IMAGE_EXTS } from '../../../../paper/viewer-exts';
import type { ViewerDef, ViewerProps } from '../viewer-registry';

/** ext → MIME（原 MEDIA_MIME 表的图片段，逐字迁入——data URI 字符串零变化）。 */
export const IMAGE_MIMES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

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
  mimes: IMAGE_MIMES,
  needsBytes: true,
  component: ImageViewer,
};
