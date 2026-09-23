// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { backoffDelay, isRetryable, sleepWithAbort } from '../src/agent/retry';
import { classifyProviderError } from '../src/provider/error-catalog';
import { ApiError, apiErrorSummary, classifyError, errorCodeFromBody, retryAfterSeconds } from '../src/provider/types';

describe('isRetryable', () => {
  it('retries rate limit errors', () => {
    expect(isRetryable(new Error('[服务商限流] "test" 请求过于频繁'))).toBe(true);
  });

  it('retries server errors (5xx)', () => {
    expect(isRetryable(new Error('[服务商故障] "test" 服务器异常 (503)'))).toBe(true);
  });

  it('retries overload errors', () => {
    expect(isRetryable(new Error('[服务商繁忙] "test" 当前负载过高'))).toBe(true);
  });

  it('retries connection timeout', () => {
    expect(isRetryable(new Error('[网络问题] 连接 "test" 超时'))).toBe(true);
  });

  it('retries connection reset', () => {
    expect(isRetryable(new Error('[网络问题] ECONNRESET'))).toBe(true);
  });

  it('retries idle-stream timeout', () => {
    expect(
      isRetryable(new Error('[响应超时] 30 秒内未收到服务商任何数据（连接未建立或流式输出中途停止），已中止本次请求')),
    ).toBe(true);
  });

  it('retries unknown errors once', () => {
    expect(isRetryable(new Error('[未知错误] "test" 返回了意外错误 (500)'))).toBe(true);
  });

  it('does NOT retry auth errors', () => {
    expect(isRetryable(new Error('[密钥错误] "test" API Key 无效'))).toBe(false);
  });

  it('does NOT retry permission errors', () => {
    expect(isRetryable(new Error('[权限不足] "test" 拒绝了请求'))).toBe(false);
  });

  it('does NOT retry insufficient quota', () => {
    expect(isRetryable(new Error('[余额不足] "test" 账户余额不足'))).toBe(false);
  });

  it('does NOT retry DNS errors', () => {
    expect(isRetryable(new Error('[网络问题] ENOTFOUND nonexistent.api.com'))).toBe(false);
  });

  it('does NOT retry aborted', () => {
    expect(isRetryable(new Error('[已取消] 请求被手动中止'))).toBe(false);
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    expect(isRetryable(abortErr)).toBe(false);
  });

  it('does NOT retry model not found', () => {
    expect(isRetryable(new Error('[模型不存在] "test" 返回的模型名不在可用列表中'))).toBe(false);
  });

  it('retries raw fetch failures', () => {
    const err = new TypeError('Failed to fetch');
    expect(isRetryable(err)).toBe(true);
  });
});

// ═══ 结构化永久错：显式 4xx 不重试（2026-09-23 真机事故）═══
//
// 事故形态：opencode GO 对模型 id 回 HTTP 400，body 只有
// `{"object":"error","model":"deepseek-v4-flash"}`（无原因）→ 文案落 [未知错误]
// → 旧判据只看文案，每轮白烧 3 次尝试。修法 = 读 provider 层已编织的 kind。

describe('isRetryable — 结构化永久错（显式 4xx）', () => {
  /** 生产管线构造：HTTP 状态 + 响应体 → classifyError 文案 → kind 编织。 */
  const woven = (status: number, body: string) =>
    classifyProviderError(new ApiError(classifyError('opencode', status, body), { status, raw: body }), 'opencode');

  it('does NOT retry explicit 4xx with kind=auth_or_param（模型 id 被网关拒的形态）', () => {
    expect(isRetryable(woven(400, '{"object":"error","model":"deepseek-v4-flash"}'))).toBe(false);
  });

  it('still retries 429（rate_limited 不得被这条规则吞掉）', () => {
    expect(isRetryable(woven(429, 'Too Many Requests'))).toBe(true);
  });

  it('still retries 5xx（transient）', () => {
    expect(isRetryable(woven(503, 'Internal Server Error'))).toBe(true);
  });

  it('keeps the self-heal retry for [未知错误] without an explicit status', () => {
    expect(isRetryable(classifyProviderError(new Error('[未知错误] boom'), 'opencode'))).toBe(true);
  });
});

describe('backoffDelay', () => {
  it('returns increasing delays', () => {
    const d0 = backoffDelay(0);
    const d1 = backoffDelay(1);
    const d2 = backoffDelay(2);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it('caps at max delay', () => {
    const d5 = backoffDelay(5);
    expect(d5).toBeLessThanOrEqual(16000 + 1000); // max + jitter
  });

  it('is at least base delay', () => {
    const d0 = backoffDelay(0);
    expect(d0).toBeGreaterThanOrEqual(1000);
  });
});

describe('sleepWithAbort', () => {
  it('resolves false after delay', async () => {
    const ctrl = new AbortController();
    const aborted = await sleepWithAbort(50, ctrl.signal);
    expect(aborted).toBe(false);
  });

  it('resolves true when aborted during sleep', async () => {
    const ctrl = new AbortController();
    const promise = sleepWithAbort(5000, ctrl.signal);
    // Abort after a short delay
    setTimeout(() => ctrl.abort(), 50);
    const aborted = await promise;
    expect(aborted).toBe(true);
  });

  it('resolves true immediately if already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await sleepWithAbort(5000, ctrl.signal);
    expect(aborted).toBe(true);
  });
});

// ═══ 结构化错误 ApiError（2026-08-31 错误码增强）═══

describe('ApiError', () => {
  it('带 status/code/retryAfter/raw，message 保持分类文案（isRetryable 兼容）', () => {
    const err = new ApiError('[服务商限流] "test" 请求过于频繁，稍后自动重试。', {
      status: 429,
      code: 'rate_limit_exceeded',
      retryAfter: 15,
      raw: '{"error":...}',
    });
    expect(err.message).toContain('[服务商限流]');
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limit_exceeded');
    expect(err.retryAfter).toBe(15);
    expect(err.raw).toBe('{"error":...}');
    expect(err).toBeInstanceOf(Error);
    expect(err.codeSummary()).toBe('HTTP 429 · rate_limit_exceeded');
  });

  it('codeSummary 无码时返回空串', () => {
    const err = new ApiError('[未知错误] plain');
    expect(err.codeSummary()).toBe('');
    const statusOnly = new ApiError('x', { status: 500 });
    expect(statusOnly.codeSummary()).toBe('HTTP 500');
  });
});

describe('retryAfterSeconds', () => {
  it('解析纯秒数', () => {
    expect(retryAfterSeconds('15')).toBe(15);
    expect(retryAfterSeconds(' 120 ')).toBe(120);
  });

  it('解析 HTTP-date', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const sec = retryAfterSeconds(future);
    expect(sec).toBeGreaterThanOrEqual(20);
    expect(sec).toBeLessThanOrEqual(40);
  });

  it('空/垃圾值返回 undefined', () => {
    expect(retryAfterSeconds(undefined)).toBeUndefined();
    expect(retryAfterSeconds('')).toBeUndefined();
    expect(retryAfterSeconds('not-a-date')).toBeUndefined();
  });
});

describe('errorCodeFromBody', () => {
  it('提取 error.code；无则 error.type；再无则 error.error', () => {
    expect(errorCodeFromBody('{"error":{"code":"rate_limit_exceeded","message":"slow down"}}')).toBe(
      'rate_limit_exceeded',
    );
    expect(errorCodeFromBody('{"error":{"type":"invalid_api_key"}}')).toBe('invalid_api_key');
    expect(errorCodeFromBody('{"error":{"error":"overloaded"}}')).toBe('overloaded');
  });

  it('非 JSON/无 error 返回 undefined', () => {
    expect(errorCodeFromBody('not json')).toBeUndefined();
    expect(errorCodeFromBody('{"foo":1}')).toBeUndefined();
    expect(errorCodeFromBody('')).toBeUndefined();
  });
});

describe('apiErrorSummary', () => {
  it('ApiError 返回码摘要；普通 Error 返回空串', () => {
    expect(apiErrorSummary(new ApiError('x', { status: 429, code: 'c' }))).toBe('HTTP 429 · c');
    expect(apiErrorSummary(new Error('[服务商限流] x'))).toBe('');
    expect(apiErrorSummary('plain')).toBe('');
  });
});
