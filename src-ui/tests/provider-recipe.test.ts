// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 配方（2026-09-17）：导出剥密钥 / 导入白名单严格校验 / 套用保身份与密钥。

import { describe, expect, it } from 'vitest';
import {
  applyRecipeToProvider,
  exportProviderRecipe,
  parseProviderRecipe,
  RECIPE_FORMAT,
  RECIPE_VERSION,
} from '../src/provider/provider-recipe';
import { type ProviderSettings, providerId } from '../src/settings';

const row: ProviderSettings = {
  kind: 'openai',
  name: providerId('opencodego'),
  apiKey: 'sk-secret',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  model: 'deepseek-v4.1-flash',
  models: ['deepseek-v4.1-flash'],
  headers: { 'x-opencode-session': 'sess-1' },
  modelOverrides: { 'deepseek-v4.1-flash': { contextWindow: 1000000, maxTokens: 384000 } },
  modelMeta: {
    'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, fetchedAt: 1 },
  },
  lastTest: { status: 'ok', latencyMs: 120, at: 1 },
};

describe('exportProviderRecipe', () => {
  it('剥掉 apiKey 与 lastTest，保留连接配置与请求头', () => {
    const text = exportProviderRecipe(row);
    expect(text).not.toContain('sk-secret');
    const file = JSON.parse(text);
    expect(file.format).toBe(RECIPE_FORMAT);
    expect(file.version).toBe(RECIPE_VERSION);
    expect(file.provider.apiKey).toBeUndefined();
    expect(file.provider.lastTest).toBeUndefined();
    expect(file.provider.headers).toEqual({ 'x-opencode-session': 'sess-1' });
    expect(file.provider.modelOverrides['deepseek-v4.1-flash'].contextWindow).toBe(1000000);
  });
});

describe('parseProviderRecipe', () => {
  it('往返：导出 → 解析得到等价配方', () => {
    const parsed = parseProviderRecipe(exportProviderRecipe(row));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.recipe).toEqual({
      kind: 'openai',
      name: 'opencodego',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      model: 'deepseek-v4.1-flash',
      models: ['deepseek-v4.1-flash'],
      headers: { 'x-opencode-session': 'sess-1' },
      modelOverrides: { 'deepseek-v4.1-flash': { contextWindow: 1000000, maxTokens: 384000 } },
      modelMeta: {
        'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, fetchedAt: 1 },
      },
    });
  });

  it('配方里的 apiKey 被忽略并给出告知', () => {
    const withKey = JSON.parse(exportProviderRecipe(row));
    withKey.provider.apiKey = 'sk-leaked';
    const parsed = parseProviderRecipe(JSON.stringify(withKey));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.recipe).not.toHaveProperty('apiKey');
    expect(parsed.notices.join()).toContain('apiKey');
  });

  it('非 JSON / 错 format / 错版本 / 缺必填字段整单拒绝（错误可读）', () => {
    expect(parseProviderRecipe('not json')).toHaveProperty('error');
    expect(parseProviderRecipe(JSON.stringify({ format: 'other', version: 1, provider: {} }))).toHaveProperty('error');
    const wrongVersion = JSON.parse(exportProviderRecipe(row));
    wrongVersion.version = 99;
    expect(parseProviderRecipe(JSON.stringify(wrongVersion))).toHaveProperty('error');
    const missing = JSON.parse(exportProviderRecipe(row));
    delete missing.provider.baseUrl;
    const parsed = parseProviderRecipe(JSON.stringify(missing));
    expect('error' in parsed && parsed.error).toContain('provider.baseUrl');
  });

  it('非法请求头整单拒绝（不静默丢弃）', () => {
    const recipe = JSON.parse(exportProviderRecipe(row));
    recipe.provider.headers = { 'bad name': 'v' };
    const parsed = parseProviderRecipe(JSON.stringify(recipe));
    expect('error' in parsed && parsed.error).toContain('bad name');
  });

  it('未登记字段被白名单丢弃（不落盘垃圾键）', () => {
    const recipe = JSON.parse(exportProviderRecipe(row));
    recipe.provider.unknownJunk = { x: 1 };
    const parsed = parseProviderRecipe(JSON.stringify(recipe));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.recipe).not.toHaveProperty('unknownJunk');
  });

  // 2026-09-23：目录快照与 per-model 思考档位随配方同行（收方拿到就能勾选/复用档位）
  it('目录快照 + per-model 思考档位随配方往返', () => {
    const withNew: ProviderSettings = {
      ...row,
      catalog: ['deepseek-v4.1-flash', 'claude-opus-4-6'],
      modelOverrides: { 'deepseek-v4.1-flash': { thinking: 'max' } },
    };
    const parsed = parseProviderRecipe(exportProviderRecipe(withNew));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.recipe.catalog).toEqual(['deepseek-v4.1-flash', 'claude-opus-4-6']);
    expect(parsed.recipe.modelOverrides?.['deepseek-v4.1-flash']?.thinking).toBe('max');
  });

  it('per-model 思考档位非法值整单拒绝（写入边界严格）', () => {
    const recipe = JSON.parse(exportProviderRecipe(row));
    recipe.provider.modelOverrides = { m1: { thinking: '超高' } };
    const parsed = parseProviderRecipe(JSON.stringify(recipe));
    expect('error' in parsed && parsed.error).toContain('thinking');
  });
});

describe('applyRecipeToProvider', () => {
  it('套用只改连接配置：名字与密钥保持本行', () => {
    const target: ProviderSettings = {
      kind: 'openai',
      name: providerId('my-row'),
      apiKey: 'sk-local',
      baseUrl: '',
      model: '',
    };
    const parsed = parseProviderRecipe(exportProviderRecipe(row));
    if ('error' in parsed) throw new Error(parsed.error);
    const next = applyRecipeToProvider(target, parsed.recipe);
    expect(next.name).toBe('my-row');
    expect(next.apiKey).toBe('sk-local');
    expect(next.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(next.headers).toEqual({ 'x-opencode-session': 'sess-1' });
  });
});
