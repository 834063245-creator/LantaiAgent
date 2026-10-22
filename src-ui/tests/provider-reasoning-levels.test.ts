// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// per-model 自定义推理等级（2026-10-22 对齐 DSH `reasoningEfforts`）：
// descriptor 合并 / 能力协商 / wire 查询 / providers.yml 校验。

import { describe, expect, it } from 'vitest';
import { applyProvidersDoc, parseProvidersDoc, parseSection } from '../src/provider/providers-doc';
import { thinkingCapability, thinkingOptionsFor, thinkingWireFor } from '../src/provider/thinking';
import {
  modelDescriptor,
  modelThinkingEfforts,
  modelThinkingLevelMap,
  modelThinkingOff,
  type ProviderSettings,
  providerId,
} from '../src/settings';

function row(over: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    kind: 'openai',
    name: providerId('gw'),
    apiKey: '',
    baseUrl: 'https://gw.test/v1',
    model: 'm',
    ...over,
  };
}

describe('modelDescriptor — 自定义推理等级（override 最高优先）', () => {
  it('声明表进 descriptor：档位按 canonical 序、档位值原样保留、off 键 = 可关闭', () => {
    const p = row({
      modelOverrides: {
        m: { reasoningEfforts: { off: null, high: 'deep', low: 'low' } },
      },
    });
    const desc = modelDescriptor(p, 'm');
    expect(desc?.reasoning).toBe(true);
    expect(desc?.thinkingEfforts).toEqual(['low', 'high']);
    expect(desc?.thinkingLevelMap).toEqual({ off: null, high: 'deep', low: 'low' });
    expect(desc?.thinkingOff).toBe(true);
    expect(thinkingOptionsFor(desc).map((o) => o.value)).toEqual(['', 'low', 'high', 'off']);
  });

  it('override 压过 API 拉取/目录声明（含 off 能力与 reasoning 标志）', () => {
    const p = row({
      modelMeta: { m: { thinkingEfforts: ['medium'], thinkingOff: false, fetchedAt: 1 } },
      modelOverrides: { m: { reasoningEfforts: { off: 'none', high: 'deep' } } },
    });
    expect(modelThinkingEfforts(p, 'm')).toEqual(['high']);
    expect(modelThinkingLevelMap(p, 'm')).toEqual({ off: 'none', high: 'deep' });
    expect(modelThinkingOff(p, 'm')).toBe(true);
    expect(modelDescriptor(p, 'm')?.thinkingEfforts).toEqual(['high']);
  });

  it('reasoningEfforts: false = 显式不推理（清掉目录声明的能力）', () => {
    const p = row({
      modelMeta: { m: { reasoning: true, thinkingEfforts: ['low', 'high'], fetchedAt: 1 } },
      modelOverrides: { m: { reasoningEfforts: false } },
    });
    expect(modelDescriptor(p, 'm')?.reasoning).toBe(false);
    expect(modelDescriptor(p, 'm')?.reasoningDisabled).toBe(true);
    expect(modelThinkingEfforts(p, 'm')).toBeUndefined();
    expect(modelThinkingLevelMap(p, 'm')).toBeUndefined();
    expect(modelThinkingOff(p, 'm')).toBe(false);
  });

  it('没有自定义声明时保持旧链（API 拉取 ?? 目录）', () => {
    const p = row({ modelMeta: { m: { thinkingEfforts: ['low', 'max'], fetchedAt: 1 } } });
    expect(modelThinkingEfforts(p, 'm')).toEqual(['low', 'max']);
    expect(modelThinkingLevelMap(p, 'm')).toBeUndefined();
    expect(modelDescriptor(p, 'm')?.thinkingOff).toBeUndefined();
  });
});

describe('thinkingCapability / thinkingWireFor — 自定义值查询', () => {
  const desc = {
    id: 'm',
    name: 'M',
    kind: 'openai',
    vendor: 'gw',
    baseUrl: 'https://gw.test/v1',
    reasoning: true,
    input: ['text'] as ('text' | 'image')[],
    contextWindow: 1000,
    maxTokens: 100,
    thinkingEfforts: ['low', 'high'] as const,
    thinkingLevelMap: { off: null, low: 'minimal', high: 'deep' },
  };

  it('capability 带出 levelMap，off 由 map 的键裁决', () => {
    const cap = thinkingCapability(desc);
    expect(cap.efforts).toEqual(['low', 'high']);
    expect(cap.off).toBe(true);
    expect(cap.levelMap).toEqual({ off: null, low: 'minimal', high: 'deep' });
  });

  it('描述符只带 levelMap 时也能按 canonical 序派生档位', () => {
    const cap = thinkingCapability({ ...desc, thinkingEfforts: undefined });
    expect(cap.efforts).toEqual(['low', 'high']);
  });

  it('查询返回档位值；未声明的档位/空档位 = undefined', () => {
    expect(thinkingWireFor(desc, 'low')).toBe('minimal');
    expect(thinkingWireFor(desc, 'high')).toBe('deep');
    expect(thinkingWireFor(desc, 'off')).toBeNull();
    expect(thinkingWireFor(desc, 'medium')).toBeUndefined();
    expect(thinkingWireFor(desc, '')).toBeUndefined();
    expect(thinkingWireFor(undefined, 'high')).toBeUndefined();
  });
});

describe('providers.yml — modelOverrides.reasoningEfforts 校验', () => {
  const base = { kind: 'openai', baseUrl: 'https://x/v1', model: 'm' };

  function section(reasoningEfforts: unknown) {
    return parseSection('gw', {
      ...base,
      modelOverrides: { m: { reasoningEfforts } },
    });
  }

  it('合法声明按存储顺序解析（off 可为 null，其余必须非空字符串）', () => {
    const parsed = section({ off: null, low: 'low', high: 'deep' });
    expect('intent' in parsed).toBe(true);
    if (!('intent' in parsed)) return;
    expect(parsed.intent.modelOverrides).toEqual({
      m: { reasoningEfforts: { off: null, low: 'low', high: 'deep' } },
    });
  });

  it('false 合法（显式声明该模型不推理）', () => {
    const parsed = section(false);
    expect('intent' in parsed && parsed.intent.modelOverrides?.m.reasoningEfforts).toBe(false);
  });

  it.each([
    ['空对象', {}, '至少'],
    ['只有 off', { off: null }, '至少'],
    ['思考档位 null', { high: null }, '非空字符串'],
    ['思考档位空串', { high: '' }, '非空字符串'],
    ['off 空串', { off: '', high: 'high' }, 'off'],
    ['未知档位', { turbo: 'x', high: 'high' }, '未知档位'],
    ['非对象', true, '必须是'],
    ['数组', ['high'], '必须是'],
  ])('%s → 点名报错', (_label, value, needle) => {
    const parsed = section(value);
    expect('errors' in parsed).toBe(true);
    if (!('errors' in parsed)) return;
    expect(parsed.errors.join('\n')).toContain(needle);
  });

  it('写盘/读回保持声明（含 off:null）', () => {
    const text = applyProvidersDoc('', {
      gw: {
        kind: 'openai',
        baseUrl: 'https://x/v1',
        model: 'm',
        modelOverrides: { m: { reasoningEfforts: { off: null, high: 'deep' } } },
      },
    });
    expect(text).toContain('reasoningEfforts:');
    expect(text).toContain('high: deep');
    const parsed = parseProvidersDoc(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.sections[0]?.intent.modelOverrides?.m.reasoningEfforts).toEqual({ off: null, high: 'deep' });
  });
});
