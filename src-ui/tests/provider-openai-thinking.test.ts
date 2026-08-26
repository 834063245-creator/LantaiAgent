// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

import { describe, expect, it } from 'vitest';
import { buildChatRequest } from '../src/provider/openai';
import type { Message } from '../src/provider/types';

const msgs: Message[] = [{ role: 'user', content: 'hi' }];

describe('buildChatRequest — thinking / reasoning_effort wire（P14 声明驱动）', () => {
  it('deepseek-v4-pro low → thinking enabled 包裹 + reasoning_effort low（用户官方文档核实）', () => {
    const body = buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, 'low');
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('low');
  });

  it('deepseek-v4-pro high/max 原值发送', () => {
    expect(buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, 'high').reasoning_effort).toBe('high');
    expect(buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, 'max').reasoning_effort).toBe('max');
  });

  it('deepseek-v4-pro 声明外档位（medium）→ 发请求前抛错，绝不静默替换为 high', () => {
    expect(() => buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, 'medium')).toThrow(/不支持/);
  });

  it('deepseek-v4-pro 自动 → 不发参数（服务端默认）', () => {
    const body = buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, '');
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('deepseek-v4-pro off → thinking disabled 包裹', () => {
    const body = buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, 'off');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('gpt-5.4（bare 方言）effort 原值发送，不发 thinking 包裹（P12 假包裹已移除）', () => {
    const body = buildChatRequest(msgs, [], 'gpt-5.4', 100, 'xhigh');
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBe('xhigh');
  });

  it('gpt-5.4 off → reasoning_effort none（5.1+ 语义），不发 thinking 包裹', () => {
    const body = buildChatRequest(msgs, [], 'gpt-5.4', 100, 'off');
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBe('none');
  });

  it('gpt-5 声明外档位（xhigh）→ 抛错', () => {
    expect(() => buildChatRequest(msgs, [], 'gpt-5', 100, 'xhigh')).toThrow(/不支持/);
  });

  it('无声明模型（glm-4.5）选中命名档位 → 原值发送，无包裹（目录外兼容路径）', () => {
    const body = buildChatRequest(msgs, [], 'glm-4.5', 100, 'high');
    expect(body.reasoning_effort).toBe('high');
    expect(body.thinking).toBeUndefined();
  });

  it('无声明模型（glm-4.5）选中 off → 不发参数（未声明关闭能力，不编造）', () => {
    const body = buildChatRequest(msgs, [], 'glm-4.5', 100, 'off');
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('无声明模型选中命名档位 → 放行发送（目录外端点兼容路径）', () => {
    const body = buildChatRequest(msgs, [], 'nonexistent-model', 100, 'high');
    expect(body.reasoning_effort).toBe('high');
  });

  it('maxTokensFor 优先于目录值（P14 per-model 用户覆盖）', () => {
    const body = buildChatRequest(msgs, [], 'deepseek-v4-pro', 100000, 'high', () => 64000);
    expect(body.max_tokens).toBe(64000);
  });

  it('数字遗留 thinking（Anthropic 预算串）→ 按自动处理', () => {
    const body = buildChatRequest(msgs, [], 'deepseek-v4-pro', 100, '16000');
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });
});
