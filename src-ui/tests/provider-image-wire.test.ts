// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 附图 wire 形状契约（multimodal-image-plan B3）——三协议（openai/anthropic/
// responses）的附图 content parts 构造 + 纯文本 wire 形态字节不变（D-6）。
// 输入用「解析表 + 引用」直呼各协议请求构造器（provider-openai-thinking 同款
// 直呼面姿势）；断言对齐各协议官方多模态形态。

import { describe, expect, it } from 'vitest';
import { buildRequest as buildAnthropicRequest } from '../src/plugins/builtin/llm-adapters/anthropic';
import { buildChatRequest } from '../src/plugins/builtin/llm-adapters/openai';
import { buildResponsesRequest } from '../src/plugins/builtin/llm-adapters/responses';
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

// ── 工具附图（P0a 工具附图通道，docs/plans/tool-image-context-plan.md）──
//
// 三协议各自的「工具结果带图」合法形态 + 无图路径字节不变。
// 由来：工具产出的截图此前永远进不了模型上下文（附图只挂 user 消息），
// 于是「模型自查自己的渲染结果」这条环断在这里。

/** 一轮：用户提问 → assistant 调 browser_screenshot → tool 结果带图 */
function sessionWithToolImage(): Message[] {
  return [
    { role: 'user', content: '截图看看那张卡' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', name: 'browser_screenshot', arguments: '{}' }],
    },
    {
      role: 'tool',
      content: '{"path":"shot-1.png","bytes":1234}',
      tool_call_id: 'call-1',
      name: 'browser_screenshot',
      images: [IMG_A],
    },
  ];
}

describe('anthropic buildRequest — tool_result 内容块数组（P0a）', () => {
  it('tool 带图 → tool_result.content 为 [text, image] 数组（该协议原生形态）', () => {
    const body = buildAnthropicRequest(sessionWithToolImage(), [], 'claude-x', '', 100, undefined, imageDataTable);
    const flat = body.messages.flatMap((m) => m.content);
    const tr = flat.find((b) => b.type === 'tool_result');
    const blocks = tr?.content as Array<{ type: string; text?: string; source?: { data: string } }>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toBe('{"path":"shot-1.png","bytes":1234}');
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    });
  });

  it('tool 无图 → content 仍是字符串（D-6 字节不变）', () => {
    const msgs = sessionWithToolImage().map((m) => (m.role === 'tool' ? { ...m, images: undefined } : m));
    const body = buildAnthropicRequest(msgs, [], 'claude-x', '', 100, undefined, imageDataTable);
    const tr = body.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(typeof tr?.content).toBe('string');
  });

  it('解析表缺该图 → 退回字符串形态（wire 缺图不炸）', () => {
    const body = buildAnthropicRequest(sessionWithToolImage(), [], 'claude-x', '', 100, undefined, {});
    const tr = body.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(typeof tr?.content).toBe('string');
  });
});

describe('openai buildChatRequest — 工具附图合成 user 消息（P0a）', () => {
  it('tool 带图 → tool 组之后补一条 user 消息带 image_url（tool role 不收图）', () => {
    const body = buildChatRequest(sessionWithToolImage(), [], 'gpt-5.4', 100, undefined, undefined, imageDataTable);
    const roles = body.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user']);
    const last = body.messages[3].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(Array.isArray(last)).toBe(true);
    expect(last[0].type).toBe('text');
    expect(last[0].text).toContain('browser_screenshot');
    expect(last[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
  });

  it('tool 无图 → 消息数不变（D-6 字节不变）', () => {
    const msgs = sessionWithToolImage().map((m) => (m.role === 'tool' ? { ...m, images: undefined } : m));
    const body = buildChatRequest(msgs, [], 'gpt-5.4', 100, undefined, undefined, imageDataTable);
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('载荷以 tool 组收尾 → 附图消息在循环后补上（组尾 flush）', () => {
    const msgs = sessionWithToolImage().slice(1); // assistant + tool
    const body = buildChatRequest(msgs, [], 'gpt-5.4', 100, undefined, undefined, imageDataTable);
    expect(body.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
  });
});

describe('responses buildResponsesRequest — function_call_output 内容项（P0a）', () => {
  it('tool 带图 → output 数组 [input_text, input_image]', () => {
    const body = buildResponsesRequest(
      sessionWithToolImage(),
      [],
      'gpt-5.4',
      100,
      undefined,
      undefined,
      imageDataTable,
    );
    const item = body.input.find((i) => i.type === 'function_call_output');
    const out = item?.output as Array<{ type: string; text?: string; image_url?: string }>;
    expect(out[0]).toEqual({ type: 'input_text', text: '{"path":"shot-1.png","bytes":1234}' });
    expect(out[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,QUJD' });
  });

  it('tool 无图 → 仍是字符串 output（D-6：纯文本载荷形态不变，字段名合规）', () => {
    const msgs = sessionWithToolImage().map((m) => (m.role === 'tool' ? { ...m, images: undefined } : m));
    const body = buildResponsesRequest(msgs, [], 'gpt-5.4', 100, undefined, undefined, imageDataTable);
    const item = body.input.find((i) => i.type === 'function_call_output');
    // 字段名 = 官方 schema 的 `output`（`FunctionCallOutput.output` 必填）——
    // 2026-09-23 合规批次修正（旧实现发 schema 里不存在的 `output_text`）。
    expect(item?.output).toBe('{"path":"shot-1.png","bytes":1234}');
  });
});
