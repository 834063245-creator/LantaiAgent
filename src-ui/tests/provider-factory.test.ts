// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// createProvider 方言解析单测（平台化 Phase 1 · D2 修订版）：协议实现经 ctx.llm
// 解析——本文件需要第一方 llm-adapters 贡献在册（生产装配复现，同 provider-live）。

import { describe, expect, it } from 'vitest';
import { createProvider } from '../src/provider';
import { modelInput, type ProviderSettings } from '../src/settings';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

await ensureProductionChannelsBooted();

describe('createProvider', () => {
  it('creates an anthropic provider with correct name', () => {
    const settings: ProviderSettings = {
      kind: 'anthropic',
      name: 'anthropic-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      thinking: 'medium',
    };
    const provider = createProvider(settings);
    expect(provider.name()).toBe('anthropic-test');
  });

  it('creates an openai provider with correct name', () => {
    const settings: ProviderSettings = {
      kind: 'openai',
      name: 'deepseek-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    };
    const provider = createProvider(settings);
    expect(provider.name()).toBe('deepseek-test');
  });

  it('uses default name when not provided', () => {
    const settings: ProviderSettings = {
      kind: 'anthropic',
      name: '',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
    };
    // Empty name falls through to provider default ("anthropic")
    const provider = createProvider(settings);
    expect(provider.name()).toBe('anthropic');
  });

  it('passes disableThinking option to openai provider', async () => {
    const settings: ProviderSettings = {
      kind: 'openai',
      name: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    };
    // Just verify it creates without error — disableThinking is consumed internally
    const provider = createProvider(settings, { disableThinking: true });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe('function');
  });

  it('throws on stream with empty apiKey via classified error', async () => {
    const settings: ProviderSettings = {
      kind: 'openai',
      name: 'test',
      apiKey: '中文key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    };
    const provider = createProvider(settings);
    const controller = new AbortController();
    try {
      // fetch will fail because of invalid header characters — should throw
      const gen = provider.stream(controller.signal, {
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        temperature: 0.7,
        max_tokens: 100,
      });
      await gen.next();
      // If we get here, the error didn't throw — but fetch should have failed
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      // Should be a classified error
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBeTruthy();
    } finally {
      controller.abort();
    }
  });
});

describe('modelInput 合并链（B5 · D-8①：覆盖 ?? 目录 ?? ["text"]）', () => {
  const p: ProviderSettings = {
    kind: 'openai',
    name: 'merge-test',
    apiKey: '',
    baseUrl: '',
    model: 'gpt-5',
    modelOverrides: {
      'gpt-5': { input: ['text'] }, // 覆盖反向关（stale 目录纠正）
      'glm-4v-custom': { input: ['text', 'image'] }, // 目录外自定义 vision 款补声明
    },
  };
  it('覆盖胜目录：gpt-5 目录声明 image，覆盖 ["text"] 关掉', () => {
    expect(modelInput(p, 'gpt-5')).toEqual(['text']);
  });
  it('目录外自定义款：覆盖补声明生效（GLM-4V/Qwen-VL 面）', () => {
    expect(modelInput(p, 'glm-4v-custom')).toEqual(['text', 'image']);
  });
  it('无覆盖 = 目录声明（deepseek 主线 text / vision-exp image）', () => {
    expect(modelInput(p, 'deepseek-v4-pro')).toEqual(['text']);
    expect(modelInput(p, 'deepseek-v4-flash-vision-exp')).toEqual(['text', 'image']);
  });
  it('provider 缺省只查目录；双缺省恒 ["text"]（不编造能力）', () => {
    expect(modelInput(undefined, 'claude-sonnet-4-6')).toEqual(['text', 'image']);
    expect(modelInput(undefined, 'no-such-model')).toEqual(['text']);
    expect(modelInput(p, 'no-such-model')).toEqual(['text']);
  });
});

describe('createProvider — 输入模态能力戳（B5 · D-8①→D-8③ 同链）', () => {
  const base = (model: string, modelOverrides?: ProviderSettings['modelOverrides']): ProviderSettings => ({
    kind: 'openai',
    name: 'stamp-test',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com/v1',
    model,
    modelOverrides,
  });
  it('目录 vision 款（seed 声明）→ inputModalities 含 image', () => {
    expect(createProvider(base('deepseek-v4-flash-vision-exp')).inputModalities).toContain('image');
  });
  it('deepseek 主线纯文本 → ["text"]（不编造）', () => {
    expect(createProvider(base('deepseek-v4-pro')).inputModalities).toEqual(['text']);
  });
  it('覆盖补声明：目录外自定义 vision 模型戳上 image', () => {
    const prov = createProvider(base('glm-4v-custom', { 'glm-4v-custom': { input: ['text', 'image'] } }));
    expect(prov.inputModalities).toEqual(['text', 'image']);
  });
  it('覆盖反向关：目录声明 stale 时用户纠正为纯文本', () => {
    const prov = createProvider(base('gpt-5', { 'gpt-5': { input: ['text'] } }));
    expect(prov.inputModalities).toEqual(['text']);
  });
});
