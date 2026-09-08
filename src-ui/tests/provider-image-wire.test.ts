// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 附图 wire 形状契约（multimodal-image-plan B3）——三协议（openai/anthropic/
// responses）的附图 content parts 构造 + 纯文本 wire 形态字节不变（D-6）。
// 输入用「解析表 + 引用」直呼各协议请求构造器（provider-openai-thinking 同款
// 直呼面姿势）；断言对齐各协议官方多模态形态。

import { describe, expect, it } from 'vitest';
import { buildRequest as buildAnthropicRequest } from '../src/provider/anthropic';
import { buildChatRequest } from '../src/provider/openai';
import { buildResponsesRequest } from '../src/provider/responses';
import type { ChatImageRef, Message } from '../src/provider/types';

const IMG_A: ChatImageRef = {
  id: 'img-a',
  mediaType: 'image/png',
  bytes: 9,
  width: 800,
  height: 600,
  name: '截图A.png',
};
const IMG_B: ChatImageRef = {
  id: 'img-b',
  mediaType: 'image/jpeg',
  bytes: 9,
  width: 1024,
  height: 768,
};

const imageDataTable = {
  'img-a': { mediaType: 'image/png' as const, data: 'QUJD' },
  'img-b': { mediaType: 'image/jpeg' as const, data: 'REVG' },
};

function sessionWithImages(): Message[] {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '看这两张图', images: [IMG_A, IMG_B] },
  ];
}

// ── openai 兼容协议 ──

describe('openai buildChatRequest — 附图 content parts（B3）', () => {
  it('user 带图 + 解析表 → text part 在前、image_url data URI 在后', () => {
    const body = buildChatRequest(sessionWithImages(), [], 'gpt-5.4', 100, undefined, undefined, imageDataTable);
    const userMsg = body.messages.find((m) => m.role === 'user');
    const parts = userMsg?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]).toEqual({ type: 'text', text: '看这两张图' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
    expect(parts[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,REVG' } });
  });

  it('无 imageData（引用在、表缺）→ 纯文本 string 形态（D-6 字节不变）', () => {
    const body = buildChatRequest(sessionWithImages(), [], 'gpt-5.4', 100, undefined);
    const userMsg = body.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('看这两张图'); // string——不带图也不炸
  });

  it('解析缺图的引用自然跳过（wire 缺图不炸请求）', () => {
    const partial = { 'img-b': imageDataTable['img-b'] }; // img-a 读失败
    const body = buildChatRequest(sessionWithImages(), [], 'gpt-5.4', 100, undefined, undefined, partial);
    const parts = body.messages.find((m) => m.role === 'user')?.content as Array<{ type: string }>;
    expect(parts).toHaveLength(2); // 只剩 text + img-b
    expect(parts[1].type).toBe('image_url');
  });

  it('纯文本会话零图路径 → content 恒 string（D-6 回归钉）', () => {
    const body = buildChatRequest([{ role: 'user', content: 'hi' }], [], 'gpt-5.4', 100, '');
    expect(body.messages[0]?.content).toBe('hi');
  });
});

// ── anthropic 协议 ──

describe('anthropic buildRequest — image blocks（B3）', () => {
  it('user 带图 → text 块在前、image base64 源块在后', () => {
    const body = buildAnthropicRequest(sessionWithImages(), [], 'claude-x', '', 100, undefined, imageDataTable);
    const userMsg = body.messages.find((m) => m.role === 'user');
    const blocks = userMsg?.content as Array<{
      type: string;
      source?: { type: string; media_type: string; data: string };
    }>;
    expect(blocks[0]).toMatchObject({ type: 'text', text: '看这两张图' });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    });
    expect(blocks[2]?.source?.media_type).toBe('image/jpeg');
  });

  it('无图 user 消息 → 单 text 块（D-6 字节不变；末消息块带既有缓存锚属预期）', () => {
    const body = buildAnthropicRequest([{ role: 'user', content: 'hi' }], [], 'claude-x', '', 100);
    const userMsg = body.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toEqual([expect.objectContaining({ type: 'text', text: 'hi' })]);
  });
});

// ── responses 协议 ──

describe('responses buildResponsesRequest — input_image（B3）', () => {
  it('user 带图 → input_text + input_image(data URI) 混排', () => {
    const body = buildResponsesRequest(sessionWithImages(), [], 'gpt-5.4', 100, undefined, undefined, imageDataTable);
    const userItem = body.input.find((i) => i.role === 'user');
    const content = userItem?.content as Array<{ type: string; text?: string; image_url?: string }>;
    expect(content[0]).toEqual({ type: 'input_text', text: '看这两张图' });
    expect(content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,QUJD' });
    expect(content[2]).toEqual({ type: 'input_image', image_url: 'data:image/jpeg;base64,REVG' });
  });

  it('纯文本 → content 单 input_text（D-6 回归钉）', () => {
    const body = buildResponsesRequest([{ role: 'user', content: 'hi' }], [], 'gpt-5.4', 100, '');
    const userItem = body.input.find((i) => i.role === 'user');
    expect(userItem?.content).toEqual([{ type: 'input_text', text: 'hi' }]);
  });
});
