// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// provider-model-meta 全链守护（2026-09-11 彻查修复）——用户报告：
// 「提供方从 API 拉取模型，到底有没有拉到上下文容量/视觉/思考强度？是不是没把
//  参数持久化给模型设置？」
// 结论与修复：
//   ① 三处 fetchModels 此前硬编码「只读 data[].id」，把 contextWindow/maxTokens
//      写死 0、input 写死 ['text']、name 丢弃——而聚合网关的 /models 真的给
//      name + context_length（实测某网关 69/69 条带 context_length）；
//   ② 拉到的元数据从不持久化——只落 id 列表（ProviderSettings.models），元数据
//      随进程消失，重启后一律吃 200K 假默认；
//   ③ 请求期读全局 getModel（无 provider 上下文）——即便解析了也到不了 wire。
// 本文件从用户操作序列钉死修复后的行为：拉取 → 解析 → 落盘 → 重启后仍生效 →
// 抵达请求体（max_tokens 钳制）。
//
// 四层解析链（单一权威源 settings.ts）：用户覆盖 ?? API 拉取元数据 ?? 目录 seed
// ?? 默认。纪律：端点未披露 = 不编造（窗口 0 / input ['text'] / 无档位声明）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
async function mockRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const snakeKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
      normalized[snakeKey] = value;
    }
  }
  return mockInvoke('rpc', { method, params: normalized });
}
vi.mock('../src/bridge', () => ({
  invoke: vi.fn(),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { createProvider } from '../src/provider';
import { _resetCredentialCacheForTests } from '../src/provider/credentials';
import { createLiveProvider } from '../src/provider/live';
import { metaHasContent, modelEntries, parseModelEntry } from '../src/provider/model-meta';
import { applyFetchedModels, mergeIntoProvider } from '../src/provider/model-sync';
import { resetProxyPort } from '../src/provider/transport';
import { ChunkType, type Request } from '../src/provider/types';
import {
  type AppSettings,
  effectiveModels,
  loadSettings,
  modelContextWindow,
  modelDescriptor,
  modelInput,
  modelMaxTokens,
  modelReasoning,
  type ProviderSettings,
  providerId,
} from '../src/settings';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

await ensureProductionChannelsBooted();

const CTX = { kind: 'openai', vendor: 'gw', baseUrl: 'https://gw.test/v1' };

// ── ① 宽容解析：各端点方言的字段识别 ─────────────────────────────────

describe('parseModelEntry — 各端点方言的字段识别（认得就填）', () => {
  it('聚合网关形态：name + context_length（实测 commandcode 端点 69/69 条都带）', () => {
    const parsed = parseModelEntry(
      { id: 'claude-sonnet-5', object: 'model', owned_by: 'gw', name: 'Claude Sonnet 5', context_length: 1000000 },
      CTX,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.descriptor.id).toBe('claude-sonnet-5');
    expect(parsed?.descriptor.name).toBe('Claude Sonnet 5'); // 此前被丢弃 → 回落生 id
    expect(parsed?.descriptor.contextWindow).toBe(1000000);
    expect(parsed?.meta.contextWindow).toBe(1000000);
    expect(parsed?.meta.name).toBe('Claude Sonnet 5');
  });

  it('OpenRouter 形态：context_length + architecture.input_modalities + supported_parameters + top_provider', () => {
    const parsed = parseModelEntry(
      {
        id: 'google/gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        context_length: 1048576,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        supported_parameters: ['temperature', 'reasoning', 'tools'],
        top_provider: { context_length: 1048576, max_completion_tokens: 65536 },
      },
      CTX,
    );
    expect(parsed?.descriptor.contextWindow).toBe(1048576);
    expect(parsed?.descriptor.input).toEqual(['text', 'image']);
    expect(parsed?.descriptor.reasoning).toBe(true); // supported_parameters 证据
    expect(parsed?.descriptor.maxTokens).toBe(65536);
  });

  it('Gemini 原生形态：inputTokenLimit / outputTokenLimit', () => {
    const parsed = parseModelEntry(
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 2097152, outputTokenLimit: 65536 },
      CTX,
    );
    expect(parsed?.descriptor.contextWindow).toBe(2097152);
    expect(parsed?.descriptor.maxTokens).toBe(65536);
  });

  it('LM Studio / vLLM 形态：max_context_length / max_model_len（字符串数字也认）', () => {
    expect(parseModelEntry({ id: 'qwen3-32b', max_context_length: 32768 }, CTX)?.descriptor.contextWindow).toBe(32768);
    expect(parseModelEntry({ id: 'qwen3-32b', max_model_len: '131072' }, CTX)?.descriptor.contextWindow).toBe(131072);
  });

  it('Ollama /api/show 形态：capabilities + model_info.<arch>.context_length', () => {
    const parsed = parseModelEntry(
      {
        id: 'llama3.2:latest',
        capabilities: ['completion', 'vision'],
        model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 },
      },
      CTX,
    );
    expect(parsed?.descriptor.contextWindow).toBe(8192);
    expect(parsed?.descriptor.input).toEqual(['text', 'image']); // vision capability
  });

  it('官方最小形态（仅 id/object/owned_by）→ 不编造：窗口 0、input ["text"]、meta 无内容字段', () => {
    const parsed = parseModelEntry({ id: 'minimax-m3', object: 'model', owned_by: 'opencode' }, CTX);
    expect(parsed?.descriptor.contextWindow).toBe(0);
    expect(parsed?.descriptor.maxTokens).toBe(0);
    expect(parsed?.descriptor.input).toEqual(['text']);
    expect(metaHasContent(parsed?.meta ?? { fetchedAt: 0 })).toBe(false);
  });

  it('无 id / 非对象条目 → null（调用面过滤）', () => {
    expect(parseModelEntry({ object: 'model' }, CTX)).toBeNull();
    expect(parseModelEntry('nope', CTX)).toBeNull();
    expect(parseModelEntry(null, CTX)).toBeNull();
  });

  it('显式 reasoning 证据优先于 id 启发式（启发式绝不覆盖证据）', () => {
    // gpt-4o 的 id 启发式为 false，但端点明说支持 reasoning → 以证据为准
    const withEvidence = parseModelEntry({ id: 'gpt-4o', supported_parameters: ['reasoning'] }, CTX);
    expect(withEvidence?.descriptor.reasoning).toBe(true);
    // 无证据时回落启发式（既有 P0 语义）
    expect(parseModelEntry({ id: 'deepseek-v4-pro' }, CTX)?.descriptor.reasoning).toBe(true);
  });

  it('思考档位：端点显式给数组才采用，且过 canonical 词表（非词表成员丢弃）', () => {
    const parsed = parseModelEntry({ id: 'm', thinking_efforts: ['low', 'high', 'turbo'] }, CTX);
    expect(parsed?.descriptor.thinkingEfforts).toEqual(['low', 'high']);
    // 主流端点不披露 → 无声明（UI 不显示档位选择器，请求不发 effort）
    expect(parseModelEntry({ id: 'm' }, CTX)?.descriptor.thinkingEfforts).toBeUndefined();
  });

  it('modelEntries：兼容 data[] / models[] / 裸数组', () => {
    expect(modelEntries({ data: [{ id: 'a' }] })).toHaveLength(1);
    expect(modelEntries({ models: [{ id: 'a' }, { id: 'b' }] })).toHaveLength(2);
    expect(modelEntries([{ id: 'a' }])).toHaveLength(1);
    expect(modelEntries({ nope: 1 })).toEqual([]);
  });

  it('contextWindow 数值守卫：0 / 负数 / 非数字不认（不编造）', () => {
    expect(parseModelEntry({ id: 'm', context_length: 0 }, CTX)?.descriptor.contextWindow).toBe(0);
    expect(parseModelEntry({ id: 'm', context_length: -5 }, CTX)?.meta.contextWindow).toBeUndefined();
    expect(parseModelEntry({ id: 'm', context_length: 'abc' }, CTX)?.meta.contextWindow).toBeUndefined();
  });
});

// ── ② 四层解析链（settings 单一权威源）─────────────────────────────────

describe('settings 四层链：用户覆盖 ?? API 拉取元数据 ?? 目录 seed ?? 默认', () => {
  const base = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
    kind: 'openai',
    name: providerId('gw'),
    apiKey: '',
    baseUrl: 'https://gw.test/v1',
    model: 'gw-model-x',
    ...over,
  });

  it('modelContextWindow：覆盖 > 拉取元数据 > seed > 200K 默认', () => {
    // seed 命中（deepseek-v4-pro 目录值 1M）
    expect(modelContextWindow(base({ model: 'deepseek-v4-pro' }), 'deepseek-v4-pro')).toBe(1000000);
    // 网关模型（seed 无）——此前恒 200K 假默认
    expect(modelContextWindow(base(), 'gw-model-x')).toBe(200000);
    // 拉取元数据补上真实窗口
    expect(
      modelContextWindow(base({ modelMeta: { 'gw-model-x': { contextWindow: 1050000, fetchedAt: 1 } } }), 'gw-model-x'),
    ).toBe(1050000);
    // 用户覆盖压过拉取元数据（纠正面）
    expect(
      modelContextWindow(
        base({
          modelMeta: { 'gw-model-x': { contextWindow: 1050000, fetchedAt: 1 } },
          modelOverrides: { 'gw-model-x': { contextWindow: 262144 } },
        }),
        'gw-model-x',
      ),
    ).toBe(262144);
    // 拉取元数据压过 seed（网关视野 vs 模型本体视野不同时以实测为准）
    expect(
      modelContextWindow(
        base({ model: 'deepseek-v4-pro', modelMeta: { 'deepseek-v4-pro': { contextWindow: 128000, fetchedAt: 1 } } }),
        'deepseek-v4-pro',
      ),
    ).toBe(128000);
  });

  it('modelMaxTokens / modelInput / modelReasoning 同链', () => {
    const p = base({
      modelMeta: {
        'gw-model-x': { maxTokens: 65536, input: ['text', 'image'], reasoning: true, fetchedAt: 1 },
      },
    });
    expect(modelMaxTokens(p, 'gw-model-x')).toBe(65536);
    expect(modelInput(p, 'gw-model-x')).toEqual(['text', 'image']);
    expect(modelReasoning(p, 'gw-model-x')).toBe(true);
    // 覆盖仍压过元数据
    expect(modelInput({ ...p, modelOverrides: { 'gw-model-x': { input: ['text'] } } }, 'gw-model-x')).toEqual(['text']);
  });

  it('modelDescriptor：合并 seed + 元数据 + 覆盖，供方言请求期解析（vendor 用 provider 名）', () => {
    const d = modelDescriptor(
      base({
        modelMeta: { 'gw-model-x': { name: 'GW Model X', contextWindow: 400000, maxTokens: 128000, fetchedAt: 1 } },
      }),
      'gw-model-x',
    );
    expect(d?.name).toBe('GW Model X');
    expect(d?.contextWindow).toBe(400000);
    expect(d?.maxTokens).toBe(128000);
    expect(d?.vendor).toBe('gw');
    expect(d?.kind).toBe('openai');
    // seed 与元数据皆无 → undefined（目录外模型语义，不编造）
    expect(modelDescriptor(base(), 'nothing-known')).toBeUndefined();
  });
});

// ── ③ 落盘合并（model-sync 单一写入口）───────────────────────────────

describe('applyFetchedModels — 拉取结果的唯一 settings 落点（目录 / 启用分层，2026-09-23）', () => {
  const settingsOf = (p: Partial<ProviderSettings>): AppSettings => ({
    activeProvider: providerId('gw'),
    providers: [
      {
        kind: 'openai',
        name: providerId('gw'),
        apiKey: '',
        baseUrl: 'https://gw.test/v1',
        model: 'a',
        ...p,
      },
    ],
    projectPath: '.',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  });

  it('拉取只写目录（catalog）：启用集一行不碰——「拉过来就全在列表里」不再发生', () => {
    const next = applyFetchedModels(settingsOf({ model: 'hand-added', models: ['hand-added'] }), 'gw', {
      models: [{ id: 'pulled-1' }, { id: 'pulled-2' }] as never,
      meta: {},
    });
    expect(next.providers[0].catalog).toEqual(['pulled-1', 'pulled-2']);
    expect(next.providers[0].models).toEqual(['hand-added']); // 用户启用集保持原样
    expect(next.providers[0].model).toBe('hand-added');
  });

  it('目录是快照不是并集：远端下架的模型从目录消失，已启用的它保留（不静默撤销用户选择）', () => {
    const first = applyFetchedModels(settingsOf({ models: ['pulled-1', 'pulled-2'] }), 'gw', {
      models: [{ id: 'pulled-1' }, { id: 'pulled-2' }] as never,
      meta: {},
    });
    const second = applyFetchedModels(first, 'gw', { models: [{ id: 'pulled-1' }] as never, meta: {} });
    expect(second.providers[0].catalog).toEqual(['pulled-1']);
    expect(second.providers[0].models).toEqual(['pulled-1', 'pulled-2']);
  });

  it('空拉取（端点无 data）不清 last-good 目录，元数据照常合并', () => {
    const next = applyFetchedModels(settingsOf({ catalog: ['old-1'] }), 'gw', {
      models: [],
      meta: { m1: { name: 'M One', fetchedAt: 2 } },
    });
    expect(next.providers[0].catalog).toEqual(['old-1']);
    expect(next.providers[0].modelMeta?.m1?.name).toBe('M One');
  });

  it('元数据落盘：字段级合并，本次未披露的字段保留 last-good', () => {
    const next = applyFetchedModels(
      settingsOf({ modelMeta: { m1: { contextWindow: 1000000, maxTokens: 384000, fetchedAt: 1 } } }),
      'gw',
      { models: [], meta: { m1: { name: 'M One', fetchedAt: 2 } } },
    );
    expect(next.providers[0].modelMeta?.m1).toEqual({
      contextWindow: 1000000, // last-good 保留
      maxTokens: 384000, // last-good 保留
      name: 'M One', // 本次新增
      fetchedAt: 2,
    });
  });

  it('空壳元数据（端点什么都没披露）不落盘——id 仍进目录（目录不靠元数据键复原）', () => {
    const next = applyFetchedModels(settingsOf({ model: '', models: [] }), 'gw', {
      models: [{ id: 'bare-id' }] as never,
      meta: { 'bare-id': { fetchedAt: 1 } },
    });
    expect(next.providers[0].catalog).toEqual(['bare-id']);
    expect(next.providers[0].modelMeta).toBeUndefined();
  });

  it('provider 行已删 → 原样返回（不凭空造行）', () => {
    const s = settingsOf({});
    expect(applyFetchedModels(s, 'ghost', { models: [{ id: 'x' }] as never, meta: {} })).toBe(s);
  });

  it('mergeIntoProvider：旧存档（无 models 字段）拉取后启用集仍空——生效列表回落 [model]', () => {
    const p = mergeIntoProvider(
      { kind: 'openai', name: providerId('gw'), apiKey: '', baseUrl: 'u', model: 'legacy-default' },
      ['new-1'],
      {},
    );
    expect(p.catalog).toEqual(['new-1']);
    expect(p.models).toBeUndefined();
    expect(effectiveModels(p)).toEqual(['legacy-default']); // 用户的默认模型照常可用
  });
});

// ── ④ 端到端：拉取 → 落盘 → 重启后仍生效 → 抵达请求体 ──────────────────

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}
const fetchCalls: FetchCall[] = [];

/** 网关 /models 响应（name + context_length）+ 最小 SSE 回放。 */
const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
  if (url.includes('/models')) {
    return new Response(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'gw-a', object: 'model', name: 'GW Model A', context_length: 262144 },
          { id: 'gw-b', object: 'model', name: 'GW Model B', context_length: 1050000 },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  fetchCalls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n` +
            'data: [DONE]\n\n',
        ),
      );
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
});

function seedSettings(over: Partial<ProviderSettings> = {}): void {
  localStorage.setItem(
    'hologram_settings',
    JSON.stringify({
      activeProvider: 'gw',
      providers: [{ kind: 'openai', name: 'gw', apiKey: '', baseUrl: 'https://gw.test/v1', model: 'gw-a', ...over }],
      projectPath: '.',
      agent: {},
      display: { language: 'zh', fontScale: 1 },
    }),
  );
}

async function streamOnce(prov: {
  stream(s: AbortSignal, r: Request): AsyncGenerator<{ type: number }>;
}): Promise<void> {
  const req: Request = { messages: [{ role: 'user', content: 'q' }], tools: [], temperature: 0, max_tokens: 0 };
  for await (const c of prov.stream(new AbortController().signal, req)) {
    if (c.type === ChunkType.Done) break;
  }
}

beforeEach(() => {
  localStorage.clear();
  fetchCalls.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  _resetCredentialCacheForTests();
  resetProxyPort();
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((_cmd: string, payload: { method: string }) =>
    Promise.resolve(payload.method === 'credential_get' ? JSON.stringify('sk-test') : null),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('端到端：从 API 拉取 → 落盘 → 重启后仍生效 → 抵达请求体', () => {
  it('fetchModels 带回 name + context_length；lastModelMeta 拿到同一批元数据', async () => {
    seedSettings();
    const prov = createLiveProvider('gw');
    const models = await prov.fetchModels?.();
    expect(models?.map((m) => m.id)).toEqual(['gw-a', 'gw-b']);
    // descriptor 侧：窗口与名字都到位（此前恒 0 / 生 id）
    expect(models?.[1].contextWindow).toBe(1050000);
    expect(models?.[0].name).toBe('GW Model A');
    // 落盘面 side-channel：只含证据字段
    const meta = prov.lastModelMeta?.();
    expect(meta?.['gw-b'].contextWindow).toBe(1050000);
    expect(meta?.['gw-a'].name).toBe('GW Model A');
  });

  it('applyFetchedModels 落进 settings 后，modelMeta 随保存持久化（重启后仍在）', async () => {
    seedSettings();
    const prov = createLiveProvider('gw');
    const models = (await prov.fetchModels?.()) ?? [];
    const next = applyFetchedModels(loadSettings(), 'gw', { models, meta: prov.lastModelMeta?.() ?? {} });
    localStorage.setItem('hologram_settings', JSON.stringify(next));

    // 「重启」= 重新读盘：元数据仍在（此前只落 id 列表，元数据随进程消失）
    const reloaded = loadSettings();
    expect(reloaded.providers[0].catalog).toEqual(['gw-a', 'gw-b']); // 目录快照同样持久化
    expect(reloaded.providers[0].modelMeta?.['gw-b'].contextWindow).toBe(1050000);
    expect(modelContextWindow(reloaded.providers[0], 'gw-b')).toBe(1050000); // 不再是 200K 假默认
    expect(modelContextWindow(reloaded.providers[0], 'gw-a')).toBe(262144);
  });

  it('拉取到的 maxTokens 抵达请求体（此前网关模型永远不钳制）', async () => {
    seedSettings({
      model: 'gw-b',
      modelMeta: { 'gw-b': { contextWindow: 1050000, maxTokens: 8192, fetchedAt: 1 } },
    });
    const prov = createLiveProvider('gw');
    await streamOnce(prov);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.model).toBe('gw-b');
    expect(fetchCalls[0].body.max_tokens).toBe(8192); // 请求 max_tokens=0 → 默认值被元数据上限钳制
  });

  it('视觉元数据抵达 Provider.inputModalities（附图门禁同链）', () => {
    // provider 行的默认模型即 gw-b——createProvider 的能力戳按 settings.model 解析
    seedSettings({ model: 'gw-b', modelMeta: { 'gw-b': { input: ['text', 'image'], fetchedAt: 1 } } });
    const p = loadSettings().providers[0];
    expect(createProvider(p).inputModalities).toEqual(['text', 'image']);
    expect(createProvider({ ...p, modelOverrides: { 'gw-b': { input: ['text'] } } }).inputModalities).toEqual(['text']);
  });

  it('拉取到的档位声明抵达 Provider 构造期（网关若披露即生效，未披露不编造）', () => {
    seedSettings({ model: 'gw-a', modelMeta: { 'gw-a': { thinkingEfforts: ['low', 'high'], fetchedAt: 1 } } });
    const p = loadSettings().providers[0];
    // describeModel 合并结果里带档位（请求期 assertEffortDeclared 读它）
    expect(modelDescriptor(p, 'gw-a')?.thinkingEfforts).toEqual(['low', 'high']);
    // 无声明模型：descriptor 无 thinkingEfforts 字段（不编造 → UI 不显示选择器）
    expect(modelDescriptor({ ...p, modelMeta: {} }, 'gw-a')?.thinkingEfforts).toBeUndefined();
  });

  it('遗留 per-provider contextWindow/maxTokens 死字段在 loadSettings 即清洗（P14 已拆）', () => {
    seedSettings({ contextWindow: 1000000, maxTokens: 384000 } as Partial<ProviderSettings>);
    const p = loadSettings().providers[0] as ProviderSettings & { contextWindow?: number; maxTokens?: number };
    expect(p.contextWindow).toBeUndefined();
    expect(p.maxTokens).toBeUndefined();
  });
});
