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
  llmError,
  llmFirstByte,
  llmSend,
  proxyFetch,
  retryAfterSeconds,
} from './host';
import { sentCredential } from './shared';

/** 出网日志接缝的描述面（日志可观测性批 2，2026-09-27）。
 *
 *  ⚡ 为什么把「模型/方言」放在这里而不是让 retry 自己去猜：`RetryConfig.body`
 *  是请求体 JSON，**绝不落日志**（可能含消息正文），从它反解模型名等于把请求体
 *  拖进日志路径。让调用方顺手把已知的身份面递下来最诚实。
 *  新增方言填上它，四相日志**自动继承**——这就是计划里「不穷举字段、只覆盖接缝」
 *  的机制本身。缺省 = 只记 provider 名 + host:port，不炸。 */
export interface RetryLogMeta {
  model: string;
  /** 方言名（openai / anthropic / responses）。 */
  kind: string;
  /** 本轮携带的工具 schema 数。 */
  tools?: number;
  /** prompt 侧 token 估算。 */
  promptEstimate?: number;
}

export interface RetryConfig {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  name: string;
  /** 日志接缝的描述面（可选——缺省降级为 provider 名 + host:port）。 */
  meta?: RetryLogMeta;
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
 *  上层可读 kind 语义分流）。
 *
 *  ⚡ 日志接缝（2026-09-27 批 2）：本函数是**出网四相里的三相**（send / first_byte /
 *  error）的唯一落点——方言无关，新方言自动继承。第四相 `done`（流读完）在
 *  `shared.ts` 的 `sseEvents`（那里才知道流什么时候结束）。
 *  ⚠ 只记 `host:port`：整条 URL 交给门面削（`agent/obs.ts` 是唯一脱敏点），
 *  请求头与请求体**一律不进日志**。 */
export async function sendWithRetry(cfg: RetryConfig, opts: RetryOptions = {}): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastErr: ClassifiedProviderError | undefined;
  // 本次请求有没有发凭据（决定 401/403 的文案归属——见 sentCredential 头注）
  const keyless = !sentCredential(cfg.headers);
  // 身份面（四相共用）：provider 名 + 方言 + 模型 + 端点。meta 缺席也不炸。
  const base = {
    provider: cfg.name,
    model: cfg.meta?.model ?? '<未知>',
    kind: cfg.meta?.kind ?? 'unknown',
    url: cfg.url,
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, computeBackoffMs(lastErr, attempt, opts)));
    }
    if (cfg.signal.aborted) throw new Error(`${cfg.name}: aborted`);

    llmSend({
      ...base,
      tools: cfg.meta?.tools,
      promptEstimate: cfg.meta?.promptEstimate,
      attempt: attempt + 1,
    });
    const t0 = Date.now();

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
      // 网络层错误没有 HTTP 状态；raw = 原始错误文本（门面脱敏）
      llmError({ ...base, ms: Date.now() - t0, errorKind: netErr.kind, raw: e.message });
      // 网络层永久错（DNS 解析失败 / Key·URL 含非法字符）与响应路径同路由：不重试
      if (netErr.kind === 'auth_or_param' || netErr.kind === 'context_overflow') throw netErr;
      lastErr = netErr;
      continue;
    }

    // 响应头到达 = 首字节到达（挂起判定的分水岭：有 send 无 first_byte = 服务商零字节）
    if (resp.ok) {
      llmFirstByte({ ...base, ms: Date.now() - t0 });
      return resp;
    }

    const msg = await resp.text().catch(() => '');
    const retryAfter = retryAfterSeconds(resp.headers.get('retry-after'));
    const statusErr = classifyProviderError(
      new ApiError(classifyError(cfg.name, resp.status, msg, undefined, keyless), {
        status: resp.status,
        code: errorCodeFromBody(msg),
        retryAfter,
        raw: msg,
      }),
      cfg.name,
    );
    llmError({
      ...base,
      ms: Date.now() - t0,
      status: resp.status,
      errorKind: statusErr.kind,
      raw: msg || `HTTP ${resp.status}`,
    });
    if (statusErr.kind === 'auth_or_param' || statusErr.kind === 'context_overflow') throw statusErr;
    lastErr = statusErr;
  }

  throw lastErr ?? new Error(`${cfg.name}: retry exhausted with no error`);
}
