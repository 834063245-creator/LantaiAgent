// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

import { describe, expect, it, vi } from 'vitest';
import { computeBackoffMs, sendWithRetry } from '../src/plugins/builtin/llm-adapters/retry';
import { type ClassifiedProviderError, providerErrorKind } from '../src/provider/error-catalog';

// 微小退避参数——驱动真实重试序列而不拖慢测试（缺省值为生产值，见 computeBackoffMs 用例）。
const fastOpts = { baseDelayMs: 1, jitterMs: 0, rateLimitedMultiplier: 1 };

function cfg(over: Partial<Parameters<typeof sendWithRetry>[0]> = {}) {
  return {
    url: 'https://api.test.com/v1/chat',
    headers: {},
    body: '',
    signal: new AbortController().signal,
    name: 'testprov',
    ...over,
  };
}

async function rejectKind(p: Promise<unknown>): Promise<ClassifiedProviderError> {
  try {
    await p;
  } catch (err) {
    const kind = providerErrorKind(err);
    if (!kind) throw new Error(`expected ClassifiedProviderError, got: ${String(err)}`);
    return err as ClassifiedProviderError;
  }
  throw new Error('expected rejection');
}

describe('sendWithRetry — 按 kind 路由', () => {
  it('成功响应立即返回，单次调用', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await sendWithRetry(cfg(), fastOpts);

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('401 → 不重试直接抛（auth_or_param）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"error":{"message":"invalid api key","type":"invalid_request_error","code":"invalid_api_key"}}', {
        status: 401,
      }),
    );

    const err = await rejectKind(sendWithRetry(cfg(), fastOpts));

    expect(err.kind).toBe('auth_or_param');
    expect(err.message).toContain('[密钥错误]');
    expect(err.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('403 → 不重试直接抛（auth_or_param）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

    const err = await rejectKind(sendWithRetry(cfg(), fastOpts));

    expect(err.kind).toBe('auth_or_param');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('404 → 不重试直接抛（auth_or_param）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const err = await rejectKind(sendWithRetry(cfg(), fastOpts));

    expect(err.kind).toBe('auth_or_param');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('DeepSeek 402 余额不足 → 不重试直接抛，message 含 [余额不足]', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        '{"error":{"message":"Insufficient Balance","type":"unknown_error","code":"insufficient_balance"}}',
        {
          status: 402,
        },
      ),
    );

    const err = await rejectKind(sendWithRetry(cfg(), fastOpts));

    expect(err.kind).toBe('auth_or_param');
    expect(err.message).toContain('[余额不足]');
    expect(err.status).toBe(402);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('400 上下文超长 → 不重试直接抛（context_overflow，供上层触发压缩）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        '{"error":{"message":"This model\'s maximum context length is 65536 tokens. However, your messages resulted in 80000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}',
        { status: 400 },
      ),
    );

    const err = await rejectKind(sendWithRetry(cfg(), fastOpts));

    expect(err.kind).toBe('context_overflow');
    expect(err.code).toBe('context_length_exceeded');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('429 → 重试后成功（rate_limited）', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await sendWithRetry(cfg(), fastOpts);

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('500 → 重试满 3 次后抛（transient）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    const err = await rejectKind(sendWithRetry(cfg(), fastOpts));

    expect(err.kind).toBe('transient');
    expect(err.status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });

  it('408 请求超时 → transient，重试后成功', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Request Timeout', { status: 408 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await sendWithRetry(cfg(), fastOpts);

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('529 Anthropic 过载 → transient，重试后成功', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Overloaded', { status: 529 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await sendWithRetry(cfg(), fastOpts);

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('网络闪断（fetch 抛 Failed to fetch）→ transient，重试后成功', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await sendWithRetry(cfg(), fastOpts);

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('DNS 解析失败（ENOTFOUND）→ auth_or_param，不重试直接抛', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('getaddrinfo ENOTFOUND api.test.com'));

    const err = await rejectKind(sendWithRetry(cfg(), fastOpts));

    expect(err.kind).toBe('auth_or_param');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('中止信号在首次尝试前 → 直接抛 aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sendWithRetry(cfg({ signal: controller.signal }), fastOpts)).rejects.toThrow('aborted');
  });
});

describe('computeBackoffMs — 退避数值', () => {
  const transient = { kind: 'transient' } as ClassifiedProviderError;

  it('transient：指数退避 1s→2s→4s（缺省参数，无抖动）', () => {
    expect(computeBackoffMs(transient, 1, { jitterMs: 0 })).toBe(1000);
    expect(computeBackoffMs(transient, 2, { jitterMs: 0 })).toBe(2000);
    expect(computeBackoffMs(transient, 3, { jitterMs: 0 })).toBe(4000);
  });

  it('rate_limited 无 Retry-After：乘数退避 ×2.5（1s→2.5s→6.25s）', () => {
    const rate = { kind: 'rate_limited' } as ClassifiedProviderError;
    expect(computeBackoffMs(rate, 1, { jitterMs: 0 })).toBe(1000);
    expect(computeBackoffMs(rate, 2, { jitterMs: 0 })).toBe(2500);
    expect(computeBackoffMs(rate, 3, { jitterMs: 0 })).toBe(6250);
  });

  it('rate_limited 有 Retry-After：服务商明示优先（秒→毫秒）', () => {
    const rate = { kind: 'rate_limited', retryAfter: 2 } as ClassifiedProviderError;
    expect(computeBackoffMs(rate, 1)).toBe(2000);
  });

  it('Retry-After 封顶 30s', () => {
    const rate = { kind: 'rate_limited', retryAfter: 120 } as ClassifiedProviderError;
    expect(computeBackoffMs(rate, 1)).toBe(30_000);
  });

  it('自猜退避含抖动（0~jitterMs 内），Retry-After 路径不抖动', () => {
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffMs(transient, 1, { baseDelayMs: 100, jitterMs: 250 });
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(350);
    }
    const rate = { kind: 'rate_limited', retryAfter: 3 } as ClassifiedProviderError;
    expect(computeBackoffMs(rate, 2, { jitterMs: 250 })).toBe(3000);
  });
});
