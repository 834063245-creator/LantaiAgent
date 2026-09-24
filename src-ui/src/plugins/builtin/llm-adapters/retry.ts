// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HTTP 请求的共享重试逻辑 — 从 openai.ts 和 anthropic.ts 中提取。
// 重试按 error-catalog 的 kind 路由（2026-09-02 平台补课 Phase 1）：
//   - transient：指数退避 1s→2s→4s + 抖动，默认 3 次尝试
//   - rate_limited：服务商明示 retry-after 优先（封顶 30s——让用户干等 60s+
//     不现实），否则乘数退避（×2.5：1s→2.5s→6.25s）
//   - auth_or_param / context_overflow：不重试直接抛（密钥/参数错重试无
//     意义；上下文超长交给上层触发压缩）
// 抛出的错误一律经 classifyProviderError 编织（挂 kind——上层可读 err.kind）。

import {
  ApiError,
  type ClassifiedProviderError,
  classifyError,
  classifyProviderError,
  errorCodeFromBody,
  proxyFetch,
  retryAfterSeconds,
} from './host';

export interface RetryConfig {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  name: string;
}

/** 重试策略参数（可选覆盖；缺省值即生产行为）。测试用微小值驱动真实重试序列。 */
export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 3。 */
  maxAttempts?: number;
  /** transient 指数退避基值（毫秒）：第 1/2/3 次重试 → base×1/×2/×4。 */
  baseDelayMs?: number;
  /** rate_limited 无 Retry-After 时的退避乘数。 */
  rateLimitedMultiplier?: number;
  /** 自猜退避的抖动上限（毫秒）；Retry-After 明示路径不抖动。 */
  jitterMs?: number;
}

/** Retry-After 明示退避的封顶（毫秒）。 */
export const RETRY_AFTER_CAP_MS = 30_000;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_RATE_LIMITED_MULTIPLIER = 2.5;
const DEFAULT_JITTER_MS = 250;

/** 按错误 kind 计算第 attempt 次（1 起）重试前的等待毫秒。
 *  rate_limited 且服务商明示 retry-after → 采纳（封顶）；其余自猜路径加抖动。 */
export function computeBackoffMs(
  err: ClassifiedProviderError | undefined,
  attempt: number,
  opts: RetryOptions = {},
): number {
  const base = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitter = opts.jitterMs ?? DEFAULT_JITTER_MS;
  const exp = attempt - 1;
  if (err?.kind === 'rate_limited') {
    if (err.retryAfter !== undefined) return Math.min(err.retryAfter * 1000, RETRY_AFTER_CAP_MS);
    const mult = opts.rateLimitedMultiplier ?? DEFAULT_RATE_LIMITED_MULTIPLIER;
    return Math.min(base * mult ** exp, RETRY_AFTER_CAP_MS) + Math.random() * jitter;
  }
  return Math.min(base * 2 ** exp, RETRY_AFTER_CAP_MS) + Math.random() * jitter;
}

/** POST 按分类重试，指数退避；服务商明示 retry-after 时优先于自猜退避。
 *  抛出分类后的 ApiError（挂 status/code/retryAfter/raw/kind——墓碑可显示原始码，
 *  上层可读 kind 语义分流）。 */
export async function sendWithRetry(cfg: RetryConfig, opts: RetryOptions = {}): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastErr: ClassifiedProviderError | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, computeBackoffMs(lastErr, attempt, opts)));
    }
    if (cfg.signal.aborted) throw new Error(`${cfg.name}: aborted`);

    let resp: Response;
    try {
      resp = await proxyFetch(cfg.url, {
        method: 'POST',
        headers: cfg.headers,
        body: cfg.body,
        signal: cfg.signal,
      });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e.name === 'AbortError') throw new Error(`${cfg.name}: aborted`);
      const netErr = classifyProviderError(
        new ApiError(classifyError(cfg.name, 0, '', e.message), { status: 0, raw: e.message }),
        cfg.name,
      );
      // 网络层永久错（DNS 解析失败 / Key·URL 含非法字符）与响应路径同路由：不重试
      if (netErr.kind === 'auth_or_param' || netErr.kind === 'context_overflow') throw netErr;
      lastErr = netErr;
      continue;
    }

    if (resp.ok) return resp;

    const msg = await resp.text().catch(() => '');
    const retryAfter = retryAfterSeconds(resp.headers.get('retry-after'));
    const statusErr = classifyProviderError(
      new ApiError(classifyError(cfg.name, resp.status, msg), {
        status: resp.status,
        code: errorCodeFromBody(msg),
        retryAfter,
        raw: msg,
      }),
      cfg.name,
    );
    if (statusErr.kind === 'auth_or_param' || statusErr.kind === 'context_overflow') throw statusErr;
    lastErr = statusErr;
  }

  throw lastErr ?? new Error(`${cfg.name}: retry exhausted with no error`);
}
