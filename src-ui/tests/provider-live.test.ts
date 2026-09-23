// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Live Provider 行为守护（Phase C，2026-08-24 工作区归属根治——配置在使用点
// 解析）。钉住 DSH 形态的核心行为：
//   ① 缺 Key → stream 响亮报 MISSING_CREDENTIAL（不静默回退；会话/Agent 不动）
//   ② 配置在使用点解析：改 settings（baseUrl/model）+ 凭据失效后，**同一个**
//      provider 实例的下一次请求即用新配置（无需换引用/重启——恒 swap 退役
//      的前提）
//   ③ 凭据内存缓存：同 provider 重复解析零额外 IPC；invalidate 后重取
//   ④ 提供方已从设置删除 → LIVE_PROVIDER 报错（不回退其他提供方）

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

import { ToolRegistry } from '../src/agent/tool';
import {
  _resetCredentialCacheForTests,
  invalidateCredentialCache,
  resolveApiKey,
  resolveProviderRuntime,
} from '../src/provider/credentials';
import { createLiveProvider } from '../src/provider/live';
import { resetProxyPort } from '../src/provider/transport';
import { type ChatImageRef, ChunkType, type Request } from '../src/provider/types';
import { type AppSettings, providerId } from '../src/settings';
import { createTestAgent } from './helpers/agent';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

// ── 生产装配复现（平台化 Phase 1 · D2 修订版）：createProvider 经 ctx.llm 解析
// 方言——live 用例需要 builtin adapter 在册（settings 种子行走 kind 'openai'）。──
await ensureProductionChannelsBooted();

// ── settings 种子（loadSettings 直读 localStorage 'hologram_settings'）──

function seedSettings(over: Partial<AppSettings['providers'][number]> = {}, name = 'p1'): void {
  localStorage.setItem(
    'hologram_settings',
    JSON.stringify({
      activeProvider: name,
      providers: [
        {
          kind: 'openai',
          name: providerId(name),
          apiKey: '',
          baseUrl: 'http://a.test/v1',
          model: 'm1',
          ...over,
        },
      ],
      projectPath: '.',
      agent: { temperature: 0.7, contextWindow: 0 },
      display: { language: 'zh', fontScale: 1 },
    }),
  );
}

// ── fetch 桩：记录请求并回放最小 SSE 流 ──

interface FetchCall {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}
const fetchCalls: FetchCall[] = [];

function sseResponse(): Response {
  const enc = new TextEncoder();
  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
  const headers = init?.headers as Record<string, string> | undefined;
  fetchCalls.push({
    url,
    authorization: headers?.Authorization ?? headers?.authorization ?? null,
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  });
  return sseResponse();
});

function minimalRequest(): Request {
  return { messages: [{ role: 'user', content: 'q' }], tools: [], temperature: 0.7, max_tokens: 0 };
}

async function collectText(prov: {
  stream(signal: AbortSignal, req: Request): AsyncGenerator<import('../src/provider/types').Chunk>;
}): Promise<string> {
  let text = '';
  for await (const chunk of prov.stream(new AbortController().signal, minimalRequest())) {
    if (chunk.type === ChunkType.Text && chunk.text) text += chunk.text;
  }
  return text;
}

/** 统计 mockInvoke 收到的 credential_get 次数。 */
function credentialGetCalls(): number {
  return mockInvoke.mock.calls.filter((c) => (c[1] as { method?: string })?.method === 'credential_get').length;
}

beforeEach(() => {
  localStorage.clear();
  fetchCalls.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  _resetCredentialCacheForTests();
  resetProxyPort();
  // llm_proxy_port → null（回退直连 fetch）；credential_get 默认无 key
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((_cmd: string, payload: { method: string }) => {
    if (payload.method === 'credential_get') return Promise.resolve('null');
    return Promise.resolve(null);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider/credentials — 凭据缓存 + 按名解析', () => {
  it('同 provider 重复解析零额外 IPC；invalidate 后重取', async () => {
    seedSettings();
    const pid = providerId('p1');
    expect(await resolveApiKey(pid)).toBe('');
    expect(await resolveApiKey(pid)).toBe('');
    expect(credentialGetCalls()).toBe(1);

    // 写入凭据 + 写穿失效（persistSecrets 语义）
    mockInvoke.mockImplementation((_cmd: string, payload: { method: string }) => {
      if (payload.method === 'credential_get') return Promise.resolve(JSON.stringify('sk-new'));
      return Promise.resolve(null);
    });
    invalidateCredentialCache(pid);
    expect(await resolveApiKey(pid)).toBe('sk-new');
    expect(credentialGetCalls()).toBe(2);
  });

  it('提供方不在设置中 → resolveProviderRuntime 返 null（不回退）', async () => {
    seedSettings();
    const rt = await resolveProviderRuntime(providerId('ghost'));
    expect(rt).toBeNull();
  });

  it('毒化长 key（>4096）拒收，按无 key 处理', async () => {
    seedSettings();
    mockInvoke.mockImplementation((_cmd: string, payload: { method: string }) => {
      if (payload.method === 'credential_get') return Promise.resolve(JSON.stringify('x'.repeat(5000)));
      return Promise.resolve(null);
    });
    expect(await resolveApiKey(providerId('p1'))).toBe('');
  });
});

describe('createLiveProvider — 配置在使用点解析', () => {
  it('缺 Key → stream 响亮报 MISSING_CREDENTIAL（不静默回退）', async () => {
    seedSettings();
    const prov = createLiveProvider('p1');
    await expect(collectText(prov)).rejects.toThrow(/MISSING_CREDENTIAL.*p1/);
    // 未发出任何网络请求
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('有 Key → 透传 baseUrl/model/key（同一实例）', async () => {
    seedSettings();
    mockInvoke.mockImplementation((_cmd: string, payload: { method: string }) => {
      if (payload.method === 'credential_get') return Promise.resolve(JSON.stringify('sk-1'));
      return Promise.resolve(null);
    });
    const prov = createLiveProvider('p1');
    expect(prov.name()).toBe('p1');
    const text = await collectText(prov);
    expect(text).toBe('hi');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://a.test/v1/chat/completions');
    expect(fetchCalls[0].authorization).toBe('Bearer sk-1');
    expect(fetchCalls[0].body.model).toBe('m1');
  });

  it('改 settings + 凭据失效后：同一 provider 实例的下一次请求即用新配置（无需换引用）', async () => {
    seedSettings();
    mockInvoke.mockImplementation((_cmd: string, payload: { method: string }) => {
      if (payload.method === 'credential_get') return Promise.resolve(JSON.stringify('sk-1'));
      return Promise.resolve(null);
    });
    const prov = createLiveProvider('p1');
    await collectText(prov);

    // 用户改 baseUrl/model 并换 Key 保存（persistSecrets 写穿失效语义）
    seedSettings({ baseUrl: 'http://b.test/v1', model: 'm2' });
    mockInvoke.mockImplementation((_cmd: string, payload: { method: string }) => {
      if (payload.method === 'credential_get') return Promise.resolve(JSON.stringify('sk-2'));
      return Promise.resolve(null);
    });
    invalidateCredentialCache(providerId('p1'));

    await collectText(prov); // 同一实例
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1].url).toBe('http://b.test/v1/chat/completions');
    expect(fetchCalls[1].authorization).toBe('Bearer sk-2');
    expect(fetchCalls[1].body.model).toBe('m2');
  });

  it('提供方已从设置删除 → LIVE_PROVIDER 报错', async () => {
    seedSettings();
    mockInvoke.mockImplementation((_cmd: string, payload: { method: string }) => {
      if (payload.method === 'credential_get') return Promise.resolve(JSON.stringify('sk-1'));
      return Promise.resolve(null);
    });
    const prov = createLiveProvider('p1');
    // 删除该提供方（settings 只剩另一家）
    seedSettings({}, 'other');
    await expect(collectText(prov)).rejects.toThrow(/LIVE_PROVIDER.*p1/);
  });

  it('fetchModels 无 Key → 空数组（不报错刷屏）；prewarm 无 Key → 不发请求', async () => {
    seedSettings();
    const prov = createLiveProvider('p1');
    expect(await prov.fetchModels?.()).toEqual([]);
    prov.prewarm?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── 附图能力戳 / 请求期图投影（2026-09-18 真机事故 → 实测定位）──────────
// 事故：用户配了声明视觉的模型（deepseek-v4.1-flash + 覆盖声明 image），贴图 /
// 工具截图仍被判「当前模型不支持图片输入，图已省略」——图到不了模型。
// 根因：能力戳只打在内层实例（createProvider），而 Agent 持的是 live 外壳
// （内层随 stream() 用完即弃）⇒ 壳层 inputModalities 恒 undefined ⇒ 一切模型
// 被判纯文本、附图全被请求期投影静默丢弃。测试盲区：既有用例全在测内层
// createProvider（provider-factory / provider-model-meta）——绿灯常亮，生产恒断。
// 本组钉两端：① 壳层 inputModalities 活读设置（视觉声明可见 + 覆盖优先 + 无需
// 换引用）；② Agent + live 壳真跑：声明视觉 → wire 真带图；**未声明也照发**
// （2026-09-19 语义变更——声明面降级为 UI 提示，发送决策改「先发、被拒再降级」，
// 未声明不再等于图不发）。
describe('createLiveProvider — 附图能力声明（发送面已改为先发策略）', () => {
  const IMG: ChatImageRef = {
    id: 'img-live-1',
    mediaType: 'image/jpeg',
    bytes: 3,
    width: 8,
    height: 8,
    name: '图.jpeg',
  };

  function seedWithKey(): void {
    mockInvoke.mockImplementation((_cmd: string, payload: { method: string }) => {
      if (payload.method === 'credential_get') return Promise.resolve(JSON.stringify('sk-1'));
      return Promise.resolve(null);
    });
  }

  it('壳层 inputModalities 活读设置：声明可见 / 未声明回落 / 会话覆盖优先（同一实例）', () => {
    seedSettings({ model: 'vm1', modelOverrides: { vm1: { input: ['text', 'image'] } } });
    const prov = createLiveProvider('p1');
    expect(prov.inputModalities).toEqual(['text', 'image']);

    // 活读：同一实例，设置改回未声明 → 即刻回落（无需换引用，与 stream 同哲学）
    seedSettings({ model: 'vm1' });
    expect(prov.inputModalities).toEqual(['text']);

    // 会话覆盖模型优先于行值（与 model() 同序）
    seedSettings({ model: 'vm1', modelOverrides: { vm2: { input: ['text', 'image'] } } });
    const overridden = createLiveProvider('p1', {}, { model: 'vm2' });
    expect(overridden.inputModalities).toEqual(['text', 'image']);
  });

  it('Agent + live 壳：声明视觉 → 请求 wire 真带图（reader 读盘 → image_url data URI）', async () => {
    seedSettings({ model: 'vm1', modelOverrides: { vm1: { input: ['text', 'image'] } } });
    seedWithKey();
    const reader = vi.fn(async () => ({ mediaType: 'image/jpeg' as const, data: 'QUJD' }));
    const agent = createTestAgent(createLiveProvider('p1'), new ToolRegistry(), 'sys', {
      eventSink: () => {},
      contextWindow: 0,
      imageReader: reader,
    });

    await agent.run(new AbortController().signal, '看这张图', [IMG]);

    expect(reader).toHaveBeenCalledTimes(1);
    const body = fetchCalls[0]?.body as { messages: Array<{ role: string; content: unknown }> };
    const userMsg = body.messages.find((m) => m.role === 'user');
    const parts = userMsg?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p) => p.type === 'image_url' && p.image_url?.url === 'data:image/jpeg;base64,QUJD')).toBe(true);
  });

  it('Agent + live 壳：未声明视觉 → 仍照发（先发策略：声明面不再作发送闸门）', async () => {
    // ⚡ 2026-09-19 规格变更（原断言「未声明 → 占位降级」随行为退役同批删除）。
    // 旧行为：inputModalities 未声明 image ⇒ 请求期直接投影成占位，图根本不发。
    // 四层声明链末位默认 ['text']，声明缺失 / 过时 / 与实际端点不符时用户贴的图
    // 静默送不出去（模型与用户都无从知晓，B3/B5 一族失效形态）。
    // 现行行为 = 「先发、被拒再降级」：声明只作 UI 提示，发不发由服务商实际反应
    // 决定（真被拒 → 记档 + 去图重发，见 tests/image-reject-fallback.test.ts）。
    seedSettings({ model: 'vm1' });
    seedWithKey();
    const reader = vi.fn(async () => ({ mediaType: 'image/jpeg' as const, data: 'QUJD' }));
    const agent = createTestAgent(createLiveProvider('p1'), new ToolRegistry(), 'sys', {
      eventSink: () => {},
      contextWindow: 0,
      imageReader: reader,
    });

    await agent.run(new AbortController().signal, '看这张图', [IMG]);

    // 未声明也照读盘、照带图——「静默丢图」的窗口就此关闭
    expect(reader).toHaveBeenCalledTimes(1);
    const body = fetchCalls[0]?.body as { messages: Array<{ role: string; content: unknown }> };
    const userMsg = body.messages.find((m) => m.role === 'user');
    const parts = userMsg?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p) => p.type === 'image_url' && p.image_url?.url === 'data:image/jpeg;base64,QUJD')).toBe(true);
  });
});

// 2026-09-23 思考下沉（用户报「思考强度看起来是供应商级全局生效，不是分模型」）：
// 档位解析三层 = 会话覆盖（创作坞 pill）> per-model 覆盖 > 提供方行值（本家默认）。
// 本组从「发出的请求体」钉死——模型与档位必须一一对应。
describe('createLiveProvider — 思考档位三层（per-model 覆盖 ?? 行值；会话覆盖最优先）', () => {
  function seedWithKey(over: Partial<AppSettings['providers'][number]> = {}): void {
    mockInvoke.mockImplementation((_cmd: string, payload: { method: string }) => {
      if (payload.method === 'credential_get') return Promise.resolve(JSON.stringify('sk-1'));
      return Promise.resolve(null);
    });
    seedSettings(over);
  }

  const lastEffort = () => fetchCalls.at(-1)?.body.reasoning_effort;

  it('同一行两个模型各发自己的档位（不再一刀切）', async () => {
    seedWithKey({
      model: 'm1',
      thinking: 'low',
      modelOverrides: { m1: { thinking: 'max' }, m2: { thinking: 'high' } },
    });
    await collectText(createLiveProvider('p1'));
    expect(lastEffort()).toBe('max');
    await collectText(createLiveProvider('p1', undefined, { model: 'm2' }));
    expect(lastEffort()).toBe('high');
  });

  it('未单独设置档位的模型回落行值（本家默认档位）', async () => {
    seedWithKey({ model: 'm1', thinking: 'low', modelOverrides: { m1: { thinking: 'max' } } });
    await collectText(createLiveProvider('p1', undefined, { model: 'm2' }));
    expect(lastEffort()).toBe('low');
  });

  it('会话覆盖压过 per-model；覆盖为 undefined = 回落该模型自己的档位（切模型不冻结行值）', async () => {
    seedWithKey({ model: 'm1', thinking: 'low', modelOverrides: { m1: { thinking: 'max' } } });
    // 本卷显式拨过（会话覆盖）
    await collectText(createLiveProvider('p1', undefined, { model: 'm1', thinking: 'high' }));
    expect(lastEffort()).toBe('high');
    // 创作坞切模型后的形态：覆盖条目在、thinking = undefined（compose-store.setModel）
    // ——必须回落**目标模型**的档位，而不是把行值/上一个模型的档位带过去
    await collectText(createLiveProvider('p1', undefined, { model: 'm1', thinking: undefined }));
    expect(lastEffort()).toBe('max');
  });
});
