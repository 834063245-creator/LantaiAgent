// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

import { describe, expect, it } from 'vitest';
import { buildChatRequest } from '../src/plugins/builtin/llm-adapters/openai';
import type { Message, ModelDescriptor } from '../src/provider/types';

const msgs: Message[] = [{ role: 'user', content: 'hi' }];

/** 自定义推理等级声明（override 合并后的 descriptor）。 */
function declared(
  map: NonNullable<ModelDescriptor['thinkingLevelMap']>,
  options: { efforts?: ModelDescriptor['thinkingEfforts']; deepseek?: boolean } = {},
): ModelDescriptor {
  return {
    id: 'm',
    name: 'M',
    kind: 'openai',
    vendor: 'gw',
    baseUrl: 'https://gw.test/v1',
    reasoning: true,
    input: ['text'],
    contextWindow: 1000,
    maxTokens: 100,
    thinkingEfforts: options.efforts ?? ['low', 'high'],
    thinkingLevelMap: map,
    ...(options.deepseek === true ? { deepseekThinking: true } : {}),
  };
}

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

// 2026-10-22 自定义推理等级（DSH `reasoningEfforts` 对齐）：值原样进 wire。
describe('buildChatRequest — 自定义推理等级（override 声明）', () => {
  it('声明值原样发送（high → deep，low → minimal）', () => {
    const desc = declared({ off: null, low: 'minimal', high: 'deep' });
    expect(buildChatRequest(msgs, [], 'm', 100, 'high', undefined, undefined, desc).reasoning_effort).toBe('deep');
    expect(buildChatRequest(msgs, [], 'm', 100, 'low', undefined, undefined, desc).reasoning_effort).toBe('minimal');
  });

  it('off:null = 不发参数（不编造 thinking 包裹）', () => {
    const body = buildChatRequest(
      msgs,
      [],
      'm',
      100,
      'off',
      undefined,
      undefined,
      declared({ off: null, high: 'deep' }),
    );
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('off 写成字符串 = 原样发送（OpenAI 5.1+ 的 none 等）', () => {
    expect(
      buildChatRequest(msgs, [], 'm', 100, 'off', undefined, undefined, declared({ off: 'none', high: 'deep' }))
        .reasoning_effort,
    ).toBe('none');
  });

  it('DeepSeek 方言仍加 thinking:{type:enabled} 包裹，值仍为声明值', () => {
    const body = buildChatRequest(
      msgs,
      [],
      'm',
      100,
      'high',
      undefined,
      undefined,
      declared({ off: null, high: 'deep' }, { deepseek: true }),
    );
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('deep');
  });

  it('声明外的档位仍在 I/O 前响亮报错（绝不静默替换）', () => {
    const desc = declared({ off: null, high: 'deep' }, { efforts: ['high'] });
    expect(() => buildChatRequest(msgs, [], 'm', 100, 'low', undefined, undefined, desc)).toThrow(/不支持/);
  });

  it('reasoningDisabled（用户显式声明不推理）→ 即使行值有档位也不发参数', () => {
    const desc = { ...declared({ off: null, high: 'deep' }), reasoning: false, reasoningDisabled: true };
    const body = buildChatRequest(msgs, [], 'm', 100, 'high', undefined, undefined, desc);
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });
});
