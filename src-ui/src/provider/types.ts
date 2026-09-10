// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 抽象层 — 统一 Message / Chunk / ToolCall，抹平 Anthropic 和 OpenAI 的 API 差异

import type { ModelMeta } from './model-meta';
import type { StoredThinking, ThinkingEffort } from './thinking';

/** 模型 API 的线上方言（CONTEXT.md「Protocol」）。
 *  注意：ProviderSettings/ModelDescriptor 上的持久化字段名仍叫 `kind`（存储遗留名），
 *  领域词与代码类型统一为 Protocol，改存储键名需带迁移。
 *
 *  ⚡ provider-refactor（方案乙）Phase 1A：Protocol 由闭合 union 开放为 string——
 *  内核协议经 CORE_PROTOCOLS 常量列明，方言注册表（ctx.llm adapter）是运行期真源；
 *  展示/回落链对未知 kind 用字符串回落（查不到标签就显示 kind 本身），不再闭合。 */
export type Protocol = string;

/** 内核协议（出厂即注册的两条方言）。协议下拉/回落链的内核白名单。 */
export const CORE_PROTOCOLS = ['anthropic', 'openai'] as const;
export type CoreProtocol = (typeof CORE_PROTOCOLS)[number];

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 附图媒体类型白名单（multimodal-image-plan D-4——magic-byte 校验后成立）。 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** 附图引用——消息内图片的唯一形态（multimodal-image-plan D-1：字节永不进卷，
 *  消息只带引用；字节落 {ws}/.lantai/attachments/{id}.{ext} 内容寻址文件）。
 *  id = 规整后字节 sha256（十六进制）——同图跨卷天然去重复用。 */
export interface ChatImageRef {
  /** 内容寻址 id（sha256 hex）——同时是磁盘文件名主干。 */
  id: string;
  mediaType: ImageMediaType;
  /** 规整后编码字节长度。 */
  bytes: number;
  /** 规整后宽（px）。 */
  width: number;
  /** 规整后高（px）。 */
  height: number;
  /** 显示名（已剥路径分隔符）。 */
  name?: string;
  /** 规整缩放发生时的原始尺寸（缩放未发生则缺省）。 */
  originalDimensions?: { width: number; height: number };
}

export interface Message {
  role: Role;
  content: string;
  /** 用户消息附图引用（multimodal-image-plan D-1；仅 user 角色携带）。
   *  content 保持 string——纯文本 wire 纪律（D-6）：无图消息形态字节不变；
   *  有图消息在适配器层才展开 content parts（openai）/ image blocks
   *  （anthropic）/ input_image（responses）。 */
  images?: ChatImageRef[];
  /** thinking 模式的思维链，多轮对话中原样往返 */
  reasoning_content?: string;
  /** provider 签发的推理证明（Anthropic thinking signature） */
  reasoning_signature?: string;
  /** 由 assistant 设置 */
  tool_calls?: ToolCall[];
  /** 将工具结果关联到其调用 */
  tool_call_id?: string;
  /** tool 消息：工具名称 */
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // 原始 JSON
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface Request {
  messages: Message[];
  tools: ToolSchema[];
  temperature: number;
  max_tokens: number;
  /** 附图请求期解析产物（multimodal-image-plan B3 · D-5）：ChatImageRef.id →
   *  规整字节 base64。适配器按消息内 images 引用 join 出 wire 格式；缺省 =
   *  无图载荷（纯文本 wire 形态字节不变——D-6）。 */
  imageData?: Record<string, { mediaType: ImageMediaType; data: string }>;
}

export enum ChunkType {
  Text = 0,
  Reasoning = 1,
  ToolCallStart = 2,
  ToolCall = 3,
  Usage = 4,
  Done = 5,
  Error = 6,
  /** 部分工具参数预览 — 在 input_json_delta 期间为 write/edit 工具发出 */
  ToolArgPreview = 7,
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  /** 写缓存(缓存创建)的输入 token 数。
   *  Anthropic 通过 cache_creation_input_tokens 单独报告(单价较高);
   *  OpenAI 兼容(DeepSeek 等)通常没有该拆解,置 0。 */
  cache_creation_tokens: number;
  reasoning_tokens: number;
  finish_reason: string; // "stop", "tool_calls", "length", "content_filter"
}

export interface Chunk {
  type: ChunkType;
  text?: string;
  signature?: string; // ChunkReasoning：Anthropic thinking signature
  tool_call?: ToolCall; // ChunkToolCallStart（仅 id+name）或 ChunkToolCall（完整）
  /** 部分工具参数预览（write_file 内容、edit_file diff 等） */
  tool_arg_preview?: { tool_id: string; tool_name: string; content: string };
  usage?: Usage;
  err?: Error;
}

/** Provider 是具备聊天能力的模型后端。 */
export interface Provider {
  name(): string;
  /** 启动流式补全，yield chunks。取消 signal 会中止。 */
  stream(signal: AbortSignal, req: Request): AsyncGenerator<Chunk>;
  /** 输入模态能力戳（multimodal-image-plan B3 · D-8③）：工厂从模型目录
   *  （ModelDescriptor.input，含 ModelOverrides 合并）盖在实例上——Agent
   *  请求期据此决定附图走 wire 还是投影成文本占位。缺省 = ['text']。 */
  inputModalities?: readonly ('text' | 'image')[];
  /** 运行时更新思考策略（ModelSwitcher 切思考档位），不重建 Provider。
   *  可选 — 旧实现没有此方法时静默跳过。 */
  setThinking?(cfg: StoredThinking | undefined): void;
  /** 预热 HTTP 连接池。创建后调用一次以在首次真实请求前建立
   *  TCP+TLS 连接。尽力而为 — 失败静默处理。 */
  prewarm?(): void;
  /** 从 provider 的 /models API 端点获取可用模型。
   *  返回 ModelDescriptor[]，字段由方言的宽容解析层
   *  （model-meta.parseModelEntry）填充：端点披露什么就填什么，未披露的保持
   *  「未知」语义（contextWindow/maxTokens = 0、input = ['text']、无档位声明）
   *  ——不编造（P14）。元数据随 fetchModels 顺带解析，落盘面经 lastModelMeta 取。
   *  尽力而为：传输失败（网络/超时/端点 4xx）上抛——调用面据此记失败面
   *  （C5 2026-08-27：此前静默返回 [] 被当成「无模型」，用户完全无感）；
   *  成功但端点无 data = 返回空数组。 */
  fetchModels?(): Promise<ModelDescriptor[]>;
  /** 最近一次 fetchModels 解析出的 **provider 级元数据**（键 = 模型 id）。
   *  落盘面 ProviderSettings.modelMeta 的唯一真源——表中只含端点真披露的字段，
   *  descriptor 上的启发式兜底（reasoning 猜测等）不在表内（不编造的类型边界）。
   *  调用序：先 await fetchModels()，随后同步读本方法（取的是同一次拉取的产物）。 */
  lastModelMeta?(): Record<string, ModelMeta>;
}

/** 方言工厂实参——createProvider 从 settings 解析后的运行期产物（2026-08-27 方言收口）。
 *  thinking 已过 withThinkingDisabled / 会话覆盖合并；maxTokensFor 即 P14 覆盖闭包。
 *  oauthHeaders（2026-09 Phase 3D）：authMode='oauth' 时 live provider 从系统
 *  grant 解析出的请求注入头（Authorization: Bearer + chatgpt-account-id 等，
 *  由 credentials.resolveOauthToken + provider/oauth 面构建）；缺省 undefined =
 *  apiKey 路径。仅 Responses 等订阅协议方言消费。 */
export interface ProviderRuntimeArgs {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking: StoredThinking | undefined;
  maxTokensFor: (model: string) => number | undefined;
  /** 某模型在**该提供方作用域**下的生效描述符（provider 级拉取元数据 + 用户覆盖
   *  + 静态目录 seed 的合并产物，见 settings.modelDescriptor）。方言请求期读它
   *  （thinkingCapability / max_tokens 钳制），使 provider 级元数据真正抵达 wire
   *  ——此前一律读全局 getModel，聚合网关的模型（静态目录无条目）永远拿不到
   *  自己的窗口与档位声明。缺省 = 回落全局 getModel（未接线方言零改动）。 */
  describeModel?: (model: string) => ModelDescriptor | undefined;
  oauthHeaders?: Record<string, string>;
}

// ---- 模型目录 ----

/** 静态模型描述符 — 数据驱动的模型选择，无需手动输入。
 *  ⚡ 2026-09-06 价格表拆除：不再维护每模型价格（cost 字段与 ModelCost 类型
 *  退役）——目录 JSON 只保留 baseUrl/kind/contextWindow/maxTokens/能力声明；
 *  价格面随 defaultPricing/Pricing/价格徽章一并移除。 */
export interface ModelDescriptor {
  id: string; // 例如 "deepseek-v4-pro"
  name: string; // 例如 "DeepSeek V4 Pro"
  kind: Protocol; // 使用哪个 provider 实现（领域词：Protocol）
  vendor: string; // Vendor 厂商（例如 "deepseek"、"anthropic"）— CONTEXT.md「Vendor」
  baseUrl: string; // API 端点
  reasoning: boolean; // 是否支持 thinking/reasoning
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  // ── 思考能力声明（P14 能力协商，2026-08-22）──
  // 档位支持是 per-model 数据，不是厂商嗅探；无声明 = 无证据 = 不编造参数。
  // 数据来源：厂商官方文档核实（用户 2026-08-22 核实 DeepSeek V4 low 档成立）+
  // pi-ai thinkingLevelMap（仅取 wire=canonical 的恒等条目；glm-5.2 式 low→high
  // 替换映射不采纳——静默替换是 P14 要杀的东西）。
  /** 声明支持的思考档位（canonical 词表子集）。缺省 = 档位未知，UI 不显示选择器，
   *  请求永不发送 effort 参数。 */
  thinkingEfforts?: readonly ThinkingEffort[];
  /** 「关闭」档是否可表达（openai 协议：DeepSeek 方言发 thinking:{type:'disabled'}，
   *  OpenAI 官方 5.1+ 发 reasoning_effort:'none'；anthropic 协议不发 thinking 块）。 */
  thinkingOff?: boolean;
  /** DeepSeek 思考方言：effort 需 thinking:{type:'enabled'|'disabled'} 包裹
   *  （api.deepseek.com 及透传该方言的网关）。仅 openai 协议消费。 */
  deepseekThinking?: boolean;
}

// ---- 错误分类 ----

/** 把 raw error 映射成人能看懂的分类和操作建议。 */
export function classifyError(name: string, status: number, body: string, fetchErr?: string): string {
  const b = body.toLowerCase();

  // 网络层
  if (status === 0) {
    if (fetchErr?.includes('ISO-8859-1') || fetchErr?.includes('headers'))
      return `[用户输入错误] Key 或 URL 中包含中文/特殊字符（HTTP header 只允许英文和数字）。请检查设置里的 Key 和地址是否误粘贴了全角符号、中文逗号、空格等。`;
    if (fetchErr?.includes('ENOTFOUND') || fetchErr?.includes('getaddrinfo'))
      return `[网络问题] 无法解析 "${name}" 的地址，请检查 URL 是否正确。`;
    if (fetchErr?.includes('ECONNREFUSED') || fetchErr?.includes('ECONNRESET'))
      return `[网络问题] 无法连接 "${name}"，请检查地址和网络。`;
    if (fetchErr?.includes('ETIMEDOUT')) return `[网络问题] 连接 "${name}" 超时，请检查地址或稍后重试。`;
    if (fetchErr?.includes('aborted')) return `[已取消] 请求被手动中止。`;
    return `[网络问题] 请求 "${name}" 失败：${fetchErr || '未知网络错误'}。请检查地址格式和网络连接。`;
  }

  // 鉴权
  if (status === 401 || (status === 403 && b.includes('invalid')))
    return `[密钥错误] "${name}" API Key 无效或已过期。请在设置中更换 Key。`;
  if (status === 403) return `[权限不足] "${name}" 拒绝了请求。请检查账户权限或 Key 的访问范围。`;

  // 服务商侧
  if (status === 429) return `[服务商限流] "${name}" 请求过于频繁，稍后自动重试。`;
  if (b.includes('rate') && (b.includes('limit') || b.includes('exceed')))
    return `[服务商限流] "${name}" 速率超限，稍后自动重试。`;
  if (status >= 500 && status <= 599) return `[服务商故障] "${name}" 服务器异常 (${status})，稍后重试。`;
  if (b.includes('overloaded') || b.includes('busy')) return `[服务商繁忙] "${name}" 当前负载过高，稍后重试。`;

  // 余额
  if (
    b.includes('insufficient_quota') ||
    b.includes('insufficient balance') ||
    b.includes('余额') ||
    b.includes('quota')
  )
    return `[余额不足] "${name}" 账户余额/配额不足，请充值。`;

  // 模型
  if (b.includes('model_not_found') || b.includes('model info') || b.includes('invalid model'))
    return `[模型不存在] "${name}" 返回的模型名不在可用列表中。请检查设置中的模型名称。`;
  if (status === 404)
    return `[地址错误] "${name}" 接口路径不存在 (404)。请检查 URL 是否拼写正确（不要漏掉 /v1 等路径）。`;

  // 未知
  const snippet = body.slice(0, 300) || `HTTP ${status}`;
  return `[未知错误] "${name}" 返回了意外错误 (${status})：${snippet}。如不确定原因，请截图联系开发者。`;
}

/**
 * 流内错误分类 — SSE error 事件只有 message 文本，没有 HTTP status。
 * 分类结果与 agent/retry.ts 的 isRetryable 标记面保持一致：
 * 限流/繁忙/服务商故障/未知 → 可重试；密钥/权限/余额/模型不存在 → 不重试。
 * （openai.ts / anthropic.ts 的 readSSE 消费；2026-08-25 补流内错误不分类缺口。）
 */
export function classifyStreamError(name: string, message: string): string {
  const b = (message || '').toLowerCase();

  if (b.includes('rate') && (b.includes('limit') || b.includes('exceed')))
    return `[服务商限流] "${name}" 流式响应速率超限，稍后自动重试。`;
  if (b.includes('overloaded') || b.includes('busy')) return `[服务商繁忙] "${name}" 流式响应负载过高，稍后重试。`;
  if (
    b.includes('insufficient_quota') ||
    b.includes('insufficient balance') ||
    b.includes('余额') ||
    b.includes('quota')
  )
    return `[余额不足] "${name}" 账户余额/配额不足，请充值。`;
  if (
    b.includes('authentication_error') ||
    b.includes('invalid_api_key') ||
    b.includes('invalid api key') ||
    b.includes('apikey')
  )
    return `[密钥错误] "${name}" API Key 无效或已过期。请检查设置中的 Key。`;
  if (b.includes('permission')) return `[权限不足] "${name}" 拒绝了请求。请检查账户权限或 Key 的访问范围。`;
  if (b.includes('model_not_found') || b.includes('invalid model') || b.includes('model info'))
    return `[模型不存在] "${name}" 返回的模型名不在可用列表中。请检查设置中的模型名称。`;
  if (b.includes('server_error') || (b.includes('internal server') && b.includes('error')))
    return `[服务商故障] "${name}" 服务器异常，稍后重试。`;
  return `[未知错误] "${name}" 流式响应中断：${message}。如不确定原因，请截图联系开发者。`;
}

// ---- 结构化错误（2026-08-31 错误码增强）----

/** 服务商原始错误的结构化元数据——文案保持人类可读（classify* 的 [分类] 面），
 *  原始码（HTTP status / 服务商 error code / retry-after / 原始响应体）挂在这
 *  里供墓碑渲染与退避决策消费。message 与普通 Error 兼容（isRetryable 仍读
 *  [前缀] 分类，不受影响）。 */
export interface ApiErrorMeta {
  /** HTTP 状态码；网络层失败为 0。 */
  status?: number;
  /** 服务商返回的错误码（如 rate_limit_exceeded / invalid_api_key / 或 SSE 的 type）。 */
  code?: string;
  /** 429 等限流响应的 retry-after 秒数（服务商明示，退避应优先于自猜）。 */
  retryAfter?: number;
  /** 原始响应体/错误文本（截断到 300 字符）。 */
  raw?: string;
}

export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryAfter?: number;
  readonly raw?: string;

  constructor(message: string, meta: ApiErrorMeta = {}) {
    super(message);
    this.name = 'ApiError';
    if (meta.status !== undefined) this.status = meta.status;
    if (meta.code !== undefined) this.code = meta.code;
    if (meta.retryAfter !== undefined) this.retryAfter = meta.retryAfter;
    if (meta.raw !== undefined) this.raw = meta.raw;
  }

  /** 墓碑/日志用的紧凑错误码摘要：「HTTP 429 · rate_limit_exceeded」；无码时返回空串。 */
  codeSummary(): string {
    const parts: string[] = [];
    if (this.status !== undefined) parts.push(`HTTP ${this.status}`);
    if (this.code) parts.push(this.code);
    return parts.join(' · ');
  }
}

/** 解析 retry-after 头（秒数或 HTTP-date）→ 秒数；无法解析返回 undefined。 */
export function retryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // HTTP-date 格式（极少数服务商）——以本地时钟差换算秒数
  const time = Date.parse(trimmed);
  if (Number.isNaN(time)) return undefined;
  const sec = Math.max(0, Math.round((time - Date.now()) / 1000));
  return Number.isFinite(sec) ? sec : undefined;
}

/** 从 OpenAI 兼容错误响应体中提取服务商错误码（error.code ?? error.type ?? error.error）。 */
export function errorCodeFromBody(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; type?: string; error?: string; message?: string };
      type?: string;
    };
    return parsed.error?.code ?? parsed.error?.type ?? parsed.error?.error ?? parsed.type ?? undefined;
  } catch {
    return undefined;
  }
}

/** 墓碑/日志显示错误码摘要；非 ApiError 或无码时返回空串（不显示）。 */
export function apiErrorSummary(err: unknown): string {
  if (err instanceof ApiError) return err.codeSummary();
  return '';
}

// ---- 工具配对清理 ----

const interruptedToolResult = '[no result: the previous turn was interrupted before this tool call completed]';

/** 修复历史记录，使每个 assistant tool_calls 都有匹配的 tool 消息。 */
export function sanitizeToolPairing(msgs: Message[]): Message[] {
  const out: Message[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'tool') j++;
      out.push(m);
      out.push(...pairToolResults(m.tool_calls, msgs.slice(i + 1, j)));
      i = j;
      continue;
    }
    if (m.role === 'tool') {
      i++; // 孤立的 tool 消息 — 丢弃
      continue;
    }
    // 跳过空的 assistant 消息 — DeepSeek 会拒绝
    if (m.role === 'assistant' && !m.content && (!m.tool_calls || m.tool_calls.length === 0)) {
      i++;
      continue;
    }
    out.push(m);
    i++;
  }
  return out;
}

function pairToolResults(calls: ToolCall[], available: Message[]): Message[] {
  return calls.map((tc) => {
    const found = available.find((r) => r.tool_call_id === tc.id);
    if (found) return found;
    return {
      role: 'tool' as Role,
      tool_call_id: tc.id,
      name: tc.name,
      content: interruptedToolResult,
    };
  });
}
