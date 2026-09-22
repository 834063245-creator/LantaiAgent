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

/** 载荷可疑时的挂起计数预算（2026-09-22 读图挂起事故）。
 *
 *  事故形态：一张 6.4MB 工具附图 → 请求体 ~9MB → 服务商 **30 秒零字节** ×2 →
 *  按时间预算本会盲等 15 分钟（用户全程只见转圈）。
 *  判据哲学：挂起走时间预算是为「出网链路瞬断」设计的——那种故障与载荷无关，
 *  重发同一个请求是有意义的等待。而**载荷刚长大的挂起**不是链路瞬态：重发 28 次
 *  会把同一份大载荷重新上传 28 次，链路再好也不会变好。故这类挂起回到计数预算，
 *  快速失败并把载荷事实写进墓碑，让用户看见真因（而不是 15 分钟后的泛泛超时）。
 *  **语义 = 总尝试次数**（含第一次）。 */
export const SUSPECT_PAYLOAD_MAX_ATTEMPTS = 2;

/** 「载荷可疑」的 wire 附图体量门槛（base64 字符数）——约 1MiB 源字节。
 *  低于此值仍按链路瞬态等待（几百 KB 的图挂起，多半真是链路问题，值得等链路恢复）；
 *  高于此值才认「载荷不像是链路能解释的失败」。 */
export const SUSPECT_PAYLOAD_MIN_WIRE_CHARS = 1_400_000;

/** 「服务商零字节」通知的稳定前缀（判据标记——UI 据此把挂起留痕落进卷面；
 *  文案可改，前缀不可改，与 `[响应超时]` 同纪律）。 */
export const STALL_NOTICE_MARK = '[服务商无响应]';

/** 中止语义结构化（2026-09-14）——判据是「谁的 signal 被中止」这一**事实**，
 *  不是错误文本。旧实现用 `msg.includes('aborted')` 猜「用户按了停止」，于是
 *  传输出自己断的错误（`BodyStreamBuffer was aborted`、`<provider>: aborted`）
 *  被当成用户意图：不重试、不落墓碑、静默吞掉——案卷里留下悬空来文（用户看见
 *  「模型不响应」）。任何含该子串的上游错误（"request aborted by upstream"）
 *  同款误判，属宪法四「错误不静默」违规。 */
export function isAbortFlavoured(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /abort/i.test(err.message);
}

/** 非用户中止的传输切断标记（agent.streamOnce 在 signal 未中止时织入）。
 *  与 [响应超时] 同族但不共用预算：切断多是一次性的（真断链会在下一次请求
 *  以 [响应超时] 形态出现并接管时间预算），故走计数预算，不做无限重试。 */
export const INTERRUPTED_MARKER = '[传输中断]';

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
 *  挂起（[响应超时]）走时间预算，其余可重试错误走计数预算；**载荷可疑的挂起**
 *  （本轮请求刚带上 MB 级附图）回到计数预算，见 SUSPECT_PAYLOAD_MAX_ATTEMPTS。
 *  @param attempt   已失败的尝试序号（0 起）
 *  @param elapsedMs 本轮自首次尝试起的墙钟耗时
 *  @param opts.suspectPayload 本轮载荷含大体量附图（挂起时不再按链路瞬态盲等） */
export function withinRetryBudget(
  err: Error,
  attempt: number,
  elapsedMs: number,
  opts?: { suspectPayload?: boolean },
): boolean {
  if (opts?.suspectPayload) return attempt + 1 < SUSPECT_PAYLOAD_MAX_ATTEMPTS;
  return isStallError(err) ? elapsedMs < STALL_RETRY_BUDGET_MS : attempt < MAX_RETRIES;
}

/** Check if an error is worth retrying. */
export function isRetryable(err: Error): boolean {
  const msg = err.message || String(err);
  // 中止 → 不重试。判据：DOMException AbortError（真被 abort 的 fetch）与
  // `[已取消]` 分类标记（types.classifyError 的产出面）。
  // ⚠️ 2026-09-14 拆除 `msg.includes('aborted')`：那是文本猜测，会把传输自己
  // 断掉的失败（BodyStreamBuffer was aborted）当成用户取消。用户中止一律由
  // `signal.aborted` 这一事实判定（agent.streamOnce / chat-core 的 catch），
  // 不靠消息文本。
  if (err.name === 'AbortError' || msg.includes('[已取消]')) return false;

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

  // 网络错误 — 重试超时与重置，但不重试 DNS/配置错误
  if (msg.includes('[网络问题]')) {
    if (msg.includes('超时') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED')) return true;
    // ENOTFOUND / getaddrinfo = DNS → won't fix itself
    return false;
  }

  // 传输被切断（非用户中止）——链路级瞬态，值得重试（计数预算）
  if (msg.includes(INTERRUPTED_MARKER)) return true;

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
