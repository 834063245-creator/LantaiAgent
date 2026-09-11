// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// API retry — error classification + exponential backoff
// CC ref: services/api/errors.ts:1163-1182, withRetry.ts

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 16000;
const JITTER_MS = 1000;

/** 流挂起（[响应超时]）专用重试预算 —— 计数预算（MAX_RETRIES）对它不适用。
 *
 *  2026-09-12 实测事故：出网链路瞬断，每个请求都是「HTTP 通了但一个字节都不回」，
 *  30s 空闲守卫逐个掐断；3 次重试约 2 分钟耗尽即放弃。链路是**分钟级**瞬态，
 *  计数预算撑不过去——放弃后应用不再自己重试，用户手点重发又落在同一个故障窗口内，
 *  只能干等恢复（实测该次故障持续十余分钟）。
 *
 *  挂起是链路级瞬态而非配置错误，故改用**时间预算**：窗口内持续重试（每次仍受
 *  SSE 空闲守卫约束），链路恢复即自动继续；超窗才放弃。其它可重试错误
 *  （限流/5xx/繁忙）仍走 MAX_RETRIES 计数预算——它们不该被无限重试。 */
export const STALL_RETRY_BUDGET_MS = 15 * 60_000;

/** 是否为流挂起错误。`[响应超时]` 前缀是分类标记（agent/retry.ts 的 isRetryable
 *  与 provider/error-catalog.ts 的 TRANSIENT_MARKERS 共同消费）——文案可改，
 *  前缀不可改。 */
export function isStallError(err: Error): boolean {
  return (err.message || String(err)).includes('[响应超时]');
}

/** 毫秒 → 人读时长（重试提示用；分钟级窗口下比裸秒数易读）。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

/** 重试预算判定（agent.stream 的唯一预算真源）——调用面先判 isRetryable，
 *  再用本函数判「还允许再试一次吗」。
 *  挂起（[响应超时]）走时间预算，其余可重试错误走计数预算。
 *  @param attempt   已失败的尝试序号（0 起）
 *  @param elapsedMs 本轮自首次尝试起的墙钟耗时 */
export function withinRetryBudget(err: Error, attempt: number, elapsedMs: number): boolean {
  return isStallError(err) ? elapsedMs < STALL_RETRY_BUDGET_MS : attempt < MAX_RETRIES;
}

/** Check if an error is worth retrying. */
export function isRetryable(err: Error): boolean {
  const msg = err.message || String(err);
  // Abort → don't retry
  if (msg.includes('[已取消]') || err.name === 'AbortError' || msg.includes('aborted')) return false;

  // Auth / permissions → don't retry (won't fix itself)
  if (
    msg.includes('[密钥错误]') ||
    msg.includes('[权限不足]') ||
    msg.includes('[余额不足]') ||
    msg.includes('[模型不存在]') ||
    msg.includes('[地址错误]') ||
    msg.includes('[用户输入错误]')
  )
    return false;

  // Rate limit / server errors / overload → retry
  if (msg.includes('[服务商限流]') || msg.includes('[服务商故障]') || msg.includes('[服务商繁忙]')) return true;

  // Network errors — retry timeouts and resets, but not DNS/config errors
  if (msg.includes('[网络问题]')) {
    if (msg.includes('超时') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED')) return true;
    // ENOTFOUND / getaddrinfo = DNS → won't fix itself
    return false;
  }

  // 模型流空闲超时 — 长时间无 chunk 的瞬态挂起，值得重试
  if (msg.includes('[响应超时]')) return true;

  // Unknown errors → retry once (might be transient)
  if (msg.includes('[未知错误]')) return true;

  // Catch-all: raw fetch errors (network flakes)
  if (err.name === 'TypeError' && (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')))
    return true;

  return false;
}

/** Exponential backoff with full jitter: delay = min(base*2^attempt, max) + rand(0, jitter). */
export function backoffDelay(attempt: number): number {
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return exp + Math.floor(Math.random() * JITTER_MS);
}

/** Wait for a delay, but abort if the signal fires first. Returns true if aborted. */
export async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export { MAX_RETRIES };
