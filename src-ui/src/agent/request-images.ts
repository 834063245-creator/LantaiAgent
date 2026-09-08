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

/** 请求级预算占位文本（D-7——模型可见的确定性交代）。 */
export function offloadedImageText(ref: ChatImageRef): string {
  return `[图片已省略（超出请求预算）：${ref.name ?? ref.id.slice(0, 12)} ${ref.width}×${ref.height}。可请用户重新附图。]`;
}

/** 文本模型投影占位（D-8③——不报错，模型至少知道图存在过）。 */
export function textModelImagePlaceholder(ref: ChatImageRef): string {
  return `[图片：${ref.name ?? ref.id.slice(0, 12)}（${ref.width}×${ref.height}）——当前模型不支持图片输入，图已省略。]`;
}

/** 收集载荷里的全部附图引用（user 消息序——最旧在前）。 */
export function collectImageRefs(messages: readonly Message[]): ChatImageRef[] {
  const refs: ChatImageRef[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      for (const ref of m.images ?? []) refs.push(ref);
    }
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
    const images = m.role === 'user' ? m.images : undefined;
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
  if (!messages.some((m) => (m.images?.length ?? 0) > 0)) return [...messages];
  return messages.map((m) => {
    const images = m.role === 'user' ? m.images : undefined;
    if (images === undefined || images.length === 0) return m;
    const placeholder = images.map(textModelImagePlaceholder).join('\n');
    const { images: _drop, ...rest } = m;
    return { ...rest, content: appendPlaceholder(m.content, placeholder) };
  });
}

/** 请求期解析产物（Request.imageData 形状）。 */
export type ResolvedRequestImages = Record<string, { mediaType: ImageMediaType; data: string }>;

/**
 * 引用 → base64 解析（D-5）。读盘经注入 reader（app 层闭包：工作区根拼
 * attachments 路径 → fs_cap read_base64）；cache 键控 id——Agent 实例级
 * 缓存由调用方持有，同图跨回合零重读。读失败的图**不入 imageData**——
 * 适配器 join 时自然跳过（wire 上该图缺失，不炸请求）。
 */
export async function resolveRequestImageData(
  messages: readonly Message[],
  reader: (ref: ChatImageRef) => Promise<string>,
  cache: Map<string, { mediaType: ImageMediaType; data: string }>,
): Promise<ResolvedRequestImages> {
  const out: ResolvedRequestImages = {};
  for (const ref of collectImageRefs(messages)) {
    if (cache.has(ref.id)) {
      const hit = cache.get(ref.id);
      if (hit) out[ref.id] = hit;
      continue;
    }
    try {
      const data = await reader(ref);
      const entry = { mediaType: ref.mediaType, data };
      cache.set(ref.id, entry);
      out[ref.id] = entry;
    } catch {
      // 读失败：不入表（wire 缺图不炸）；缓存不落（下次请求可重试）
    }
  }
  return out;
}
