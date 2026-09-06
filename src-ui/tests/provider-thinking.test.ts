// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

import { describe, expect, it } from 'vitest';
import { getModel } from '../src/provider/catalog';
import {
  assertEffortDeclared,
  type ThinkingCapability,
  thinkingCapability,
  thinkingOptionsFor,
} from '../src/provider/thinking';
import type { ModelDescriptor } from '../src/provider/types';

function desc(partial: Partial<ModelDescriptor>): ModelDescriptor {
  return {
    id: 'test-model',
    name: 'Test',
    kind: 'openai',
    vendor: 'test',
    baseUrl: 'https://api.test/v1',
    reasoning: true,
    input: ['text'],
    contextWindow: 100000,
    maxTokens: 32000,
    ...partial,
  };
}

describe('thinkingCapability — 声明提炼（P14）', () => {
  it('目录声明照单提炼', () => {
    const cap = thinkingCapability(
      desc({ thinkingEfforts: ['low', 'high', 'max'], thinkingOff: true, deepseekThinking: true }),
    );
    expect(cap.efforts).toEqual(['low', 'high', 'max']);
    expect(cap.off).toBe(true);
    expect(cap.deepseekWrap).toBe(true);
  });

  it('无描述符 = 无声明（不编造档位/关闭/方言）', () => {
    const cap = thinkingCapability(undefined);
    expect(cap.efforts).toEqual([]);
    expect(cap.off).toBe(false);
    expect(cap.deepseekWrap).toBe(false);
  });

  it('目录条目缺省字段 = 无声明', () => {
    const cap = thinkingCapability(desc({}));
    expect(cap.efforts).toEqual([]);
    expect(cap.off).toBe(false);
    expect(cap.deepseekWrap).toBe(false);
  });
});

describe('thinkingOptionsFor — UI 档位表（声明驱动）', () => {
  it('自动档恒有；声明档位按词表序；声明 off 才有关闭', () => {
    const opts = thinkingOptionsFor(desc({ thinkingEfforts: ['max', 'low'], thinkingOff: true }));
    expect(opts.map((o) => o.value)).toEqual(['', 'low', 'max', 'off']);
  });

  it('未声明 off → 不出现关闭档', () => {
    const opts = thinkingOptionsFor(desc({ thinkingEfforts: ['high'] }));
    expect(opts.map((o) => o.value)).toEqual(['', 'high']);
  });

  it('无声明 = 空表（UI 回退全局开关）', () => {
    expect(thinkingOptionsFor(undefined)).toEqual([]);
    expect(thinkingOptionsFor(desc({}))).toEqual([]);
  });

  it('静态目录条目（deepseek-v4-pro）：low/high/max + off', () => {
    const opts = thinkingOptionsFor(getModel('deepseek-v4-pro'));
    expect(opts.map((o) => o.value)).toEqual(['', 'low', 'high', 'max', 'off']);
  });

  it('静态目录条目（gpt-5.4）：low..xhigh + off，无 max', () => {
    const opts = thinkingOptionsFor(getModel('gpt-5.4'));
    expect(opts.map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'off']);
  });

  it('静态目录条目（glm-4.5 无声明）：空表', () => {
    expect(thinkingOptionsFor(getModel('glm-4.5'))).toEqual([]);
  });
});

describe('assertEffortDeclared — 发请求前的响亮门禁（P14）', () => {
  const cap: ThinkingCapability = { efforts: ['low', 'high', 'max'], off: true, deepseekWrap: false };

  it('声明内档位放行', () => {
    expect(() => assertEffortDeclared('low', cap, 'openai')).not.toThrow();
    expect(() => assertEffortDeclared('max', cap, 'openai')).not.toThrow();
  });

  it('自动/关闭/数字遗留不拦（协议层各管各的降级）', () => {
    expect(() => assertEffortDeclared('', cap, 'openai')).not.toThrow();
    expect(() => assertEffortDeclared('off', cap, 'openai')).not.toThrow();
    expect(() => assertEffortDeclared('16000', cap, 'openai')).not.toThrow();
    expect(() => assertEffortDeclared(undefined, cap, 'openai')).not.toThrow();
  });

  it('声明外档位响亮报错，绝不静默替换（medium 不在 DeepSeek 声明内）', () => {
    expect(() => assertEffortDeclared('medium', cap, 'openai')).toThrow(/不支持.*medium/);
  });

  it('错误文案点名协议与设置入口', () => {
    expect(() => assertEffortDeclared('minimal', cap, 'anthropic')).toThrow(/Anthropic/);
  });

  it('无声明模型不拦（目录外端点不能因未知档位而炸）', () => {
    const unknown: ThinkingCapability = { efforts: [], off: false, deepseekWrap: false };
    expect(() => assertEffortDeclared('high', unknown, 'openai')).not.toThrow();
  });
});
