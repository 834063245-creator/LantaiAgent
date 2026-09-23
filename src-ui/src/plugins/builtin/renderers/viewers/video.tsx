// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 视频查看器（渲染面补全 B1，2026-09-23）——从 components.tsx 的 MediaBody 原样迁入
// （mp4/webm/ogg/mov），**行为等价**：流内直接出播放器；放大态是同一 src 的浮层播放
// （自动播放）。宿主不因视频渲染放大按钮（与旧实现同形态）。

import { VIEWER_VIDEO_EXTS } from '../../../../paper/viewer-exts';
import type { ViewerDef, ViewerProps } from '../viewer-registry';

/** ext → MIME（原 MEDIA_MIME 表的视频段，逐字迁入）。 */
export const VIDEO_MIMES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
};

function VideoViewer({ label, bytes, mode }: ViewerProps) {
  const src = bytes?.kind === 'data-uri' ? bytes.value : undefined;
  if (mode === 'overlay') {
    return (
      // biome-ignore lint/a11y/useMediaCaption: 预览用户本地视频，无字幕轨道来源（非交互媒体）
      <video className="pp-media-preview" src={src} controls autoPlay aria-label={label} />
    );
  }
  return (
    // biome-ignore lint/a11y/useMediaCaption: 展示用户本地视频，无字幕轨道来源（非交互媒体）
    <video className="pp-media-video" src={src} controls aria-label={label} />
  );
}

export const videoViewer: ViewerDef = {
  id: 'video',
  exts: VIEWER_VIDEO_EXTS,
  mimes: VIDEO_MIMES,
  needsBytes: true,
  component: VideoViewer,
};
