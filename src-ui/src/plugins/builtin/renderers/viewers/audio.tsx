// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 音频查看器（渲染面补全 B1，2026-09-23）——B1 的新增格式（此前 mp3/wav… 一律落
// 「文件壳」）。形态：原生 `<audio controls>`（零依赖）+ 一行时长读数。
//
// 固定盒高（chem boxH 先例）：`<audio>` 的原生控件高度随 UA 变，故容器走
// `--pp-asset-viewer-audioBoxH` 固定高、元素填满——静态测高镜像才精确
// （paper/measure.ts 的 viewerBodyH 同值，token 真源 = ASSET_TOKENS.viewer.audioBoxH）。
//
// 时长读数**诚实**：metadata 未就绪时显「时长未知」，不假装 0:00（jsdom 无媒体栈，
// 测试面看到的就是这一态）。播放器自身解码失败（坏文件）另有一条可读错误行。

import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';

const { useState } = rendererHooks;

/** ext → MIME（opus/oga 同属 Ogg 容器；m4a/aac 走 MP4/AAC 系）。 */
export const AUDIO_MIMES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
};

/** 字节上限：base64 走 IPC 与 DOM 字符串（4/3 膨胀），超大音频宁可退回文件壳。
 *  图片/视频沿用旧行为不设限（本批只新增格式带闸）。 */
const AUDIO_MAX_BYTES = 16 * 1024 * 1024;

/** 秒 → m:ss（时长读数；不引时长库）。 */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function AudioViewer({ label, bytes, mode }: ViewerProps) {
  const [duration, setDuration] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const src = bytes?.kind === 'data-uri' ? bytes.value : undefined;
  // 音频没有放大形态（浮层由宿主渲染，但图片那类「点击看大图」语义对音频无意义）
  if (mode === 'overlay') return null;
  return (
    <div className="pp-viewer-audio">
      {/* biome-ignore lint/a11y/useMediaCaption: 播放用户本地音频，无字幕轨道来源（非交互媒体） */}
      <audio
        className="pp-viewer-audio-el"
        src={src}
        controls
        aria-label={label}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
          else setFailed('时长不可读（不是常规音频文件）');
        }}
        onError={() => setFailed('音频无法解码（文件损坏或编码不受支持）')}
      />
      <div className="pp-viewer-audio-meta">
        {failed ?? (duration != null ? `时长 ${formatDuration(duration)}` : '时长未知')}
      </div>
    </div>
  );
}

export const audioViewer: ViewerDef = {
  id: 'audio',
  exts: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'opus', 'oga'],
  mimes: AUDIO_MIMES,
  needsBytes: true,
  maxBytes: AUDIO_MAX_BYTES,
  component: AudioViewer,
};
