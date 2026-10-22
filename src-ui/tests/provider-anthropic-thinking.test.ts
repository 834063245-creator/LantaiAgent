// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Anthropic 方言的自定义推理等级（2026-10-22 对齐 DSH）：
// 数字参数值 = budget_tokens；非数字 = adaptive thinking 的 output_config.effort。

import { describe, expect, it } from 'vitest';
import { buildRequest } from '../src/plugins/builtin/llm-adapters/anthropic';
import type { Message, ModelDescriptor } from '../src/provider/types';

const msgs: Message[] = [{ role: 'user', content: 'hi' }];

function declared(
  map: NonNullable<ModelDescriptor['thinkingLevelMap']>,
  efforts: ModelDescriptor['thinkingEfforts'],
): ModelDescriptor {
  return {
    id: 'm',
    name: 'M',
    kind: 'anthropic',
    vendor: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 32000,
    thinkingEfforts: efforts,
    thinkingLevelMap: map,
  };
}

describe('buildRequest — 自定义推理等级 wire', () => {
  it('数字参数值 = budget_tokens（钳到 32000）', () => {
    const body = buildRequest(
      msgs,
      [],
      'm',
      'high',
      64000,
      undefined,
      undefined,
      declared({ off: null, high: '24000' }, ['high']),
    );
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 24000 });
    expect(body.output_config).toBeUndefined();
  });

  it('非数字参数值 = adaptive thinking + output_config.effort', () => {
    const body = buildRequest(
      msgs,
      [],
      'm',
      'high',
      64000,
      undefined,
      undefined,
      declared({ off: null, high: 'deep' }, ['high']),
    );
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'deep' });
  });

  it('off:null = 不发 thinking 块', () => {
    const body = buildRequest(
      msgs,
      [],
      'm',
      'off',
      64000,
      undefined,
      undefined,
      declared({ off: null, high: 'deep' }, ['high']),
    );
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('off 写成字符串 = 声明可关闭，发 thinking:{type:disabled}', () => {
    const body = buildRequest(
      msgs,
      [],
      'm',
      'off',
      64000,
      undefined,
      undefined,
      declared({ off: 'none', high: 'deep' }, ['high']),
    );
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toBeUndefined();
  });

  it('没有自定义声明时走既有 canonical budget（high → 16000）', () => {
    const body = buildRequest(msgs, [], 'm', 'high', 64000);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    expect(body.output_config).toBeUndefined();
  });
});
