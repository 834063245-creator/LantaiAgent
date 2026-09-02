// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 错误分类目录 — 机器可读的四类 kind（2026-09-02 平台补课 Phase 1）。
//
// 分层：types.ts 的 classifyError/classifyStreamError 负责「人读文案」（[分类]
// 前缀 + 操作建议，agent/retry.ts 的 isRetryable 消费此面）；本模块在其之上补
// 「机器可读」的分类面——四类 kind 供重试路由（provider/retry.ts）与上层语义
// 处理（如 context_overflow 触发压缩）消费。结构化字段（status/code/retryAfter/
// raw）以 ApiError 为载体，本目录只做 kind 判定与编织，不改写既有 message。
//
// 判定次序（关键）：context_overflow 必须先于 auth_or_param——Anthropic 的上下文
// 超长以 HTTP 400 + invalid_request_error 形态到达，若按状态码先判永久错误，
// 上下文超长会被吞进 auth_or_param。rate_limited（429）先于 auth_or_param——
// OpenAI 的配额耗尽（insufficient_quota）伴随 429 到达，与厂商限流同语义退避。
//
// 未知错误保守归 auth_or_param（不重试）——与现行 sendWithRetry「只重试已知
// 可重试状态」一致；agent 层 isRetryable 对 [未知错误] 仍保留一次自愈重试。

import { ApiError, classifyStreamError } from './types';

/** Provider 错误的机器可读分类。 */
export type ProviderErrorKind = 'transient' | 'rate_limited' | 'auth_or_param' | 'context_overflow';

/** classifyProviderError 编织后的错误：保留 ApiError 全部结构化字段，附 kind。 */
export type ClassifiedProviderError = ApiError & { kind: ProviderErrorKind };

/** 非 ApiError 输入的包装（普通 Error / 字符串）——message 经 classifyStreamError
 *  分类，原始文本挂 raw；provider 名用于文案与日志。 */
function toApiError(err: unknown, provider: string): ApiError {
  const raw = err instanceof Error ? err.message : String(err);
  return new ApiError(classifyStreamError(provider, raw), { raw });
}

/** 上下文超长特征（判定优先级最高——Anthropic 以 400 invalid_request_error 形态发送）。 */
const CONTEXT_OVERFLOW_MARKERS = [
  'context_length', // OpenAI/DeepSeek code: context_length_exceeded
  'context length', // "This model's maximum context length is ..."
  'prompt is too long', // Anthropic: "prompt is too long: 250000 tokens > 200000 maximum"
  'exceed context limit', // Anthropic: "input length and `max_tokens` exceed context limit"
];

/** 永久错误（鉴权/参数/配置——重试无意义）特征。 */
const AUTH_OR_PARAM_MARKERS = [
  // 人读分类前缀（classifyError/classifyStreamError 的产出面）
  '[密钥错误]',
  '[权限不足]',
  '[余额不足]',
  '[模型不存在]',
  '[地址错误]',
  '[用户输入错误]',
  '[已取消]',
  // 鉴权
  'authentication_error', // Anthropic error.type
  'invalid_api_key', // OpenAI code
  'invalid api key',
  'api-key', // Anthropic "invalid x-api-key"
  'apikey',
  'permission',
  // 参数/配置（context_overflow 已在前面分流）
  'invalid_request_error', // Anthropic/OpenAI 400 信封
  'model_not_found',
  'invalid model',
  'model info',
  // 余额/配额
  'insufficient', // insufficient_quota / insufficient balance / insufficient_balance
  'quota',
  '余额',
  // 网络层永久错（DNS = 地址配置错，重试不自愈；与 agent/retry.ts 语义一致）
  'enotfound',
  'getaddrinfo',
  '无法解析',
  // 用户输入毒化（Key/URL 含非 ASCII）
  'iso-8859-1',
];

/** 瞬时错误（值得重试）特征。 */
const TRANSIENT_MARKERS = [
  // 人读分类前缀
  '[服务商故障]',
  '[服务商繁忙]',
  '[网络问题]',
  '[响应超时]',
  // 服务商侧
  'overloaded', // Anthropic overloaded_error（529 / 流内）
  'server_error',
  'internal server error',
  // 网络闪断/超时
  'econnreset',
  'econnrefused',
  'etimedout',
  'timed out',
  'timeout',
  '超时',
  'failed to fetch',
  'fetch failed',
  'network',
];

/** 永久错误的状态码全集（含 DeepSeek 特有 402 余额不足与 404 地址错）。 */
const AUTH_OR_PARAM_STATUSES = new Set([400, 401, 402, 403, 404]);

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/** 从结构化字段 + 文本素材判定 kind。判定次序见文件头注。 */
function classifyKind(status: number | undefined, code: string | undefined, text: string): ProviderErrorKind {
  // 1) 上下文超长——先于 auth_or_param（Anthropic 以 400 invalid_request_error 发送）
  if (includesAny(text, CONTEXT_OVERFLOW_MARKERS)) return 'context_overflow';

  // 2) 限流——429 状态或限流码（先于 auth_or_param：OpenAI 配额耗尽也伴随 429）
  if (status === 429 || text.includes('rate_limit') || text.includes('rate limit')) return 'rate_limited';

  // 3) 永久（鉴权/参数/配置）
  if (status !== undefined && AUTH_OR_PARAM_STATUSES.has(status)) return 'auth_or_param';
  if (code && AUTH_OR_PARAM_MARKERS.includes(code.toLowerCase())) return 'auth_or_param';
  if (includesAny(text, AUTH_OR_PARAM_MARKERS)) return 'auth_or_param';

  // 4) 瞬时（服务端故障 / 网络闪断 / 超时）
  if (status === 408 || (status !== undefined && status >= 500 && status <= 599) || status === 0) {
    return 'transient';
  }
  if (includesAny(text, TRANSIENT_MARKERS)) return 'transient';

  // 5) 未知——保守不重试（agent 层 isRetryable 对 [未知错误] 保留一次自愈）
  return 'auth_or_param';
}

/**
 * 统一错误编织：任意错误 → 挂 kind 的 ApiError。
 *
 * - ApiError 输入：就地附加 kind 并原样返回（同一实例——上游持有引用即可读
 *   err.kind）；message/code/status/retryAfter/raw 全部保留，不改写。
 * - 非 ApiError 输入（普通 Error / 字符串）：经 classifyStreamError 分类为
 *   人读 message、原文挂 raw，再判 kind。
 * - provider 名仅用于普通错误的文案生成与日志（ApiError 输入的 message 已含
 *   provider 名）。
 */
export function classifyProviderError(err: unknown, provider: string): ClassifiedProviderError {
  const apiErr = err instanceof ApiError ? err : toApiError(err, provider);
  const text = `${apiErr.message}\n${apiErr.raw ?? ''}\n${apiErr.code ?? ''}`.toLowerCase();
  (apiErr as ClassifiedProviderError).kind = classifyKind(apiErr.status, apiErr.code, text);
  return apiErr as ClassifiedProviderError;
}

/** 读取错误上的 kind（未编织过的错误返回 undefined——消费侧安全降级）。 */
export function providerErrorKind(err: unknown): ProviderErrorKind | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const kind = (err as { kind?: unknown }).kind;
  return typeof kind === 'string' ? (kind as ProviderErrorKind) : undefined;
}
