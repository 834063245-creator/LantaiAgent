// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 错误分类目录守护（Phase 1 平台补课）：每类 kind 至少一条厂商真实错误码
// fixture（表驱动），外加编织语义（字段保留/同实例附加）与两协议流内错误的
// 接线验证（openai.ts / anthropic.ts 的 SSE error 事件 → chunk.err.kind）。

import { describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../src/provider/anthropic';
import { classifyProviderError, type ProviderErrorKind } from '../src/provider/error-catalog';
import { createOpenAIProvider } from '../src/provider/openai';
import {
  ApiError,
  type Chunk,
  ChunkType,
  classifyError,
  classifyStreamError,
  errorCodeFromBody,
} from '../src/provider/types';

/** 生产管线构造：HTTP 错误响应 → ApiError（classifyError 文案 + 结构化 meta）。 */
function httpErr(provider: string, status: number, body: string): ApiError {
  return new ApiError(classifyError(provider, status, body), {
    status,
    code: errorCodeFromBody(body),
    raw: body,
  });
}

/** 生产管线构造：SSE 流内错误（无 HTTP status，code = error.type / error.code）。 */
function streamErr(provider: string, message: string, code?: string): ApiError {
  return new ApiError(classifyStreamError(provider, message), { code, raw: message });
}

const KIND_FIXTURES: Array<{
  name: string;
  provider: string;
  build: (provider: string) => ApiError;
  expectKind: ProviderErrorKind;
}> = [
  // ── rate_limited ──
  {
    name: 'Anthropic 429 rate_limit_error',
    provider: 'anthropic',
    expectKind: 'rate_limited',
    build: (p) =>
      httpErr(
        p,
        429,
        '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit (input tokens: 15690; limit: 15000 tokens per min)"}}',
      ),
  },
  {
    name: 'OpenAI 429 rate_limit_exceeded',
    provider: 'openai',
    expectKind: 'rate_limited',
    build: (p) =>
      httpErr(
        p,
        429,
        '{"error":{"message":"Rate limit reached for requests","type":"requests","code":"rate_limit_exceeded"}}',
      ),
  },
  // ── auth_or_param ──
  {
    name: 'Anthropic 401 authentication_error（invalid x-api-key）',
    provider: 'anthropic',
    expectKind: 'auth_or_param',
    build: (p) =>
      httpErr(p, 401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
  },
  {
    name: 'OpenAI 401 invalid_api_key',
    provider: 'openai',
    expectKind: 'auth_or_param',
    build: (p) =>
      httpErr(
        p,
        401,
        '{"error":{"message":"Incorrect API key provided: sk-test. You can find your API key at https://platform.openai.com/.","type":"invalid_request_error","code":"invalid_api_key"}}',
      ),
  },
  {
    name: 'DeepSeek 402 insufficient balance',
    provider: 'deepseek',
    expectKind: 'auth_or_param',
    build: (p) =>
      httpErr(
        p,
        402,
        '{"error":{"message":"Insufficient Balance","type":"unknown_error","code":"insufficient_balance"}}',
      ),
  },
  {
    name: 'OpenAI 400 invalid_request_error（参数错）',
    provider: 'openai',
    expectKind: 'auth_or_param',
    build: (p) =>
      httpErr(p, 400, '{"error":{"message":"Invalid value for max_tokens","type":"invalid_request_error"}}'),
  },
  {
    name: 'DNS 解析失败（ENOTFOUND，网络层永久错）',
    provider: 'anthropic',
    expectKind: 'auth_or_param',
    build: (p) =>
      new ApiError(classifyError(p, 0, '', 'getaddrinfo ENOTFOUND api.anthropic.com'), {
        status: 0,
        raw: 'getaddrinfo ENOTFOUND api.anthropic.com',
      }),
  },
  // ── context_overflow ──
  {
    name: 'Anthropic 400 prompt is too long（invalid_request_error 信封，必须先分流）',
    provider: 'anthropic',
    expectKind: 'context_overflow',
    build: (p) =>
      httpErr(
        p,
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
      ),
  },
  {
    name: 'Anthropic 400 input length and max_tokens exceed context limit',
    provider: 'anthropic',
    expectKind: 'context_overflow',
    build: (p) =>
      httpErr(
        p,
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 250000 + 10000 > 200000"}}',
      ),
  },
  {
    name: 'OpenAI 400 context_length_exceeded',
    provider: 'openai',
    expectKind: 'context_overflow',
    build: (p) =>
      httpErr(
        p,
        400,
        '{"error":{"message":"This model\'s maximum context length is 4097 tokens. However, you requested 8192 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}',
      ),
  },
  {
    name: 'DeepSeek 400 maximum context length',
    provider: 'deepseek',
    expectKind: 'context_overflow',
    build: (p) =>
      httpErr(
        p,
        400,
        '{"error":{"message":"This model\'s maximum context length is 65536 tokens. However, you messages resulted in 80000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}',
      ),
  },
  // ── transient ──
  {
    name: 'Anthropic 529 overloaded_error',
    provider: 'anthropic',
    expectKind: 'transient',
    build: (p) => httpErr(p, 529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
  },
  {
    name: 'Anthropic 流内 overloaded_error（SSE，无 status）',
    provider: 'anthropic',
    expectKind: 'transient',
    build: (p) => streamErr(p, 'Overloaded', 'overloaded_error'),
  },
  {
    name: 'OpenAI 500 server_error',
    provider: 'openai',
    expectKind: 'transient',
    build: (p) =>
      httpErr(
        p,
        500,
        '{"error":{"message":"The server had an error while processing your request.","type":"server_error","code":null}}',
      ),
  },
  {
    name: '408 请求超时',
    provider: 'openai',
    expectKind: 'transient',
    build: (p) => httpErr(p, 408, 'Request Timeout'),
  },
  {
    name: '网络闪断（ECONNRESET，status 0）',
    provider: 'deepseek',
    expectKind: 'transient',
    build: (p) => new ApiError(classifyError(p, 0, '', 'read ECONNRESET'), { status: 0, raw: 'read ECONNRESET' }),
  },
  // ── 未知保守 ──
  {
    name: '未知状态码 418 → 保守不重试（auth_or_param）',
    provider: 'openai',
    expectKind: 'auth_or_param',
    build: (p) => httpErr(p, 418, "I'm a teapot"),
  },
];

describe('classifyProviderError — 厂商真实错误码分类（表驱动）', () => {
  for (const f of KIND_FIXTURES) {
    it(`${f.name} → ${f.expectKind}`, () => {
      const err = classifyProviderError(f.build(f.provider), f.provider);
      expect(err.kind).toBe(f.expectKind);
    });
  }
});

describe('classifyProviderError — 编织语义', () => {
  it('保留原始 message/code/status/raw，同实例附加 kind', () => {
    const original = httpErr(
      'anthropic',
      429,
      '{"type":"error","error":{"type":"rate_limit_error","message":"rate limit"}}',
    );
    const messageBefore = original.message;
    const err = classifyProviderError(original, 'anthropic');

    expect(err).toBe(original); // 同实例（上游持有引用即可读 kind）
    expect(err.message).toBe(messageBefore);
    expect(err.code).toBe('rate_limit_error');
    expect(err.status).toBe(429);
    expect(err.raw).toContain('rate_limit_error');
    expect(err.kind).toBe('rate_limited');
  });

  it('非 ApiError 输入（普通 Error）→ 包装分类，原文挂 raw', () => {
    const err = classifyProviderError(new Error('boom'), 'openai');

    expect(err).toBeInstanceOf(ApiError);
    expect(err.raw).toBe('boom');
    expect(typeof err.kind).toBe('string');
  });

  it('retryAfter 字段保留（退避消费）', () => {
    const original = new ApiError(classifyError('openai', 429, 'rate limit'), {
      status: 429,
      retryAfter: 7,
      raw: '',
    });
    const err = classifyProviderError(original, 'openai');

    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfter).toBe(7);
  });
});

// ── 接线验证：两协议流内 error 事件经编织后 chunk.err 带 kind ──

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(lines.join('')));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function minimalRequest() {
  return { messages: [{ role: 'user', content: 'q' }], tools: [], temperature: 0.7, max_tokens: 0 };
}

async function collectErrorChunk(prov: {
  stream(signal: AbortSignal, req: ReturnType<typeof minimalRequest>): AsyncGenerator<Chunk>;
}): Promise<Chunk | undefined> {
  const chunks: Chunk[] = [];
  for await (const ch of prov.stream(new AbortController().signal, minimalRequest())) {
    chunks.push(ch);
    if (ch.type === ChunkType.Error) return ch;
  }
  return chunks.find((c) => c.type === ChunkType.Error);
}

describe('流内错误接线 — openai.ts / anthropic.ts', () => {
  it('openai：SSE error 事件（context_length_exceeded）→ chunk.err.kind = context_overflow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          `data: ${JSON.stringify({
            error: {
              message: "This model's maximum context length is 65536 tokens.",
              code: 'context_length_exceeded',
              type: 'invalid_request_error',
            },
          })}\n\n`,
        ]),
      ),
    );

    const prov = createOpenAIProvider({ apiKey: 'sk-test', baseUrl: 'http://x.test/v1', model: 'm-test' });
    const chunk = await collectErrorChunk(prov);

    expect(chunk?.err).toBeInstanceOf(ApiError);
    expect(chunk?.err).toMatchObject({ kind: 'context_overflow', code: 'context_length_exceeded' });
    vi.unstubAllGlobals();
  });

  it('anthropic：SSE error 事件（rate_limit_error）→ chunk.err.kind = rate_limited', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          `data: ${JSON.stringify({
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: 'Number of request tokens has exceeded your per-minute rate limit',
            },
          })}\n\n`,
        ]),
      ),
    );

    const prov = createAnthropicProvider({ apiKey: 'sk-test', baseUrl: 'http://y.test', model: 'claude-test' });
    const chunk = await collectErrorChunk(prov);

    expect(chunk?.err).toBeInstanceOf(ApiError);
    expect(chunk?.err).toMatchObject({ kind: 'rate_limited', code: 'rate_limit_error' });
    vi.unstubAllGlobals();
  });

  it('anthropic：SSE overloaded_error（无 status）→ chunk.err.kind = transient', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          `data: ${JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
          })}\n\n`,
        ]),
      ),
    );

    const prov = createAnthropicProvider({ apiKey: 'sk-test', baseUrl: 'http://y.test', model: 'claude-test' });
    const chunk = await collectErrorChunk(prov);

    expect(chunk?.err).toMatchObject({ kind: 'transient', code: 'overloaded_error' });
    vi.unstubAllGlobals();
  });
});
