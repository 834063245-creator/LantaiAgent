// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// tool-images — 工具附图通道（P0a，docs/plans/tool-image-context-plan.md）。
//
// 问题：工具产出的图片（截图族）此前永远进不了模型上下文——附图通道只认 user
// 消息（INVARIANTS #14 的「仅 user 携带」），于是模型只能拿到一个 PNG 路径，
// 「自查渲染结果」这条环断在这里（taste-ledger 2026-08-22 点名的结构性瓶颈）。
//
// 本模块是**解析单一真源**（对齐 asset-kinds.parseAssetEventOutput 的位置与纪律）：
// 工具输出 JSON 里可带 image 引用描述；executor 在 tool.imageChannel === true 时
// 经本函数取出引用，挂到该次工具结果的消息上（字节仍在盘上，卷里只有引用）。
//
// 纪律：
//   - 宽容读取 / 严格校验：形状不符 → 返回空数组（不炸链路，附件是增益），
//     但字段值非法（id 非 sha256 hex / 媒型不在白名单 / 尺寸非正）→ 该条丢弃；
//   - 不在这里做 wire 映射（那是适配器的事）；不在这里读盘（请求期才解析）。

import type { ChatImageRef, ImageMediaType } from '../provider/types';

/** 附图媒型白名单（与 image-intake 同源口径——不新开口子）。 */
const MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** sha256 hex（ChatImageRef.id 的内容寻址口径）。 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** 单个引用的合法性判据（内容寻址 id + 白名单媒型 + 正整数读数）。 */
function toRef(v: unknown): ChatImageRef | null {
  if (v == null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.toLowerCase() : '';
  if (!SHA256_HEX.test(id)) return null;
  const mediaType = typeof o.mediaType === 'string' ? o.mediaType : '';
  if (!MEDIA_TYPES.includes(mediaType)) return null;
  const bytes = typeof o.bytes === 'number' && Number.isFinite(o.bytes) && o.bytes > 0 ? o.bytes : null;
  const width = typeof o.width === 'number' && Number.isInteger(o.width) && o.width > 0 ? o.width : null;
  const height = typeof o.height === 'number' && Number.isInteger(o.height) && o.height > 0 ? o.height : null;
  if (bytes === null || width === null || height === null) return null;
  const out: ChatImageRef = { id, mediaType: mediaType as ImageMediaType, bytes, width, height };
  // 显示名剥路径分隔符（与 image-intake 同纪律：名字只作展示）
  if (typeof o.name === 'string' && o.name) {
    out.name = o.name.split(/[\\/]/).pop() ?? o.name;
  }
  return out;
}

/**
 * 从工具输出里取出附图引用（imageChannel 工具的唯一解析点）。
 *
 * 接受两种形态（工具作者任选，都是输出 JSON 内的一个键）：
 *   - `image: {...}`  单张（截图族主用）
 *   - `images: [{...}]` 多张
 * 解析失败/形状不符 → `[]`（不抛：附图缺席不该让工具结果失败）。
 */
export function parseToolImageOutput(output: string): ChatImageRef[] {
  if (!output) return [];
  let val: unknown;
  try {
    val = JSON.parse(output);
  } catch {
    return [];
  }
  if (val == null || typeof val !== 'object') return [];
  const o = val as Record<string, unknown>;
  const out: ChatImageRef[] = [];
  const single = toRef(o.image);
  if (single) out.push(single);
  if (Array.isArray(o.images)) {
    for (const item of o.images) {
      const ref = toRef(item);
      if (ref) out.push(ref);
    }
  }
  // 同 id 去重（内容寻址：同图重复出现只送一次）
  const seen = new Set<string>();
  const out2: ChatImageRef[] = [];
  for (const ref of out) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out2.push(ref);
  }
  return out2;
}

/** 输出是否为附图信封（至少含一条合法引用）。
 *  工具输出的**包装层**（fs 的 [file:] 焦点回显 / state-read 状态前缀等）据此
 *  放行：信封是机器可读 JSON，在其上再拼人读文本会让 executor 的解析失败——
 *  图会静默丢失（2026-09-18 附图读图批的接线纪律）。 */
export function hasImageRefs(output: string): boolean {
  return parseToolImageOutput(output).length > 0;
}
