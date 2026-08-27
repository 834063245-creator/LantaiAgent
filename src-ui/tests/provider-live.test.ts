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

import {
  _resetCredentialCacheForTests,
  invalidateCredentialCache,
  resolveApiKey,
  resolveProviderRuntime,
} from '../src/provider/credentials';
import { createLiveProvider } from '../src/provider/live';
import { resetProxyPort } from '../src/provider/transport';
import { ChunkType, type Request } from '../src/provider/types';
import { type AppSettings, providerId } from '../src/settings';
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
