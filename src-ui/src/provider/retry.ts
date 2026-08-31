// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HTTP 请求的共享重试逻辑 — 从 openai.ts 和 anthropic.ts 中提取

import { proxyFetch } from './transport';
import { ApiError, classifyError, errorCodeFromBody, retryAfterSeconds } from './types';

export interface RetryConfig {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  name: string;
}

export function isRetryableStatus(s: number): boolean {
  return s === 408 || s === 429 || (s >= 500 && s <= 599);
}

/** POST 最多 3 次尝试，指数退避；服务商明示 retry-after 时优先于自猜退避。
 *  抛出分类后的 ApiError（挂 status/code/retryAfter/raw——墓碑可显示原始码）。 */
export async function sendWithRetry(cfg: RetryConfig): Promise<Response> {
  const maxAttempts = 3;
  let lastErr: ApiError | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // 服务商给了 retry-after 就听它的（封顶 30s——让用户干等 60s+ 不现实）；
      // 没给才按指数退避猜（500ms 起步，翻倍 + 抖动）。
      const hinted = lastErr?.retryAfter !== undefined ? Math.min(lastErr.retryAfter * 1000, 30_000) : undefined;
      const delay = hinted ?? 500 * 2 ** (attempt - 1) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
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
      lastErr = new ApiError(classifyError(cfg.name, 0, '', e.message), { status: 0, raw: e.message });
      continue;
    }

    if (resp.ok) return resp;

    const msg = await resp.text().catch(() => '');
    const retryAfter = retryAfterSeconds(resp.headers.get('retry-after'));
    if (resp.status === 401 || resp.status === 403) {
      throw new ApiError(classifyError(cfg.name, resp.status, msg), {
        status: resp.status,
        code: errorCodeFromBody(msg),
        raw: msg,
      });
    }
    const statusErr = new ApiError(classifyError(cfg.name, resp.status, msg), {
      status: resp.status,
      code: errorCodeFromBody(msg),
      retryAfter,
      raw: msg,
    });
    if (!isRetryableStatus(resp.status)) throw statusErr;
    lastErr = statusErr;
  }

  throw lastErr ?? new Error(`${cfg.name}: retry exhausted with no error`);
}
