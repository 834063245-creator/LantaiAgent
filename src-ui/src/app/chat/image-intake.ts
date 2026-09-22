// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 附图准入（multimodal-image-plan B1——docs/archive/multimodal-image-plan.md）
//
// 采集字节 → 验收（白名单 + magic-byte + 单图限制）→ 规整（EXIF 校正 + 保比
// 降采样 + 重编码）→ sha256 内容寻址 → fs_cap write_base64 落
// {ws}/.lantai/attachments/ → ChatImageRef。
//
// 分层：纯函数面（白名单/magic-byte/限制/尺寸决策/显示名清洗）可单测；
// canvas 规整面 webview 专供（jsdom 无 createImageBitmap——纯函数测试 + 真机
// 验收兜底）。规整在 TS、Rust 只管字节读写（kernel-plugin v3 宪法——D-15）。
//
// 通道不对称（读侧 read_base64 有 8MiB 预览上限）：粘贴直拿 Blob 字节，
// 上限 = MAX_IMAGE_BYTES（20MiB）；拖放/夹选走路径→read_base64 通道，
// 实际上限 = 8MiB。截图/常规图片远低于两界，不对称可接受（真机验收 3 兜底）。

import type { ChatImageRef, ImageMediaType } from '../../provider/types';
import { kernelReadFileBase64, kernelWriteFileBase64 } from '../../rpc-contract';

/** 附图媒体类型白名单（D-4——png/jpeg/webp/gif，无 bmp/svg）。 */
export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** 准入限制（抄 DSH 默认值——attachment-local/src/index.ts）。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024;

/** 规整目标（D-4）：长边 ≤ 2048 / 像素 ≤ 2048² / 编码后 ≤ 4MiB。 */
export const NORMALIZED_MAX_DIMENSION = 2048;
export const NORMALIZED_MAX_PIXELS = 2048 * 2048;
export const NORMALIZED_MAX_BYTES = 4 * 1024 * 1024;

/** mediaType → 磁盘扩展名（id 作文件名主干，扩展名只作人读/双击可用）。 */
export function extOfMediaType(mediaType: ImageMediaType): 'png' | 'jpg' | 'webp' | 'gif' {
  switch (mediaType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
  }
}

/** magic-byte 嗅探——不信任调用方声明的 mime（DSH 同纪律：声明与字节不符即拒）。 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // WEBP：RIFF 头 + 偏移 8-11 处 "WEBP"
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  // GIF87a/GIF89a 共用 "GIF8" 前缀
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  return undefined;
}

/** 保比投影尺寸——不放大（DSH request-projection 同款几何，叠加长边约束）。 */
export function projectedDimensions(
  width: number,
  height: number,
  maxDimension: number,
  maxPixels: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error(`图片尺寸非法（${width}×${height}）`);
  const byDimension = Math.min(1, maxDimension / Math.max(width, height));
  const byPixels = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  const scale = Math.min(byDimension, byPixels);
  if (scale === 1) return { width, height };
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/** GIF 逻辑屏幕尺寸（头偏移 6-9，小端 u16——canvas 会杀动画，GIF 不走解码）。 */
export function gifDimensions(bytes: Uint8Array): { width: number; height: number } {
  return {
    width: bytes[6] | (bytes[7] << 8),
    height: bytes[8] | (bytes[9] << 8),
  };
}

/** 控制字符清洗集（U+0000-U+001F 与 U+007F）。fromCharCode 构造——
 *  源文件里不进任何控制字节（biome noControlCharactersInRegex 纪律）。 */
const CONTROL_CHARS_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

/** 剥路径分隔符的显示名（DSH displayName 同款——两种分隔符手剥防跨平台泄漏，
 *  控制字符清洗 + 255 上限）。 */
export function displayLeafName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);
  const clean = leaf.replace(CONTROL_CHARS_RE, '').trim().slice(0, 255);
  return clean === '' ? undefined : clean;
}

/** sha256 hex（webview crypto.subtle——内容寻址 id 真源）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 字节 → base64（分块 btoa 防 String.fromCharCode 爆栈）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 附图落盘路径（内容寻址——D-2）。根路径反斜杠归一为正斜杠——Windows 工作区
 *  根（D:\ws 形态）产出的引用路径全仓可移植，Rust 侧两分隔符均解析。 */
export function attachmentFilePath(root: string, id: string, mediaType: ImageMediaType): string {
  const cleanRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${cleanRoot}/.lantai/attachments/${id}.${extOfMediaType(mediaType)}`;
}

/** 附图请求期读取（B3 · D-5——Agent.imageReader 注入腰的 app 端实现）：
 *  工作区根拼 attachments 路径 → fs_cap read_base64。读失败上抛——
 *  request-images.resolveRequestImageData 捕获后该图降级为 wire 缺图。 */
export async function readAttachmentBase64(
  root: string,
  ref: Pick<ChatImageRef, 'id' | 'mediaType' | 'name'>,
): Promise<string> {
  const b64 = await kernelReadFileBase64(attachmentFilePath(root, ref.id, ref.mediaType));
  if (b64 === '') throw new Error(`附图读取失败（或超过通道上限 8MiB）：${ref.name ?? ref.id.slice(0, 12)}`);
  return b64;
}

// ── wire 规整（2026-09-22 读图挂起事故）──────────────────────────────
//
// 为什么需要第二道规整：准入规整（admitImageBytes）只覆盖**创作坞**三入口
// （粘贴/拖放/夹选）。工具附图通道（`fs(read)` 读到图片 → Rust 落 attachments
// → parseToolImageOutput 挂引用）**不经过准入**：实测一张 2560×1400 PNG
// （6.46MB）内联成 8.61MB data URI 直接上线 → 服务商 30 秒零字节 → 被空闲守卫
// 判挂起（agent 侧据此把重试改成有界，见 agent/retry.ts 载荷分账）。
// 本函数是「任何来源的图上线前都受同一条发送带约束」的落点：越界即降采样 +
// 重编码（PNG 先换 WebP），合规图**逐字节原样返回**（零漂移——不重复重编码）。

/** 单图发送带（caps 由 agent 层 request-images 传入——预算是发送面的账）。 */
export interface WireImageCaps {
  maxBytes: number;
  maxDimension: number;
  maxPixels: number;
}

/** wire 载荷（读取器产物）：字节 + 实际编码媒型。 */
export interface WireImagePayload {
  mediaType: ImageMediaType;
  data: string;
}

/** base64 → 字节。 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 是否已在发送带内（三条同判：字节 / 长边 / 像素）。 */
function withinWireCaps(bytes: number, width: number, height: number, caps: WireImageCaps): boolean {
  return bytes <= caps.maxBytes && Math.max(width, height) <= caps.maxDimension && width * height <= caps.maxPixels;
}

/** 按目标尺寸/编码重画（解码 → canvas → toBlob）。 */
async function encodeAt(
  src: { bytes: Uint8Array; mediaType: ImageMediaType },
  width: number,
  height: number,
  outType: ImageMediaType,
  quality: number | undefined,
): Promise<Uint8Array> {
  const copy = new Uint8Array(src.bytes);
  const { bitmap } = await decodeBitmap(new Blob([copy.buffer as ArrayBuffer], { type: src.mediaType }));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 上下文不可用，无法规整图片');
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === 'function') bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outType, quality));
  if (blob === null) throw new Error('canvas 重编码失败');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * wire 规整：把越界图压进发送带，合规图原样（零漂移）。
 *
 * 收敛策略（逐轮收紧，最多 4 轮——先保清晰度，再让编码，最后才降尺寸）：
 *   1. 保比降采样到带内尺寸 + 原编码重编码（长边 2560 → 2048 这一步）；
 *   2. 同尺寸换编码：PNG → WebP（截图/照片小一个量级）；
 *   3. 仍超 → 长边 × 0.75 再来一轮（最多再两轮）。
 * 四轮仍压不进去 = 这张图不适合上线，抛错（调用方降级为原字节上线，由 agent 侧
 * 单图预算闸摘除换占位——「送不出去」绝不静默）。
 */
export async function projectImageForWire(
  b64: string,
  mediaType: ImageMediaType,
  width: number,
  height: number,
  caps: WireImageCaps,
): Promise<WireImagePayload> {
  const bytes = base64ToBytes(b64);
  if (withinWireCaps(bytes.length, width, height, caps)) return { mediaType, data: b64 };

  let current: { bytes: Uint8Array; mediaType: ImageMediaType; width: number; height: number } = {
    bytes,
    mediaType,
    width,
    height,
  };
  // GIF 走 canvas 必然首帧化——越界 GIF 直接降级为 WebP 静态帧（与准入面同款取舍）。
  let outType: ImageMediaType = mediaType === 'image/gif' ? 'image/webp' : mediaType;
  let maxDimension = caps.maxDimension;
  let maxPixels = caps.maxPixels;
  for (let round = 0; round < 4; round++) {
    if (round >= 2) {
      // 尺寸让步放在编码让步之后（先丢压缩率，后丢像素）
      maxDimension = Math.max(256, Math.floor(maxDimension * 0.75));
      maxPixels = maxDimension * maxDimension;
    } else if (round === 1 && outType === 'image/png') {
      outType = 'image/webp';
    }
    const target = projectedDimensions(current.width, current.height, maxDimension, maxPixels);
    const quality = outType === 'image/png' ? undefined : round === 0 ? 0.9 : 0.8;
    const out = await encodeAt(current, target.width, target.height, outType, quality);
    if (out.length <= caps.maxBytes) {
      return { mediaType: outType, data: bytesToBase64(out) };
    }
    current = { bytes: out, mediaType: outType, width: target.width, height: target.height };
  }
  throw new Error(`附图规整 ${width}×${height} 后仍超出单图发送上限（${Math.round(caps.maxBytes / 1024 / 1024)}MiB）`);
}

/** 请求期读取 + wire 规整（Agent.imageReader 的 app 端实现）。
 *  规整失败（jsdom 无 canvas / 解码失败）→ **原字节上线**并留痕：宁可让 agent 侧
 *  的单图预算闸去裁决（它会摘图换占位并落日志/通知），也不在读取层吞掉这张图。 */
export async function readAttachmentForWire(
  root: string,
  ref: ChatImageRef,
  caps: WireImageCaps,
): Promise<WireImagePayload> {
  const b64 = await readAttachmentBase64(root, ref);
  try {
    return await projectImageForWire(b64, ref.mediaType, ref.width, ref.height, caps);
  } catch (e) {
    console.warn('[image] wire 规整失败，按原字节上线（agent 侧单图预算闸兜底）:', e);
    return { mediaType: ref.mediaType, data: b64 };
  }
}

// ── B2 采集路由（纯函数面——可测）──────────────────────────────

/** 图片扩展名集合（小写——路由分流判据；与 IMAGE_MEDIA_TYPES 对应 + jpeg 别名）。 */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/** 路径是否图片（扩展名判据——夹/引/拖放的图片分流）。 */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase());
}

/** 路径分流（B2 路由决策）：图片扩展名且允许时入附图道，否则走路径附件老路
 *  （文本模型零回归——png 当普通文件附，模型 read_file 时行为同今日）。 */
export function splitIntakePaths(
  paths: readonly string[],
  allowImages: boolean,
): { images: string[]; files: string[] } {
  const images: string[] = [];
  const files: string[] = [];
  for (const p of paths) (allowImages && isImagePath(p) ? images : files).push(p);
  return { images, files };
}

/** 粘贴载荷抽图（DSH keymap 同款：clipboardData.items kind='file' → getAsFile，
 *  只取图片项——文本粘贴零影响）。入参鸭子类型，jsdom 可测。
 *
 *  ⚡ 判据放宽（2026-09-22 真机失灵）：只认 `file.type` 会把「资源管理器里复制
 *  的图」挡在门外——CF_HDROP 那条通道交上来的 type 可能是空串，而字节其实是
 *  真图（用户侧表现 = 粘贴毫无反应，连提示都没有；当事人只能改成手打路径）。
 *  真守门人是下游 admitImageBytes 的 magic-byte 嗅探（声明与字节不符即拒），
 *  按扩展名放行只是把「有没有机会被嗅探」还给它；非图在准入处换可见 toast，
 *  不静默。 */
export function extractImageFiles(items: Iterable<{ kind: string; getAsFile: () => File | null }>): File[] {
  const out: File[] = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file === null) continue;
    if (file.type.startsWith('image/') || isImagePath(file.name)) out.push(file);
  }
  return out;
}

// ── 预览 URL 缓存（DSH preview seeding 同款）────────────────────
// 准入时用规整字节种 object URL——草稿期同步显示的就是模型将看到的图。
// 草稿槽是进程内存态（重启不存），同进程 seed 覆盖全部草稿渲染场景，
// 无需回读盘。进程生命周期不 revoke：量级受每卷 20 图上限约束，
// 已知取舍（不另立 GC 面）。

const _previewUrls = new Map<string, string>();

/** 准入后种预览 URL（同 id 幂等）。 */
export function seedPreviewUrl(id: string, bytes: Uint8Array, mediaType: ImageMediaType): string {
  const existing = _previewUrls.get(id);
  if (existing !== undefined) return existing;
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: mediaType }));
  _previewUrls.set(id, url);
  return url;
}

/** 取预览 URL（未命中返回 undefined——渲染层降级为占位盒）。 */
export function previewUrlFor(id: string): string | undefined {
  return _previewUrls.get(id);
}

/** 规整产物（归一化后、未做内容寻址）。 */
export interface NormalizedImage {
  bytes: Uint8Array;
  mediaType: ImageMediaType;
  width: number;
  height: number;
  /** 缩放发生时的原始尺寸。 */
  originalDimensions?: { width: number; height: number };
}

/** 解码位图：createImageBitmap 主路径（EXIF 校正）；<img> 兜底（无 EXIF）。 */
async function decodeBitmap(
  blob: Blob,
): Promise<{ bitmap: CanvasImageSource & { close?: () => void }; width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    return { bitmap: bmp, width: bmp.width, height: bmp.height };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { bitmap: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 规整（D-4）：EXIF 校正 + 保比降采样 + 重编码。
 *  - GIF 不重采样（canvas 首帧化杀动画）——尺寸合规原样通过，超限拒绝；
 *  - jpeg/webp 重编码 q0.85，png 保持无损；缩放发生时记 originalDimensions。 */
export async function normalizeImageBytes(bytes: Uint8Array, mediaType: ImageMediaType): Promise<NormalizedImage> {
  if (mediaType === 'image/gif') {
    const dims = gifDimensions(bytes);
    if (
      Math.max(dims.width, dims.height) > NORMALIZED_MAX_DIMENSION ||
      dims.width * dims.height > NORMALIZED_MAX_PIXELS
    ) {
      throw new Error(`GIF 尺寸超限（${dims.width}×${dims.height}），不支持超大 GIF`);
    }
    return { bytes, mediaType, width: dims.width, height: dims.height };
  }
  const copy = new Uint8Array(bytes);
  const { bitmap, width, height } = await decodeBitmap(new Blob([copy.buffer as ArrayBuffer], { type: mediaType }));
  const target = projectedDimensions(width, height, NORMALIZED_MAX_DIMENSION, NORMALIZED_MAX_PIXELS);
  const downscaled = target.width !== width || target.height !== height;
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 上下文不可用，无法规整图片');
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  if (typeof bitmap.close === 'function') bitmap.close();
  const outType: ImageMediaType =
    mediaType === 'image/png' ? 'image/png' : mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
  const quality = outType === 'image/png' ? undefined : 0.85;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outType, quality));
  if (blob === null) throw new Error('canvas 重编码失败');
  const out = new Uint8Array(await blob.arrayBuffer());
  return {
    bytes: out,
    mediaType: outType,
    width: target.width,
    height: target.height,
    ...(downscaled ? { originalDimensions: { width, height } } : {}),
  };
}

/** 全管线：字节 → 验收 → 规整 → sha256 → 落盘 → 引用（B2 采集三入口共用底座）。 */
export async function admitImageBytes(root: string, bytes: Uint8Array, name?: string): Promise<ChatImageRef> {
  if (bytes.byteLength === 0) throw new Error('附图为空文件');
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `图片超过单图上限（${Math.round(bytes.byteLength / 1024 / 1024)}MiB > ${MAX_IMAGE_BYTES / 1024 / 1024}MiB）`,
    );
  }
  const sniffed = sniffImageMediaType(bytes);
  if (sniffed === undefined) throw new Error('不是受支持的图片格式（png / jpeg / webp / gif）');
  const normalized = await normalizeImageBytes(bytes, sniffed);
  if (normalized.bytes.byteLength > NORMALIZED_MAX_BYTES) {
    throw new Error(`规整后图片仍超过 ${NORMALIZED_MAX_BYTES / 1024 / 1024}MiB 上限，请换更小的图`);
  }
  const id = await sha256Hex(normalized.bytes);
  const filePath = attachmentFilePath(root, id, normalized.mediaType);
  await kernelWriteFileBase64(filePath, bytesToBase64(normalized.bytes));
  seedPreviewUrl(id, normalized.bytes, normalized.mediaType);
  return {
    id,
    mediaType: normalized.mediaType,
    bytes: normalized.bytes.byteLength,
    width: normalized.width,
    height: normalized.height,
    ...(name !== undefined ? { name: displayLeafName(name) } : {}),
    ...(normalized.originalDimensions !== undefined ? { originalDimensions: normalized.originalDimensions } : {}),
  };
}

/** 粘贴通道：webview File/Blob 直拿字节（上限 MAX_IMAGE_BYTES）。 */
export async function admitImageBlob(root: string, blob: Blob, name?: string): Promise<ChatImageRef> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return admitImageBytes(root, bytes, name);
}

/** 路径通道：拖放/夹选——经 read_base64 取字节（8MiB 通道上限在此生效）。 */
export async function admitImageFromPath(root: string, path: string): Promise<ChatImageRef> {
  const b64 = await kernelReadFileBase64(path);
  if (b64 === '') throw new Error(`读取图片失败（或超过通道上限 8MiB）：${path}`);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const name = path.replace(/\\/g, '/').split('/').pop() || path;
  return admitImageBytes(root, bytes, name);
}
