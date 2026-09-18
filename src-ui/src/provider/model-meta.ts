// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 模型元数据的宽容解析层（provider-model-meta，2026-09-11）。
//
// 背景（彻查结论）：三处 fetchModels 此前各自硬编码「只读 data[].id」，
// 把 contextWindow/maxTokens 一律写成 0、input 一律 ['text']、thinkingEfforts
// 一律留空——理由是「/models 端点只报 id」。该前提对直连厂商（OpenAI/DeepSeek/
// Anthropic 官方）成立，对**聚合网关**不成立：OpenRouter 系端点给
// context_length / architecture.input_modalities / supported_parameters，
// 部分网关给 name + context_length，Ollama /api/show 给 capabilities +
// model_info.*.context_length。这些数据此前在 fetchJsonWithTimeout 的返回值里
// 就在内存中，是在适配器 .map() 那一步被主动丢弃的。
//
// 纪律（P14「不编造」不破）：**认得就填，认不得就留空**。本模块只做字段识别，
// 不做任何推断/启发式补全——没有证据的字段一律 undefined，消费链照旧落回
// 「未知」语义（窗口 0 = 不编造、input 缺省 ['text']、无档位声明不显示选择器）。

import type { ThinkingEffort } from './thinking';
import type { ModelDescriptor, Protocol } from './types';

const CANONICAL_EFFORTS: readonly ThinkingEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 从 API 拉取到的模型元数据（provider 级，随 ProviderSettings.modelMeta 持久化）。
 *  与 ModelOverrides 的分工：本类型 = API 拉取缓存（第二优先层）；ModelOverrides
 *  = 用户手改（最高优先层，目录 stale 或目录外自定义模型的纠正面）。
 *  缺省字段 = 该端点未披露，绝不填入推测值。 */
export interface ModelMeta {
  /** API 给的显示名（如 "Claude Sonnet 5"）；缺省 = 用 id 当名字。 */
  name?: string;
  /** 上下文窗口（token）。 */
  contextWindow?: number;
  /** 最大输出 token。 */
  maxTokens?: number;
  /** 输入模态（含 'image' = 视觉模型）。 */
  input?: ('text' | 'image')[];
  /** 是否支持推理/思考。 */
  reasoning?: boolean;
  /** 声明的思考档位（canonical 词表子集；端点未披露 = 缺省）。 */
  thinkingEfforts?: ThinkingEffort[];
  /** 「关闭」档是否可表达（端点未披露 = 缺省）。 */
  thinkingOff?: boolean;
  /** 本元数据的拉取时刻（epoch ms）——设置页展示来源与新鲜度。 */
  fetchedAt: number;
}

/** 解析上下文——补全端点未披露的字段（kind/vendor/baseUrl 由连接配置决定）。 */
export interface ParseModelContext {
  kind: Protocol;
  vendor: string;
  baseUrl: string;
}

/** /models 响应里的一条原始条目（未知形状——本模块负责从任意方言里认字段）。 */
type RawEntry = Record<string, unknown>;

/** 把 unknown 收窄成对象（非对象/数组/null → undefined）。 */
function asRecord(v: unknown): RawEntry | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as RawEntry) : undefined;
}

/** 读字符串字段（非空且 non-blank 才算命中）。 */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 读正整数字段（0/负数/NaN/Infinity/字符串数字 → undefined；字符串数字接受，
 *  部分端点把 token 数当字符串给）。 */
function posInt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/** 按候选键序取第一个命中的正整数字段（各厂商/网关的字段名不统一）。 */
function firstPosInt(src: RawEntry | undefined, keys: readonly string[]): number | undefined {
  if (!src) return undefined;
  for (const k of keys) {
    const hit = posInt(src[k]);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 字符串数组字段（元素须为非空字符串）。 */
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

/** 嵌套对象取值（`top_provider.context_length`）；中间层缺失/非对象 → undefined。 */
function dig(src: RawEntry | undefined, path: readonly string[]): unknown {
  let cur: unknown = src;
  for (const k of path) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[k];
  }
  return cur;
}

/** Ollama /api/show 形态：model_info 的键带架构前缀（如 "llama.context_length"），
 *  取第一个以 `.context_length` 结尾的正整数项。 */
function archContextLength(modelInfo: unknown): number | undefined {
  const rec = asRecord(modelInfo);
  if (!rec) return undefined;
  for (const [k, v] of Object.entries(rec)) {
    if (!k.endsWith('.context_length')) continue;
    const hit = posInt(v);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 上下文窗口：按方言字段名表逐个认（OpenRouter context_length / LM Studio
 *  max_context_length / Gemini inputTokenLimit / vLLM max_model_len / Ollama
 *  model_info.*.context_length）。 */
function contextWindowOf(r: RawEntry): number | undefined {
  return (
    firstPosInt(r, [
      'context_length',
      'context_window',
      'max_context_length',
      'inputTokenLimit',
      'input_token_limit',
      'max_model_len',
      'max_input_tokens',
    ]) ??
    firstPosInt(asRecord(r.top_provider), ['context_length', 'max_context_length']) ??
    archContextLength(r.model_info)
  );
}

/** 最大输出：OpenRouter top_provider.max_completion_tokens / Gemini
 *  outputTokenLimit / 通用 max_output_tokens。 */
function maxTokensOf(r: RawEntry): number | undefined {
  return (
    firstPosInt(r, ['max_output_tokens', 'outputTokenLimit', 'output_token_limit', 'max_completion_tokens']) ??
    firstPosInt(asRecord(r.top_provider), ['max_completion_tokens'])
  );
}

/** 输入模态：OpenRouter architecture.input_modalities / 平铺 input_modalities /
 *  modalities.input / Ollama capabilities 含 vision|multimodal。
 *  只认显式声明——认不得返回 undefined（调用面落回 ['text'] 不编造）。 */
function inputOf(r: RawEntry): ('text' | 'image')[] | undefined {
  const declared =
    strArray(dig(r, ['architecture', 'input_modalities'])) ??
    strArray(r.input_modalities) ??
    strArray(dig(r, ['modalities', 'input']));
  if (declared) {
    const set = new Set<string>(declared.map((m) => m.toLowerCase()));
    const out: ('text' | 'image')[] = ['text'];
    if (set.has('image') || set.has('vision')) out.push('image');
    return out;
  }
  const caps = strArray(r.capabilities);
  if (caps) {
    const set = new Set(caps.map((c) => c.toLowerCase()));
    return set.has('vision') ? ['text', 'image'] : ['text'];
  }
  return undefined;
}

/** 推理/思考支持：OpenRouter supported_parameters 含 reasoning|include_reasoning /
 *  布尔字段 reasoning|supports_reasoning / Ollama capabilities 含 thinking。 */
function reasoningOf(r: RawEntry): boolean | undefined {
  const params = strArray(r.supported_parameters);
  if (params) {
    const set = new Set(params.map((p) => p.toLowerCase()));
    if (set.has('reasoning') || set.has('include_reasoning') || set.has('reasoning_effort')) return true;
  }
  const caps = strArray(r.capabilities);
  if (caps) {
    const set = new Set(caps.map((c) => c.toLowerCase()));
    if (set.has('thinking') || set.has('reasoning')) return true;
  }
  if (typeof r.reasoning === 'boolean') return r.reasoning;
  if (typeof r.supports_reasoning === 'boolean') return r.supports_reasoning;
  return undefined;
}

/** 思考档位：端点若显式给档位数组（thinking_efforts / reasoning_efforts /
 *  supported_efforts），过滤到 canonical 词表成员后采用；非词表成员**丢弃**
 *  （P14：接受厂商明示的同义词表，但不静默替换语义）。
 *  现实：主流端点目前都不披露此项——缺省 = 不显示档位选择器（不编造）。 */
function thinkingEffortsOf(r: RawEntry): ThinkingEffort[] | undefined {
  const raw = strArray(r.thinking_efforts) ?? strArray(r.reasoning_efforts) ?? strArray(r.supported_efforts);
  if (!raw) return undefined;
  const allowed = new Set<string>(CANONICAL_EFFORTS);
  const out = raw.map((e) => e.toLowerCase()).filter((e): e is ThinkingEffort => allowed.has(e));
  return out.length > 0 ? [...new Set(out)] : undefined;
}

/** 解析 /models 响应里的一条原始条目 → ModelDescriptor（含 provider 级 ModelMeta）。
 *  无 id 的条目返回 null（调用面过滤掉）。kind/vendor/baseUrl 由连接配置补齐；
 *  其余字段**只认证据**，缺省一律用「未知」语义（contextWindow/maxTokens = 0，
 *  input = ['text']，无档位声明）。 */
export function parseModelEntry(
  raw: unknown,
  ctx: ParseModelContext,
): { descriptor: ModelDescriptor; meta: ModelMeta } | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = str(r.id);
  if (!id) return null;

  const displayName = str(r.name) ?? str(r.display_name);
  const contextWindow = contextWindowOf(r);
  const maxTokens = maxTokensOf(r);
  const input = inputOf(r);
  const reasoning = reasoningOf(r);
  const thinkingEfforts = thinkingEffortsOf(r);

  const meta: ModelMeta = {
    ...(displayName && displayName !== id ? { name: displayName } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(thinkingEfforts !== undefined ? { thinkingEfforts } : {}),
    fetchedAt: Date.now(),
  };

  const descriptor: ModelDescriptor = {
    id,
    name: displayName ?? id,
    kind: ctx.kind,
    vendor: ctx.vendor,
    baseUrl: ctx.baseUrl,
    // reasoning 未披露 → 回落 id 启发式（P0 语义按协议分野，见 guessReasoningFromId）
    reasoning: reasoning ?? guessReasoningFromId(id, ctx.kind),
    input: input ?? ['text'],
    contextWindow: contextWindow ?? 0,
    maxTokens: maxTokens ?? 0,
    ...(thinkingEfforts !== undefined ? { thinkingEfforts } : {}),
  };

  return { descriptor, meta };
}

/** id 启发式 reasoning 兜底——**仅在端点未披露 reasoning 时**生效，且是「猜测」
 *  而非证据（因此绝不进 ModelMeta 落盘面）。按协议分野，三条既有语义原样迁入
 *  （行为等价，非新增编造）：
 *   - openai：id 关键词表（P0 定稿，原 openai.guessReasoning）；
 *   - anthropic：Claude 全系 sonnet/opus/haiku 皆推理模型（原 anthropic.fetchModels
 *     的内联关键词判定）；
 *   - responses：该协议端点（Codex 订阅 / 官方 Responses）全为推理模型
 *     （原 responses.fetchModels 的 reasoning: true 写死语义）。 */
export function guessReasoningFromId(id: string, kind: Protocol): boolean {
  if (kind === 'responses') return true;
  if (kind === 'anthropic') return /sonnet|opus|haiku/i.test(id);
  // deepseek：v3/v4 系 + flash 系（2026-09-18 官方改名 deepseek-flash = V4.1 Flash，
  // 思考模式默认开）都算推理模型；其余按关键词表。
  return /think|reason|r1|deepseek-(v[34]|flash)|kimi-k2-thinking/i.test(id);
}

/** 从 /models 响应体里抽出条目数组（data[] 为主，兼容 models[] / 裸数组）。 */
export function modelEntries(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const rec = asRecord(json);
  if (!rec) return [];
  const data = rec.data;
  if (Array.isArray(data)) return data;
  const models = rec.models;
  if (Array.isArray(models)) return models;
  return [];
}

/** meta 是否含任何「有内容」的字段（只有 fetchedAt 的条目不值得落盘）。 */
export function metaHasContent(meta: ModelMeta): boolean {
  return (
    meta.name !== undefined ||
    meta.contextWindow !== undefined ||
    meta.maxTokens !== undefined ||
    meta.input !== undefined ||
    meta.reasoning !== undefined ||
    meta.thinkingEfforts !== undefined
  );
}
