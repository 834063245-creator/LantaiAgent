// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  findModels,
  getAllModels,
  getCatalogVendors,
  getDefaultModel,
  getDynamicFetchFailure,
  getDynamicFetchInflight,
  getModel,
  hasDynamicFetchInflight,
  markDynamicFetchStart,
  mergeDynamicModels,
  onDynamicFetchChange,
  recordDynamicFetchResult,
  searchModels,
} from '../src/provider/catalog';
import { guessReasoningFromId } from '../src/provider/model-meta';
import { getVendorTemplateVendors } from '../src/provider/vendor-templates';

describe('catalog', () => {
  it('loads models from catalog seeds (内核 seed：deepseek/anthropic/openai 官方常用款)', () => {
    const all = getAllModels();
    // deepseek(4) + anthropic(4) + openai(10) 官方常用款（方案乙 seed 化精简）
    expect(all.length).toBeGreaterThanOrEqual(10);
  });

  it('returns template vendor names (模板表是 chips/枚举主真源)', () => {
    const vendors = getVendorTemplateVendors();
    expect(vendors).toContain('deepseek');
    expect(vendors).toContain('anthropic');
    expect(vendors).toContain('openai');
    expect(vendors).toContain('moonshotai');
    expect(vendors).toContain('minimax');
    expect(vendors).toContain('qwen');
    expect(vendors).toContain('glm');
    expect(vendors).toContain('ollama');
    expect(vendors).toContain('opencode');
  });

  it('getCatalogVendors 含内核 seed vendor（目录 seed 并入模板枚举）', () => {
    const vendors = getCatalogVendors();
    expect(vendors).toContain('deepseek');
    expect(vendors).toContain('anthropic');
    expect(vendors).toContain('openai');
  });

  it('findModels returns only models for the specified vendor', () => {
    const deepseekModels = findModels('deepseek');
    expect(deepseekModels.length).toBeGreaterThan(0);
    expect(deepseekModels.every((m) => m.vendor === 'deepseek')).toBe(true);
    // Should include deepseek-v4-pro
    expect(deepseekModels.some((m) => m.id === 'deepseek-v4-pro')).toBe(true);
  });

  it('findModels returns empty array for unknown vendor', () => {
    expect(findModels('nonexistent')).toEqual([]);
  });

  it('getModel returns a model by id', () => {
    const model = getModel('deepseek-v4-pro');
    expect(model).toBeDefined();
    if (!model) return; // narrow for type-checker
    expect(model.id).toBe('deepseek-v4-pro');
    expect(model.name).toBe('DeepSeek V4 Pro');
    expect(model.kind).toBe('openai');
    expect(model.vendor).toBe('deepseek');
    expect(model.reasoning).toBe(true);
    expect(model.contextWindow).toBeGreaterThan(0);
  });

  it('getModel returns undefined for unknown model id', () => {
    expect(getModel('nonexistent-model')).toBeUndefined();
  });

  it('searchModels matches by id substring', () => {
    const results = searchModels('deepseek');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((m) => m.id.includes('deepseek'))).toBe(true);
  });

  it('searchModels matches by vendor name', () => {
    const results = searchModels('anthropic');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((m) => m.vendor === 'anthropic')).toBe(true);
  });

  it('searchModels is case-insensitive', () => {
    const lower = searchModels('claude');
    const upper = searchModels('CLAUDE');
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBeGreaterThan(0);
  });

  it('searchModels returns all models for empty query', () => {
    const all = searchModels('');
    const allDirect = getAllModels();
    expect(all.length).toBe(allDirect.length);
  });

  it('getDefaultModel：内核 seed 厂商（anthropic/openai/deepseek）返回 seed 默认模型', () => {
    const expected: Record<string, string> = {
      anthropic: 'https://api.anthropic.com',
      openai: 'https://api.openai.com/v1',
      deepseek: 'https://api.deepseek.com/v1',
    };
    for (const [vendor, baseUrl] of Object.entries(expected)) {
      const model = getDefaultModel(vendor);
      expect(model, `default model for ${vendor}`).toBeDefined();
      expect(model?.baseUrl).toBe(baseUrl);
    }
  });

  it('getDefaultModel：模板复用他厂 seed id 的厂商（opencode）→ 造描述符对齐模板', () => {
    const model = getDefaultModel('opencode');
    expect(model).toBeDefined();
    expect(model?.id).toBe('deepseek-v4-flash');
    expect(model?.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(model?.kind).toBe('openai');
    expect(model?.vendor).toBe('opencode');
  });

  it('getDefaultModel：无 seed 的模板厂商（glm/moonshotai 等，方案乙运行时拉取）= undefined', () => {
    // 方案乙：非内核厂商 JSON 退役，可用模型运行时从 /models 拉取——
    // 出厂无默认模型（AddProviderSheet 两步式拉取后手动选定），不伪造 seed。
    expect(getDefaultModel('glm')).toBeUndefined();
    expect(getDefaultModel('moonshotai')).toBeUndefined();
    expect(getDefaultModel('minimax')).toBeUndefined();
    expect(getDefaultModel('ollama')).toBeUndefined();
    expect(getDefaultModel('qwen')).toBeUndefined();
  });

  it('getDefaultModel returns undefined for unknown vendor', () => {
    expect(getDefaultModel('nonexistent')).toBeUndefined();
  });

  it('anthropic models have kind=anthropic', () => {
    const anthropicModels = findModels('anthropic');
    expect(anthropicModels.every((m) => m.kind === 'anthropic')).toBe(true);
  });

  it('deepseek models have baseUrl ending with /v1 (OpenAI protocol)', () => {
    const deepseekModels = findModels('deepseek');
    for (const m of deepseekModels) {
      if (m.kind === 'openai') expect(m.baseUrl).toMatch(/\/v1$/);
    }
  });

  it('no model carries price fields (2026-09-06 价格表拆除：cost 字段退役)', () => {
    for (const m of getAllModels()) {
      expect('cost' in m, `${m.id} 仍带 cost 字段——价格表已拆除`).toBe(false);
    }
  });

  it('vision 声明面（B5 · D-8① + 2026-09-18 目录刷新）：DeepSeek V4.1 线全模态，仅 V4 Pro 纯文本', () => {
    // anthropic：Claude 3+ 全系 vision——4 款全声明
    for (const m of findModels('anthropic')) {
      expect(m.input, `${m.id}`).toContain('image');
    }
    // openai：GPT-4o 起全能线——GPT-6/GPT-5 系 10 款全声明
    for (const m of findModels('openai')) {
      expect(m.input, `${m.id}`).toContain('image');
    }
    // deepseek（2026-09-18 按官方文档刷新）：deepseek-flash（V4.1）原生多模态；
    // 旧名 v4-flash / v4-flash-vision-exp / v4-flash-beta 官方路由到 V4.1 Flash
    // （同收图）；deepseek-v4-pro（含 Beta）官方「图像理解 不支持」= 纯文本。
    const textOnly = new Set(['deepseek-v4-pro', 'deepseek-v4-pro-beta']);
    for (const m of findModels('deepseek')) {
      expect(m.input.includes('image'), `${m.id} 图像声明与官方文档不符`).toBe(!textOnly.has(m.id));
    }
    expect(getModel('deepseek-flash')?.input).toEqual(['text', 'image']);
    expect(getModel('deepseek-flash')?.contextWindow).toBe(1000000);
    expect(getModel('deepseek-v4-pro')?.input).toEqual(['text']);
  });

  it('GPT-6 换代 seed（2026-09-23 按官方模型页核实）：Astra/Sol/Luna 窗口 1.05M、输出 128K、全模态', () => {
    for (const id of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']) {
      const m = getModel(id);
      expect(m, id).toBeDefined();
      expect(m?.name).toMatch(/^GPT-6 /);
      expect(m?.contextWindow, `${id} 上下文窗口`).toBe(1050000);
      expect(m?.maxTokens, `${id} 输出上限`).toBe(128000);
      expect(m?.input, `${id} 模态`).toEqual(['text', 'image']);
      expect(m?.thinkingEfforts, `${id} 档位`).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    }
    // 档位差异是官方原文的差异：Astra 只列 low..max（无 none）⇒「关闭」不可表达；
    // Sol/Luna 明列 none ⇒ 可关（openai 协议发 reasoning_effort:'none'）。
    expect(getModel('gpt-6-astra')?.thinkingOff).toBeUndefined();
    expect(getModel('gpt-6-sol')?.thinkingOff).toBe(true);
    expect(getModel('gpt-6-luna')?.thinkingOff).toBe(true);
  });

  it('出厂默认模型随 GPT-6 换代：openai 与 codex 模板同指 gpt-6-sol', () => {
    const openai = getDefaultModel('openai');
    expect(openai?.id).toBe('gpt-6-sol');
    expect(openai?.baseUrl).toBe('https://api.openai.com/v1');
    // codex（OAuth 订阅）复用他厂 seed id → kind/baseUrl/vendor 对齐模板（非目录归属）
    const codex = getDefaultModel('codex');
    expect(codex?.id).toBe('gpt-6-sol');
    expect(codex?.kind).toBe('responses');
    expect(codex?.vendor).toBe('codex');
    expect(codex?.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
  });

  it('getDefaultModel(deepseek) = deepseek-flash（2026-09-18：出厂默认随官方改名刷新）', () => {
    const model = getDefaultModel('deepseek');
    expect(model?.id).toBe('deepseek-flash');
    expect(model?.vendor).toBe('deepseek');
    expect(model?.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('mergeDynamicModels adds out-of-catalog ids, skips existing ones', () => {
    mergeDynamicModels('testprov', [
      {
        id: 'brand-new-model-x',
        name: 'Brand New',
        kind: 'openai',
        vendor: 'testprov',
        baseUrl: 'https://api.testprov.com/v1',
        reasoning: true,
        input: ['text'],
        contextWindow: 0,
        maxTokens: 0,
      },
      {
        id: 'deepseek-v4-pro', // 静态目录已有 — 应被跳过（静态元数据优先）
        name: 'stale',
        kind: 'openai',
        vendor: 'testprov',
        baseUrl: 'https://stale.invalid/v1',
        reasoning: false,
        input: ['text'],
        contextWindow: 0,
        maxTokens: 0,
      },
    ]);
    const added = getModel('brand-new-model-x');
    expect(added).toBeDefined();
    expect(added?.vendor).toBe('testprov');
    // 静态条目未被覆盖
    const staticOne = getModel('deepseek-v4-pro');
    expect(staticOne?.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('C5: recordDynamicFetchResult 记失败面——失败记原因，成功清标记', () => {
    expect(getDynamicFetchFailure('c5-fail-prov')).toBeUndefined();
    recordDynamicFetchResult('c5-fail-prov', false, '网络错误');
    expect(getDynamicFetchFailure('c5-fail-prov')).toBe('网络错误');
    recordDynamicFetchResult('c5-fail-prov', true);
    expect(getDynamicFetchFailure('c5-fail-prov')).toBeUndefined();
  });

  it('C5: 失败原因缺省回落「获取失败」', () => {
    recordDynamicFetchResult('c5-err-prov', false);
    expect(getDynamicFetchFailure('c5-err-prov')).toBe('获取失败');
    recordDynamicFetchResult('c5-err-prov', true); // 清标记防污染
    expect(getDynamicFetchFailure('c5-err-prov')).toBeUndefined();
  });

  it('C5: last-good 保留——拉取失败不清已合并的动态模型', () => {
    mergeDynamicModels('c5-lastgood', [
      {
        id: 'c5-dynamic-x',
        name: 'C5 Dynamic',
        kind: 'openai',
        vendor: 'c5-lastgood',
        baseUrl: 'https://api.c5lastgood.com/v1',
        reasoning: false,
        input: ['text'],
        contextWindow: 0,
        maxTokens: 0,
      },
    ]);
    recordDynamicFetchResult('c5-lastgood', false, 'boom');
    // 失败后动态模型仍可查（静态目录 + last-good 兜底，不因失败消失）
    expect(getModel('c5-dynamic-x')).toBeDefined();
    expect(getDynamicFetchFailure('c5-lastgood')).toBe('boom');
  });

  it('D8: markDynamicFetchStart 标记拉取中，recordDynamicFetchResult 收尾即清', () => {
    expect(getDynamicFetchInflight('d8-prov')).toBe(false);
    markDynamicFetchStart('d8-prov');
    expect(getDynamicFetchInflight('d8-prov')).toBe(true);
    expect(hasDynamicFetchInflight()).toBe(true);
    // 成功与失败两条收尾路都清拉取中标记
    recordDynamicFetchResult('d8-prov', true);
    expect(getDynamicFetchInflight('d8-prov')).toBe(false);
    markDynamicFetchStart('d8-prov');
    recordDynamicFetchResult('d8-prov', false, 'boom');
    expect(getDynamicFetchInflight('d8-prov')).toBe(false);
    expect(hasDynamicFetchInflight()).toBe(false);
  });

  it('D8: onDynamicFetchChange 开始/收尾各通知一次，退订后静默', () => {
    let ticks = 0;
    const off = onDynamicFetchChange(() => {
      ticks++;
    });
    markDynamicFetchStart('d8-notify-prov');
    recordDynamicFetchResult('d8-notify-prov', true);
    expect(ticks).toBe(2);
    off();
    markDynamicFetchStart('d8-notify-prov');
    recordDynamicFetchResult('d8-notify-prov', true);
    expect(ticks).toBe(2);
  });

  it('guessReasoningFromId 启发式（P0 语义迁移 + 协议分野，仅端点未披露 reasoning 时生效）', () => {
    // openai 兼容：id 关键词表（原 openai.guessReasoning 行为逐条不变）
    expect(guessReasoningFromId('deepseek-v4-pro', 'openai')).toBe(true);
    expect(guessReasoningFromId('deepseek-reasoner', 'openai')).toBe(true);
    // 2026-09-18：官方改名后的 deepseek-flash（V4.1）也是推理模型（思考模式默认开）
    expect(guessReasoningFromId('deepseek-flash', 'openai')).toBe(true);
    expect(guessReasoningFromId('deepseek-v4.1-flash', 'openai')).toBe(true);
    expect(guessReasoningFromId('kimi-k2-thinking', 'openai')).toBe(true);
    expect(guessReasoningFromId('gpt-4o', 'openai')).toBe(false);
    expect(guessReasoningFromId('claude-3-5-sonnet', 'openai')).toBe(false);
    // anthropic：Claude 全系 sonnet/opus/haiku（原 anthropic.fetchModels 内联判定）
    expect(guessReasoningFromId('claude-sonnet-4-6', 'anthropic')).toBe(true);
    expect(guessReasoningFromId('claude-haiku-4-5', 'anthropic')).toBe(true);
    expect(guessReasoningFromId('some-custom-model', 'anthropic')).toBe(false);
    // responses：该协议端点全为推理模型（原 responses.fetchModels 的写死语义）
    expect(guessReasoningFromId('gpt-5.6-sol', 'responses')).toBe(true);
  });

  it('thinkingEfforts 是 canonical 词表子集且无重复（生成器保险丝）', () => {
    const VOCAB = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const m of getAllModels()) {
      if (!m.thinkingEfforts) continue;
      for (const e of m.thinkingEfforts) expect(VOCAB, `${m.id} 非法档位 ${e}`).toContain(e);
      expect(new Set(m.thinkingEfforts).size, `${m.id} 档位重复`).toBe(m.thinkingEfforts.length);
    }
  });
});
