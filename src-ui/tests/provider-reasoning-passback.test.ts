// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 思考链回传规则（2026-09-23）——「模型看不看得见自己上一轮的推理」的单一对拍面。
//
// 规则真源（各家官方文档 + DSH `llm-deepseek` protocols/chat-completions/serialize.ts）：
//   ① OpenAI 兼容（chat completions）：**带 tools 参数的请求里，历史 assistant 轮的
//      `reasoning_content` 必须原样回传**，否则 API 返回 400（DeepSeek
//      guides/thinking_mode · Tool Calls 节原话：must be fully passed back … even for
//      turns where the model did not perform a tool call）；不带 tools 的请求官方忽略
//      该字段，回传无害。此前兰台一律不回传 ⇒ 直连 api.deepseek.com 时第一轮工具
//      调用之后每个请求都撞 400，且缺字段的消息已在卷里、整卷持续重放失败
//      （DSH 同类事故：deepseek-harness#3857）。
//   ② Anthropic：带签名的 thinking 块必须重放在 `tool_use` **之前**（协议硬要求）；
//      只有文本没有签名 ⇒ 不发（半份证明该协议拒收）。
//   ③ 空思考不发字段：缺字段 = 该轮思考关闭或网关剥离，编造空串不给模型任何信息。
//
// 用户操作序列（用例来源）：开思考档 → 问一句 → 模型调工具 → 再问一句。

import { describe, expect, it } from 'vitest';
import { buildRequest as buildAnthropicRequest } from '../src/plugins/builtin/llm-adapters/anthropic';
import { buildChatRequest } from '../src/plugins/builtin/llm-adapters/openai';
import type { Message } from '../src/provider/types';

/** assistant 轮工厂（只补本用例关心的字段）。 */
function assistant(over: Partial<Message>): Message {
  return { role: 'assistant', content: '答', ...over };
}

describe('思考链回传 — OpenAI 兼容（chat completions）', () => {
  it('历史 assistant 轮的思考随请求上行（带 tools 的请求是官方硬要求）', () => {
    const body = buildChatRequest(
      [
        { role: 'user', content: '问' },
        assistant({ content: '答', reasoning_content: '先想一步' }),
        { role: 'user', content: '再问' },
      ],
      [],
      'deepseek-v4-pro',
      100,
      'high',
    );

    expect(body.messages[1].reasoning_content).toBe('先想一步');
    // 正文与工具面不受影响（思考是**增补**字段，不是替换）。
    expect(body.messages[1].content).toBe('答');
  });

  it('工具轮（空正文 + tool_calls）同样带回思考', () => {
    const body = buildChatRequest(
      [
        assistant({
          content: '',
          reasoning_content: '该先查天气',
          tool_calls: [{ id: 'c1', name: 'get_weather', arguments: '{}' }],
        }),
        { role: 'tool', tool_call_id: 'c1', name: 'get_weather', content: '晴' },
      ],
      [],
      'deepseek-v4-pro',
      100,
      'high',
    );

    expect(body.messages[0].reasoning_content).toBe('该先查天气');
    expect(body.messages[0].tool_calls?.[0]).toMatchObject({ id: 'c1' });
  });

  it('空思考 → 字段缺席（老卷请求体逐字节不变，不编造空串）', () => {
    const body = buildChatRequest(
      [{ role: 'user', content: '问' }, assistant({ content: '答' })],
      [],
      'deepseek-v4-pro',
      100,
      'high',
    );

    expect('reasoning_content' in body.messages[1]).toBe(false);
  });
});

describe('思考链回传 — Anthropic（签名 thinking 块）', () => {
  it('带签名的思考重放在 tool_use 之前（协议要求的顺序）', () => {
    const body = buildAnthropicRequest(
      [
        {
          role: 'assistant',
          content: '好的',
          reasoning_content: '先想一步',
          reasoning_signature: 'sig-1',
          tool_calls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"杭州"}' }],
        },
      ],
      [],
      'claude-sonnet-4-6',
      'high',
      1024,
    );

    const blocks = body.messages[0].content;
    // 只锁块序与块内容：cache_control 断点由构造器另行注入（与本规则无关）。
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(blocks[0]).toMatchObject({ thinking: '先想一步', signature: 'sig-1' });
    expect(blocks[2]).toMatchObject({ id: 'c1', name: 'get_weather', input: { city: '杭州' } });
  });

  it('只有思考文本没有签名 → 不发 thinking 块（半份证明该协议拒收）', () => {
    const body = buildAnthropicRequest(
      [assistant({ content: '答', reasoning_content: '网关剥了签名' })],
      [],
      'claude-sonnet-4-6',
      'high',
      1024,
    );

    expect(body.messages[0].content.map((b) => b.type)).toEqual(['text']);
  });
});
