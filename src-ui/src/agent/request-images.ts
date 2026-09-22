// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 附图发送面纯函数（multimodal-image-plan B3 · D-5/D-7/D-8③）
//
// Agent 请求期把 user 消息上的 ChatImageRef 引用变成 wire 可用的载荷：
//   - applyImageBudget：请求级预算降级（D-7）——超限**最旧先移除**，被移图在
//     所属消息 content 尾部换确定性占位文本；
//   - projectImagesForTextModel：文本模型投影（D-8③）——模型无 image 声明时
//     全部图换占位文本（不报错，优雅降级）；
//   - resolveRequestImageData：引用 → base64（D-5）——读盘经注入的 reader，
//     agent 层零 app 依赖；缓存由调用方持有（Agent 实例级——同图跨回合零重读）。
//
// 全部函数不改入参（浅拷贝替换），session 永持完整引用——发送面任何降级
// 都是 wire 级投影，session/卷零污染。

import type { ChatImageRef, ImageMediaType, Message } from '../provider/types';

/** 请求级附图数量上限（D-7）。 */
export const MAX_REQUEST_IMAGES = 40;
/** 请求级附图字节累计上限（D-7——按规整字节计，wire 时 base64 膨胀 ~4/3）。 */
export const MAX_REQUEST_IMAGE_BYTES = 24 * 1024 * 1024;

/** ── 单图 **wire** 预算（2026-09-22 读图挂起事故）─────────────────────────
 *  请求级预算（上两条）是「许可式」的：它只管张数与总量，不管**单张有多大**，
 *  也不管这张图会不会让整包请求变成服务商消化不了的东西。
 *  实测事故：`fs(read)` 读一张 2560×1400 PNG（6.46MB）→ 内联 base64 8.61MB →
 *  整包 ~9MB → 服务商 30 秒零字节、连试两轮（详见 retry.ts 的载荷分账注）。
 *  本条是**发送带上限**（不是准入律：准入律见 app/chat/image-intake.ts）：
 *  越界图由 app 侧读取器先规整（降采样/重编码）压进带内；压不进来的一律摘除换
 *  占位——绝不让注定挂起的载荷上线。
 *  取值依据：已知安全带 = 43KB 图 6.0s 正常返回；已知挂点 = 8.61MB base64
 *  （30s 零字节 ×2）。取 2MiB（base64 ~2.7MB）＝ 挂在已知挂点的 1/3 以下，
 *  同时远高于历史可用图（≤400KB）；规整后的截图通常在数百 KB 量级。 */
export const WIRE_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const WIRE_MAX_IMAGE_DIMENSION = 2048;
export const WIRE_MAX_IMAGE_PIXELS = 2048 * 2048;
/** base64 字符数上限（4/3 膨胀 + padding 余量）——守卫直接量 wire 字符串。 */
export const WIRE_MAX_IMAGE_BASE64_CHARS = Math.ceil((WIRE_MAX_IMAGE_BYTES * 4) / 3) + 4;

/** 发送带载体（caps 对象）——workspace 注入点与生产镜像测试同源，避免各拼一份。 */
export const WIRE_IMAGE_CAPS = {
  maxBytes: WIRE_MAX_IMAGE_BYTES,
  maxDimension: WIRE_MAX_IMAGE_DIMENSION,
  maxPixels: WIRE_MAX_IMAGE_PIXELS,
} as const;

/** 请求级预算占位文本（D-7——模型可见的确定性交代）。 */
export function offloadedImageText(ref: ChatImageRef): string {
  return `[图片已省略（超出请求预算）：${ref.name ?? ref.id.slice(0, 12)} ${ref.width}×${ref.height}。可请用户重新附图。]`;
}

/** 文本模型投影占位（D-8③——不报错，模型至少知道图存在过）。 */
export function textModelImagePlaceholder(ref: ChatImageRef): string {
  return `[图片：${ref.name ?? ref.id.slice(0, 12)}（${ref.width}×${ref.height}）——当前模型不支持图片输入，图已省略。]`;
}

/** 送不出去时的占位（2026-09-19 事故）：模型**声明支持图**、载荷里也确有图，
 *  却因为读取通道缺失（装配漏接线）或读盘全失败而拿不到字节——此时图既不进
 *  wire 也不留痕，模型与用户都无从知晓（旧实现静默跳过：无图、无占位、无日志，
 *  真机三天没图）。占位把「有图但没送到」写在 wire 上。 */
export function unsentImageText(ref: ChatImageRef, reason: string): string {
  return `[图片：${ref.name ?? ref.id.slice(0, 12)}（${ref.width}×${ref.height}）——本次未能送达模型（${reason}）。]`;
}

/** 「图送不出去」投影：换占位文本 + 摘掉引用（与文本模型投影同形状）。
 *  reason 由调用方给（装配缺陷 / 读取失败）——文案里带上原因，便于用户回报。 */
export function projectImagesUnsent(messages: readonly Message[], reason: string): Message[] {
  return projectImagesWith(messages, (ref) => unsentImageText(ref, reason));
}

/** 投影公共体（文本模型 / 图送不出去 / 超 wire 预算三个投影共用一份形状）：逐消息
 *  把 `only` 命中的附图换成占位文本并摘掉引用；不含图 = 原数组浅拷贝（零漂移）。
 *  @param only 只摘这些 ref.id；缺省 = 该消息携带的全部图。 */
function projectImagesWith(
  messages: readonly Message[],
  textOf: (ref: ChatImageRef) => string,
  only?: ReadonlySet<string>,
): Message[] {
  if (!messages.some((m) => (m.images?.length ?? 0) > 0)) return [...messages];
  return messages.map((m) => {
    const images = carriedImages(m);
    if (images === undefined || images.length === 0) return m;
    const dropped = only === undefined ? images : images.filter((r) => only.has(r.id));
    if (dropped.length === 0) return m;
    const placeholder = dropped.map(textOf).join('\n');
    const kept = images.filter((r) => !dropped.includes(r));
    const { images: _drop, ...rest } = m;
    return {
      ...rest,
      content: appendPlaceholder(m.content, placeholder),
      ...(kept.length > 0 ? { images: kept } : {}),
    };
  });
}

/** 可携带附图的角色（契约 v40：语言面 = user + tool；assistant 不带图，见
 *  provider/types.ts 的 Message.images 注与 open-surface-contract 变更记录）。
 *  收集/预算/投影全部纯函数共用同一判据——口径不分开，避免各处各判一套。 */
function carriedImages(m: Message): ChatImageRef[] | undefined {
  return m.role === 'user' || m.role === 'tool' ? m.images : undefined;
}

/** 收集载荷里的全部附图引用（消息序——最旧在前）。
 *  user 与 tool 两类角色都可携带（tool 侧 = 工具附图通道 P0a）：预算与投影
 *  共用同一份收集口径，工具附图不另开预算面。 */
export function collectImageRefs(messages: readonly Message[]): ChatImageRef[] {
  const refs: ChatImageRef[] = [];
  for (const m of messages) {
    for (const ref of carriedImages(m) ?? []) refs.push(ref);
  }
  return refs;
}

/** 给消息 content 追加占位行（undefined content = 空消息补占位）。 */
function appendPlaceholder(content: string | undefined, placeholder: string): string {
  const base = content ?? '';
  if (base === '') return placeholder;
  return `${base}\n${placeholder}`;
}

/**
 * 请求级预算降级（D-7）：数量/字节超限时**保新弃旧**——反向贪心（最新端
 * 往回）保留，装不下的更旧图全部移除；被移图在所属消息 content 尾部换
 * 占位文本。同一条消息内的图可部分移除（最旧的部分先走）。
 * 不超限 = 原数组浅拷贝、消息对象引用原样返回（零漂移——D-6 纯文本路径
 * 零开销，前缀缓存友好）。
 */
export function applyImageBudget(
  messages: readonly Message[],
  opts?: { maxImages?: number; maxBytes?: number },
): Message[] {
  const maxImages = opts?.maxImages ?? MAX_REQUEST_IMAGES;
  const maxBytes = opts?.maxBytes ?? MAX_REQUEST_IMAGE_BYTES;
  if (!messages.some((m) => (m.images?.length ?? 0) > 0)) return [...messages];

  const refs = collectImageRefs(messages);
  const totalBytes = refs.reduce((sum, r) => sum + r.bytes, 0);
  if (refs.length <= maxImages && totalBytes <= maxBytes) return [...messages];

  // 保新弃旧：最新端往回贪心保留（任一预算耗尽即停——更旧全弃）。
  const keep = new Set<ChatImageRef>();
  let budgetImages = maxImages;
  let budgetBytes = maxBytes;
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i];
    if (budgetImages <= 0 || budgetBytes - ref.bytes < 0) break;
    keep.add(ref);
    budgetImages -= 1;
    budgetBytes -= ref.bytes;
  }

  const out: Message[] = [];
  for (const m of messages) {
    const images = carriedImages(m);
    if (images === undefined || images.length === 0) {
      out.push(m);
      continue;
    }
    const kept = images.filter((r) => keep.has(r));
    if (kept.length === images.length) {
      out.push(m);
      continue;
    }
    const dropped = images.filter((r) => !keep.has(r));
    const placeholder = dropped.map(offloadedImageText).join('\n');
    const { images: _drop, ...rest } = m;
    out.push({
      ...rest,
      content: appendPlaceholder(m.content, placeholder),
      ...(kept.length > 0 ? { images: kept } : {}),
    });
  }
  return out;
}

/**
 * 文本模型投影（D-8③）：载荷含图而模型无 image 声明时，全部图换文本占位
 * （不报错）。不含图 = 原数组原样返回。
 */
export function projectImagesForTextModel(messages: readonly Message[]): Message[] {
  return projectImagesWith(messages, textModelImagePlaceholder);
}

/** 超 wire 预算被摘除的图（模型可见的确定性交代；点名尺寸便于用户换图）。 */
export function overBudgetImageText(ref: ChatImageRef): string {
  return `[图片已省略（超出单图发送上限 ${Math.round(WIRE_MAX_IMAGE_BYTES / 1024 / 1024)}MiB）：${ref.name ?? ref.id.slice(0, 12)} ${ref.width}×${ref.height} ${(ref.bytes / 1024 / 1024).toFixed(1)}MiB。请压缩后重发，或改用更小的截图。]`;
}

/** 请求期解析产物（Request.imageData 形状）。 */
export type ResolvedRequestImages = Record<string, { mediaType: ImageMediaType; data: string }>;

/** 附图读取器的产物：字节 + **实际编码**媒型。
 *  媒型必须由读取器回报而非沿用 ref（规整可能把 PNG 换成 WebP/JPEG 压进 wire 带，
 *  沿用旧媒型 = data URI 与字节不符 = 服务商解码失败）。 */
export interface RequestImagePayload {
  mediaType: ImageMediaType;
  data: string;
}

/** 附图读取器（app 层闭包注入：attachments 路径 → 规整 → base64）。 */
export type RequestImageReader = (ref: ChatImageRef) => Promise<RequestImagePayload>;

/** 超 wire 预算的图 id 集合（② 最后一道闸——量的是**实际要发的 base64**）。
 *  读取器已按带规整；本闸兜住「规整失败降级为原字节」与「别家注入的读取器不走
 *  规整」两条路径：宁可摘图 + 占位（模型知道有图没送到），也不发注定挂起的包。 */
export function overWireBudgetIds(imageData: ResolvedRequestImages | undefined): Set<string> {
  const over = new Set<string>();
  if (imageData === undefined) return over;
  for (const [id, payload] of Object.entries(imageData)) {
    if (payload.data.length > WIRE_MAX_IMAGE_BASE64_CHARS) over.add(id);
  }
  return over;
}

/** 摘除超预算图（换占位文本 + 摘引用）——与「送不出去」投影同形状。 */
export function dropImagesOverBudget(messages: readonly Message[], ids: ReadonlySet<string>): Message[] {
  if (ids.size === 0) return [...messages];
  return projectImagesWith(messages, overBudgetImageText, ids);
}

/** 载荷里实际要发的附图 base64 总字符数（挂起分账的判据——见 agent.ts stream 重试循环）。 */
export function wireImageChars(imageData: ResolvedRequestImages | undefined): number {
  if (imageData === undefined) return 0;
  let n = 0;
  for (const payload of Object.values(imageData)) n += payload.data.length;
  return n;
}

/**
 * 引用 → 载荷解析（D-5）。读盘 + 规整经注入 reader（app 层闭包：工作区根拼
 * attachments 路径 → fs_cap read_base64 → wire 规整）；cache 键控 id——Agent
 * 实例级缓存由调用方持有，同图跨回合零重读。读失败的图**不入 imageData**——
 * 适配器 join 时自然跳过（wire 上该图缺失，不炸请求）；调用方
 * （Agent.streamOnce）拿期望集比对结果，缺图落日志、全失败降级占位
 * ——「送不出去」绝不静默（2026-09-19 事故的教训，见 projectImagesUnsent）。
 */
export async function resolveRequestImageData(
  messages: readonly Message[],
  reader: RequestImageReader,
  cache: Map<string, RequestImagePayload>,
): Promise<ResolvedRequestImages> {
  const out: ResolvedRequestImages = {};
  for (const ref of collectImageRefs(messages)) {
    if (cache.has(ref.id)) {
      const hit = cache.get(ref.id);
      if (hit) out[ref.id] = hit;
      continue;
    }
    try {
      const payload = await reader(ref);
      cache.set(ref.id, payload);
      out[ref.id] = payload;
    } catch {
      // 读失败：不入表（wire 缺图不炸）；缓存不落（下次请求可重试）
    }
  }
  return out;
}
