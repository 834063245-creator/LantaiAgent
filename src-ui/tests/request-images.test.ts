// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 附图发送面纯函数回归（multimodal-image-plan B3）——预算降级（D-7 最旧先
// 移除）/ 文本模型投影（D-8③）/ 收集与请求期解析（D-5 缓存语义）。

import { describe, expect, it, vi } from 'vitest';
import {
  applyImageBudget,
  collectImageRefs,
  MAX_REQUEST_IMAGE_BYTES,
  MAX_REQUEST_IMAGES,
  offloadedImageText,
  projectImagesForTextModel,
  resolveRequestImageData,
  textModelImagePlaceholder,
} from '../src/agent/request-images';
import type { ChatImageRef, Message } from '../src/provider/types';

function ref(id: string, bytes = 1000, name?: string): ChatImageRef {
  return {
    id,
    mediaType: 'image/png',
    bytes,
    width: 800,
    height: 600,
    ...(name !== undefined ? { name } : {}),
  };
}

function userMsg(content: string, images?: ChatImageRef[]): Message {
  return {
    role: 'user',
    content,
    ...(images !== undefined ? { images } : {}),
  };
}

const R1 = ref('r1', 1000, 'a.png');
const R2 = ref('r2', 2000, 'b.png');
const R3 = ref('r3', 3000, 'c.png');

// ── 收集 ──

describe('collectImageRefs', () => {
  // 规格变更（P0a 工具附图通道，2026-09-17 明文声明）：
  // 旧规格 = 只收 user 消息的图（assistant 上挂 images 属越界，被忽略）；
  // 新规格 = user 与 tool 两类角色都收（工具产出的截图由此进上下文），
  // assistant 仍不携带附图。依据 docs/plans/tool-image-context-plan.md 裁定 3/6。
  it('收 user 与 tool 两类角色，按消息序×消息内序（最旧在前）；assistant 不携带', () => {
    const msgs: Message[] = [
      userMsg('1', [R1]),
      { role: 'assistant', content: 'x', images: [R2] } as unknown as Message,
      { role: 'tool', content: 'shot', tool_call_id: 'c1', images: [R2] } as unknown as Message,
      userMsg('2', [R2, R3]),
    ];
    // assistant 上的 R2 不参与；tool 上的 R2 参与 → 结果 [R1, R2, R2, R3]
    expect(collectImageRefs(msgs)).toEqual([R1, R2, R2, R3]);
  });

  it('无图载荷 → 空表（纯文本路径零开销）', () => {
    expect(collectImageRefs([userMsg('hi'), { role: 'assistant', content: 'ok' }])).toEqual([]);
  });
});

// ── 预算降级（D-7）──

describe('applyImageBudget', () => {
  it('无图载荷 → 消息对象引用原样保留（D-6 零开销）', () => {
    const msgs: Message[] = [userMsg('hi'), { role: 'assistant', content: 'ok' }];
    const out = applyImageBudget(msgs);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
  });

  it('预算内 → 零移除零拷贝（消息对象引用稳定，前缀缓存友好）', () => {
    const msgs: Message[] = [userMsg('看图', [R1, R2])];
    const out = applyImageBudget(msgs);
    expect(out[0]).toBe(msgs[0]);
  });

  it('数量超限 → 最旧先移除 + 确定性占位文本', () => {
    const old = userMsg('old', [R1]);
    const fresh = userMsg('fresh', [R2, R3]);
    const out = applyImageBudget([old, fresh], { maxImages: 2 });
    // R1 被移除；fresh 两张保住
    expect(out[0].images).toBeUndefined();
    expect(out[0].content).toContain(offloadedImageText(R1));
    expect(out[0].content).toContain('old');
    expect(out[1].images).toEqual([R2, R3]);
    expect(out[1].content).toBe('fresh');
  });

  it('字节超限 → 超预算的旧图移除、占位交代', () => {
    const big = { ...ref('big', MAX_REQUEST_IMAGE_BYTES + 1) };
    const msgs: Message[] = [userMsg('一', [big]), userMsg('二', [R3])];
    const out = applyImageBudget(msgs, { maxImages: 40, maxBytes: MAX_REQUEST_IMAGE_BYTES });
    expect(out[0].images).toBeUndefined();
    expect(out[0].content).toContain('big');
    expect(out[1].images).toEqual([R3]);
  });

  it('同一消息内超限 → 该消息内最旧先移除', () => {
    const msgs: Message[] = [userMsg('多图', [R1, R2, R3])];
    const out = applyImageBudget(msgs, { maxImages: 2, maxBytes: 1 << 30 });
    expect(out[0].images).toEqual([R2, R3]);
    expect(out[0].content).toContain(offloadedImageText(R1));
  });

  it('缺省上限常量钉值（漂移须显式改本测）', () => {
    expect(MAX_REQUEST_IMAGES).toBe(40);
    expect(MAX_REQUEST_IMAGE_BYTES).toBe(24 * 1024 * 1024);
  });
});

// ── 文本模型投影（D-8③）──

describe('projectImagesForTextModel', () => {
  it('全部图换文本占位（不报错——优雅降级）', () => {
    const msgs: Message[] = [userMsg('看这张', [R1, R2]), { role: 'assistant', content: 'ok' }];
    const out = projectImagesForTextModel(msgs);
    expect(out[0].images).toBeUndefined();
    expect(out[0].content).toContain(textModelImagePlaceholder(R1));
    expect(out[0].content).toContain(textModelImagePlaceholder(R2));
    expect(out[0].content).toContain('看这张');
    expect(out[1]).toBe(msgs[1]); // 无图消息引用原样
  });

  it('无图载荷 → 引用原样返回', () => {
    const msgs: Message[] = [userMsg('纯文本')];
    expect(projectImagesForTextModel(msgs)[0]).toBe(msgs[0]);
  });
});

// ── 请求期解析（D-5——缓存键控 id）──

describe('resolveRequestImageData', () => {
  // ⚡ 规格变更（2026-09-22 读图挂起事故）：读取器产物从裸 base64 改为
  // {mediaType, data}——wire 规整会把 PNG 换成 WebP 压进单图发送带，媒型必须由
  // 读取器回报而非沿用 ref（沿用 = data URI 与字节不符）。原两条断言形状不变，
  // 只是替身按新契约回话；新契约本身由下一条用例显式钉住。
  it('解析成功 → id 键控表 + 写缓存；二调命中缓存不再读盘', async () => {
    const reader = vi.fn(async () => ({ mediaType: 'image/png' as const, data: 'QUJD' }));
    const cache = new Map();
    const msgs: Message[] = [userMsg('x', [R1])];
    const out = await resolveRequestImageData(msgs, reader, cache);
    expect(out.r1).toEqual({ mediaType: 'image/png', data: 'QUJD' });
    expect(reader).toHaveBeenCalledTimes(1);

    const out2 = await resolveRequestImageData(msgs, reader, cache);
    expect(out2.r1).toEqual({ mediaType: 'image/png', data: 'QUJD' });
    expect(reader).toHaveBeenCalledTimes(1); // 缓存命中——零重读
  });

  it('媒型以读取器回报为准（规整换编码后不得沿用 ref 声明）', async () => {
    const reader = vi.fn(async () => ({ mediaType: 'image/webp' as const, data: 'UklGRg==' }));
    const out = await resolveRequestImageData([userMsg('x', [R1])], reader, new Map());
    expect(out.r1).toEqual({ mediaType: 'image/webp', data: 'UklGRg==' }); // ref 声明是 image/png
  });

  it('读失败 → 不入表不炸请求；缓存不落（下次可重试）', async () => {
    const reader = vi.fn(async (r: ChatImageRef) => {
      if (r.id === 'bad') throw new Error('盘上没了');
      return { mediaType: 'image/png' as const, data: 'OK' };
    });
    const cache = new Map();
    const msgs: Message[] = [userMsg('x', [ref('bad'), R2])];
    const out = await resolveRequestImageData(msgs, reader, cache);
    expect(out.bad).toBeUndefined();
    expect(out.r2).toEqual({ mediaType: 'image/png', data: 'OK' });
    expect(cache.has('bad')).toBe(false);
    expect(cache.has('r2')).toBe(true);
  });
});

// ── 占位文案 ──

describe('占位文本形状', () => {
  it('预算占位带身份与尺寸 + 重附指引', () => {
    expect(offloadedImageText(R1)).toContain('a.png');
    expect(offloadedImageText(R1)).toContain('800×600');
    expect(offloadedImageText(R1)).toContain('重新附图');
  });

  it('文本投影占位带身份与不支持注记', () => {
    expect(textModelImagePlaceholder(R1)).toContain('a.png');
    expect(textModelImagePlaceholder(R1)).toContain('不支持图片输入');
  });

  it('无名图用 id 前缀作身份（不泄漏路径）', () => {
    expect(textModelImagePlaceholder(ref('abcdef1234567890'))).toContain('abcdef123456');
  });
});
