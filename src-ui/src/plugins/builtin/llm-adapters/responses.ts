// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OpenAI Responses API provider（provider-refactor 方案乙 Phase 2，2026-09）——
// POST {baseUrl}/responses，SSE 转统一 Chunk（复用 shared.ts / retry.ts）。
//
// 协议差异（对照 openai.ts 的 /chat/completions）：
//   - system → instructions（Responses 顶层字段；无独立 system 角色消息）
//   - messages → input 数组（user/assistant；tool 结果 = function_call_output）
//   - tools → tools 数组（与 chat 形状同构 {type:'function',function:{...}}）
//   - thinking（StoredThinking 命名档位）→ reasoning: { effort: <档位> }
//     （Responses 的 effort 词表 = canonical 档位；'off' 不支持时不下发——
//     Responses 无 thinking:{type:'disabled'} 方言，无声明 = 模型默认）
//   - 流式事件：response.output_text.delta（文本）/
//     response.function_call_arguments.delta（工具参数）/
//     response.completed（收尾：完整工具调用 + usage + Done）
//   - usage 在 response.completed 的 response.usage
//
// 目标端点（Phase 3 codex 模板）：https://chatgpt.com/backend-api/responses
// （ChatGPT Codex 订阅；请求带 OAuth Bearer + chatgpt-account-id + originator 头，
//  经 extraHeaders 注入——createProvider 的 ProviderRuntimeArgs 尚无该面，OAuth
//  落地时经 live provider 行级解析扩展，见 provider/oauth.ts）。
// 通用 OpenAI 官方：https://api.openai.com/v1/responses（平台 API Key）。

import {
  ApiError,
  assertEffortDeclared,
  type Chunk,
  ChunkType,
  classifyProviderError,
  classifyStreamError,
  getModel,
  type Message,
  type ModelDescriptor,
  type ModelMeta,
  modelEntries,
  type Provider,
  parseModelEntry,
  type Request,
  type ResponsesOutputItem,
  type StoredThinking,
  sanitizeToolPairing,
  thinkingCapability,
} from './host';
import { sendWithRetry } from './retry';
import {
  extractWritePreview,
  fetchJsonWithTimeout,
  mergeHeaders,
  prewarmEndpoint,
  type SseEvent,
  sseEvents,
} from './shared';

const DEFAULT_MAX_TOKENS = 64000;

/** output_item.added / output_item.done 的 item：开放形状（ResponsesOutputItem）
 *  外加本适配器点名消费的字段——留档一律用**原始 item 对象**（回放要原样）。 */
interface ResponsesSseItem extends ResponsesOutputItem {
  role?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  status?: string;
  /** reasoning item：加密推理体（**必须取 output_item.done 那一份**，
   *  added 事件里的可能不完整——官方 SDK 类型注原文）。 */
  encrypted_content?: string;
}

/** Responses API SSE 事件形状（本文件消费的子集）。 */
interface ResponsesSseEvent extends SseEvent {
  response?: {
    id?: string;
    status?: string;
    /** 完整输出项数组（response.completed 携带）——reasoning 项的回放真源。 */
    output?: ResponsesOutputItem[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
    error?: { code?: string; message?: string };
  };
  output_index?: number;
  item?: ResponsesSseItem;
  /** response.output_text.delta 段 */
  delta?: string;
  /** response.function_call_arguments.delta 段 */
  partial_json?: string;
}

interface ResponsesConfig {
  name?: string;
  apiKey: string;
  baseUrl: string; // 例如 "https://api.openai.com/v1" 或 "https://chatgpt.com/backend-api"
  model: string;
  /** 思考档位（ThinkingPolicy）。'off' = 关闭；命名档位须在模型声明清单内。 */
  thinking?: StoredThinking;
  /** per-model 最大输出覆盖（P14）：请求时按模型解析，0/缺省 = 目录值。 */
  maxTokensFor?: (model: string) => number | undefined;
  /** 附加请求头（Phase 3 OAuth：chatgpt-account-id / originator / version / UA）。 */
  extraHeaders?: Record<string, string>;
  /** provider 作用域描述符解析（provider-model-meta）：携带本提供方拉取到的
   *  元数据与用户覆盖；缺省 = 全局目录（getModel）。 */
  describeModel?: (model: string) => ModelDescriptor | undefined;
  /** 自定义请求头（settings.headers）：连接怪癖的用户可编辑面。合并序
   *  「自定义头在前、内核必需头与 OAuth/凭据头在后」——Authorization 归凭据权威。 */
  headers?: Record<string, string>;
}

export function createResponsesProvider(cfg: ResponsesConfig): Provider {
  const name = cfg.name || 'responses';
  const baseUrl = cfg.baseUrl.replace(/\/$/, '');
  const { model, apiKey } = cfg;
  let thinking: StoredThinking | undefined = cfg.thinking; // setThinking 运行时更新
  const extraHeaders = cfg.extraHeaders ?? {};
  // 自定义请求头（连接怪癖用户可编辑面）：垫在 OAuth 注入头与内核必需头之下
  // （合并序见 ResponsesConfig.headers）——订阅协议的身份头不可被覆写。
  const customHeaders = cfg.headers ?? {};
  // provider 作用域描述符；缺省回落全局目录（测试直呼面零改动）
  const describe = (m: string): ModelDescriptor | undefined => cfg.describeModel?.(m) ?? getModel(m);
  let fetchedMeta: Record<string, ModelMeta> = {};

  return {
    name() {
      return name;
    },
    model() {
      return model;
    },
    setThinking(cfg2: StoredThinking | undefined): void {
      thinking = cfg2;
    },
    async *stream(signal: AbortSignal, req: Request): AsyncGenerator<Chunk> {
      // P14 能力协商：目录模型声明是档位唯一裁决（目录外模型 = 无声明 = 不拦——
      // OAuth 订阅模型无 seed，effort 词表按 Responses 开放语义放行）。
      assertEffortDeclared(thinking, thinkingCapability(describe(model)), 'responses');
      const body = buildResponsesRequest(
        sanitizeToolPairing(req.messages),
        req.tools,
        model,
        req.max_tokens,
        thinking,
        cfg.maxTokensFor,
        req.imageData,
        describe(model),
      );
      const headers = mergeHeaders(customHeaders, {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...extraHeaders,
        // apiKey 空 = oauth 注入路径（extraHeaders 已带 Authorization）——不发空 Bearer
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      });
      const response = await sendWithRetry({
        url: `${baseUrl}/responses`,
        headers,
        body: JSON.stringify(body),
        signal,
        name,
      });

      if (!response.body) throw new Error(`${name}: no response body`);

      yield* readSSE(response.body, name, signal);
    },

    prewarm(): void {
      prewarmEndpoint(
        `${baseUrl}/models`,
        mergeHeaders(customHeaders, { ...extraHeaders, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }),
      );
    },

    async fetchModels(): Promise<ModelDescriptor[]> {
      // Responses 端点可能无公开 /models（chatgpt.com/backend-api）；官方平台
      // /v1/models 同 openai.ts。失败上抛——调用面可见（错误不静默）。
      const headers = mergeHeaders(customHeaders, {
        ...extraHeaders,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      });
      const json = await fetchJsonWithTimeout(`${baseUrl}/models`, headers, 10000);
      if (!json) throw new Error(`${name}: 模型目录获取失败（网络错误或端点无响应）`);
      // 宽容解析（provider-model-meta）：官方 Responses 端点不披露窗口/模态时保持
      // 「未知」语义不编造；披露了则照收（含 provider 级落盘元数据）。
      const ctx = { kind: 'responses', vendor: name, baseUrl };
      const models: ModelDescriptor[] = [];
      const meta: Record<string, ModelMeta> = {};
      for (const raw of modelEntries(json)) {
        const parsed = parseModelEntry(raw, ctx);
        if (!parsed) continue;
        models.push(parsed.descriptor);
        meta[parsed.descriptor.id] = parsed.meta;
      }
      fetchedMeta = meta;
      return models;
    },
    lastModelMeta(): Record<string, ModelMeta> {
      return fetchedMeta;
    },
  };
}

// ---- 请求构建 ----

/** 本适配器**合成**的 input item（message / function_call / function_call_output）。
 *  官方 schema（openai-python `ResponseInputItemParam`，由 OpenAPI 生成）里这三者
 *  是**平级**的顶层 item——function_call **不是** message 的子字段（旧实现把
 *  function_call 数组塞进 `message.output`：schema 没有该字段，整个工具链因此
 *  不合规）。content 数组元素含 B3 附图 input_image part（image_url = data URI）。 */
interface ResponsesInputItem {
  type?: 'message' | 'function_call' | 'function_call_output';
  role?: 'user' | 'assistant' | 'developer' | 'system';
  content?: Array<{ type: string; text?: string; output?: string; image_url?: string }>;
  /** function_call_output 的载荷：字符串，或**内容项数组**（带图时用它——
   *  工具附图通道 P0a：`[{type:'input_text'},{type:'input_image'}]`）。
   *  官方字段名是 `output`（`output_text` 不在 schema 里；缺 `output` = 400）。 */
  output?: string | Array<{ type: string; text?: string; image_url?: string }>;
  /** function_call / function_call_output 的**配对键**：模型生成的 call id
   *  （`call_…`，不是 item id `fc_…`）——两者都在 item 上，用错就配不上对。 */
  call_id?: string;
  /** function_call item：工具名 + 参数 JSON */
  name?: string;
  arguments?: string;
}

/** input 数组条目 = 本适配器合成的 item，或**原样回放的 output item**
 *  （reasoning / message / function_call —— 见 Message.responses_items）。 */
type ResponsesInputEntry = ResponsesInputItem | ResponsesOutputItem;

/** Responses API 工具形状：type/name/description/parameters 平铺（非 chat 的
 *  function 嵌套）。 */
interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: ResponsesInputEntry[];
  tools?: ResponsesTool[];
  reasoning?: { effort?: string; summarize?: 'auto' | 'concise' | 'detailed' };
  max_output_tokens: number;
  stream: true;
  /** 无状态请求（本适配器自己重放历史，不用 previous_response_id）。 */
  store: false;
  /** 要求回传 reasoning 项的 encrypted_content（无状态回放的必需料）。 */
  include: ['reasoning.encrypted_content'];
}

/** 留档 output item 的回放净化：只剥 `logprobs`（逐 token 概率——端点若回传可达
 *  MB 级，回放它既不必要又把卷撑爆；本适配器从不请求它，属防御）。其余字段
 *  **一律原样**：id / encrypted_content / status / phase 都是回放必需或有益的
 *  （见 Message.responses_items）。 */
function sanitizeStoredItem(item: ResponsesOutputItem): ResponsesOutputItem {
  const content = item.content;
  if (item.type !== 'message' || !Array.isArray(content)) return item;
  if (!content.some((part) => part !== null && typeof part === 'object' && 'logprobs' in part)) return item;
  return {
    ...item,
    content: content.map((part) => {
      if (part === null || typeof part !== 'object') return part;
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(part as Record<string, unknown>)) if (k !== 'logprobs') rest[k] = v;
      return rest;
    }),
  };
}

export function buildResponsesRequest(
  msgs: Message[],
  tools: Request['tools'],
  model: string,
  maxTok: number,
  thinkingCfg: StoredThinking | undefined,
  maxTokensFor?: (model: string) => number | undefined,
  imageData?: Request['imageData'],
  /** provider 作用域描述符（拉取元数据 + 用户覆盖 + seed 合并）；缺省 = 全局目录。 */
  desc?: ModelDescriptor,
): ResponsesRequest {
  // instructions：全部 system 消息合并（Responses 顶层字段，非 input 角色）
  const systemParts = msgs.filter((m) => m.role === 'system').map((m) => m.content);
  const instructions = systemParts.length > 0 ? systemParts.join('\n') : undefined;

  // input：非 system 消息（user/assistant/tool）——官方 item 形态（三者平级）：
  //   user/assistant → {type:'message', role, content}
  //   assistant 工具 → 顶层 {type:'function_call', call_id, name, arguments}
  //   tool 结果      → {type:'function_call_output', call_id, output}
  //   **已留档的 output items**（reasoning/message/function_call）→ 原样回放
  const input: ResponsesInputEntry[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      // 工具附图通道 P0a（docs/plans/tool-image-context-plan.md）：本协议
      // function_call_output 支持内容项数组 → 图随工具结果进上下文。
      // 无图 tool 仍是字符串 output（纯文本 wire 逐字节不变，D-6）。
      const parts: Array<{ type: 'input_text' | 'input_image'; text?: string; image_url?: string }> = [];
      if (m.images !== undefined && m.images.length > 0 && imageData !== undefined) {
        parts.push({ type: 'input_text', text: m.content || '(no output)' });
        for (const ref of m.images) {
          const hit = imageData[ref.id];
          if (hit === undefined) continue; // 读失败/超预算图——wire 缺图不炸
          parts.push({ type: 'input_image', image_url: `data:${hit.mediaType};base64,${hit.data}` });
        }
      }
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: parts.length > 1 ? parts : m.content || '(no output)',
      });
      continue;
    }
    if (m.role === 'assistant' && m.responses_items !== undefined && m.responses_items.length > 0) {
      // ⚡ 思考链/工具项回放（2026-09-23 Responses 合规批次）：官方对话状态指引
      // 要求手工管理上下文时把上一轮 `response.output` **原样拼回** input——
      // 漏掉 `type:"reasoning"` 项时带 tools 的请求被拒：
      //   · OpenAI：Item 'fc_…' of type 'function_call' was provided without its
      //     required 'reasoning' item / 反向的「provided without its required
      //     following item」（reasoning 与它的后继项必须成对相邻）；
      //   · DeepSeek Responses：The `reasoning_text` in the thinking mode must be
      //     passed back to the API.（与 Chat 的 reasoning_content、Messages 的
      //     thinking 块同一条规则的三种字段名）。
      // 「原样」= 逐字段照搬（含 id / encrypted_content / status / phase），
      // 这样 reasoning 与它的 function_call 相邻关系、Codex 的 phase 全部保住。
      for (const item of m.responses_items) input.push(sanitizeStoredItem(item));
      // 留档里没有 message 项却有正文（流中断/旧卷）——补一条，正文不丢。
      if (m.content && !m.responses_items.some((it) => it.type === 'message')) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'input_text', text: m.content }] });
      }
      // 留档缺了某个 function_call（`output_item.done` 没到就断流）：补合成项。
      // **必须补**——否则该工具的 function_call_output 找不到配对的调用，服务端
      // 直接拒（"No tool call found for function call output with call_id …"）。
      const storedCalls = new Set(
        m.responses_items
          .filter((it) => it.type === 'function_call')
          .map((it) => (typeof it.call_id === 'string' ? it.call_id : '')),
      );
      for (const tc of m.tool_calls ?? []) {
        if (storedCalls.has(tc.id)) continue;
        input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments || '' });
      }
      continue;
    }
    // user / assistant（无留档时的合成路径：旧卷、非 Responses 方言写入的历史）
    const content: Array<{ type: string; text?: string; image_url?: string }> = [];
    if (m.content) content.push({ type: 'input_text', text: m.content });
    // B3（multimodal-image-plan）：user 带图且解析表非空 → input_image parts
    // （读失败图自然跳过）。无图消息形态字节不变（D-6）。
    if (m.role === 'user' && m.images !== undefined && m.images.length > 0 && imageData !== undefined) {
      for (const ref of m.images) {
        const hit = imageData[ref.id];
        if (hit === undefined) continue;
        content.push({ type: 'input_image', image_url: `data:${hit.mediaType};base64,${hit.data}` });
      }
    }
    input.push({ type: 'message', role: m.role as 'user' | 'assistant', content });
    // assistant 的 tool_calls → **顶层** function_call item（官方 schema 里
    // function_call 不是 message 的子字段；配对的 call_id 就是 ToolCall.id）
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments || '',
        });
      }
    }
  }

  // 历史必然 user 开头——input 首条**不是 message** 时（sanitize 失败边缘的孤立
  // tool 结果、或留档首项就是 reasoning/function_call），前置空 user 防 400
  const first = input[0];
  if (first !== undefined && first.type !== 'message') {
    input.unshift({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] });
  }

  const respTools: ResponsesTool[] | undefined =
    tools.length > 0
      ? tools.map((t) => ({
          type: 'function' as const,
          name: t.name,
          description: t.description,
          parameters: Object.keys(t.parameters).length > 0 ? t.parameters : { type: 'object', properties: {} },
        }))
      : undefined;

  const r: ResponsesRequest = {
    model,
    input,
    tools: respTools,
    max_output_tokens: 0,
    stream: true,
    // 无状态 + 加密推理体（Codex 客户端同款，2026-09-23 合规批次）：
    // 本适配器**自己重放全部历史**（不用 previous_response_id）⇒ 服务端无需留
    // 会话状态；`include` 要求把 reasoning 项的 `encrypted_content` 一并回传——
    // 无状态端点上缺了它，回放的 reasoning 项就是「没料的空壳」，校验不过。
    // 官方 SDK 类型注：encrypted_content 取 `output_item.done` 那一份（added 的
    // 可能不完整）。不支持的兼容层按既有实测语义忽略这两个字段（DeepSeek
    // Responses 兼容页：store/metadata/safety_identifier 一律「不支持但 200」）。
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  if (instructions) r.instructions = instructions;

  // max_output_tokens：maxTok（调用方给）或目录值兜底；钳制同 openai.ts 语义
  // （用户覆盖 ?? provider 作用域描述符 ?? 全局目录）
  const cap = maxTokensFor?.(model) ?? desc?.maxTokens ?? getModel(model)?.maxTokens;
  const desired = maxTok > 0 ? maxTok : DEFAULT_MAX_TOKENS;
  r.max_output_tokens = cap && cap > 0 ? Math.min(desired, cap) : desired;

  // reasoning.effort：命名档位 → canonical 原值；'off'/''/数字遗留 → 不下发
  // （Responses 无关闭方言——模型默认；不编造）
  const stored = thinkingCfg || '';
  if (stored !== 'off' && stored !== '' && !/^\d+$/.test(stored)) {
    r.reasoning = { effort: stored };
  }

  return r;
}

// ---- SSE 流解析 ----

async function* readSSE(body: ReadableStream<Uint8Array>, name: string, signal?: AbortSignal): AsyncGenerator<Chunk> {
  // function_call 累积：output_index → {id, name, arguments}
  const toolsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  // 本轮 output items 留档（reasoning 项的回放真源）：**只收 `output_item.done`**
  // 的完整 item——added 里的 encrypted_content 可能不完整（官方 SDK 类型注），
  // 且 added 的 function_call 还没有 arguments（回放带空参数 = 篡改历史）。
  const itemsByIndex = new Map<number, ResponsesOutputItem>();
  let usage: Chunk['usage'];

  /** 收尾取本轮 items：优先 `response.completed.response.output`（权威全量，
   *  官方指引「splice response.output back in as-is」的原文来源），回落 done 累积。 */
  const finalItems = (ev: ResponsesSseEvent): ResponsesOutputItem[] => {
    const fromCompleted = ev.response?.output;
    if (Array.isArray(fromCompleted) && fromCompleted.length > 0) return fromCompleted;
    return [...itemsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  };

  for await (const ev of sseEvents<ResponsesSseEvent>(body, name, signal)) {
    switch (ev.type) {
      case 'response.output_item.added': {
        const item = ev.item;
        // function_call item 开始。⚡ 配对键用 **call_id**（`call_…`，模型生成的
        // 调用 id）——item.id（`fc_…`）是 item 自身的 id，拿去跟
        // function_call_output.call_id 配对会配不上（服务端按 call_id 认）。
        if (item?.type === 'function_call' && ev.output_index !== undefined) {
          const callId = item.call_id || item.id || '';
          toolsByIndex.set(ev.output_index, { id: callId, name: item.name || '', arguments: '' });
          yield {
            type: ChunkType.ToolCallStart,
            tool_call: { id: callId, name: item.name || '', arguments: '' },
          };
        }
        break;
      }

      case 'response.output_item.done': {
        // 完整 item（含 reasoning 的 encrypted_content / summary、function_call
        // 的 arguments、message 的 content+phase）——留档待下一轮原样回放。
        if (ev.item !== undefined && ev.output_index !== undefined) itemsByIndex.set(ev.output_index, ev.item);
        break;
      }

      case 'response.output_text.delta':
        if (ev.delta) yield { type: ChunkType.Text, text: ev.delta };
        break;

      // 思考文本（reasoning summary；完整 reasoning_text 为 ChatGPT 订阅扩展）
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (ev.delta) yield { type: ChunkType.Reasoning, text: ev.delta };
        break;

      case 'response.function_call_arguments.delta': {
        const tc = toolsByIndex.get(ev.output_index ?? -1);
        if (tc && ev.partial_json) {
          tc.arguments += ev.partial_json;
          const preview = extractWritePreview(tc.name, tc.arguments);
          if (preview) {
            yield {
              type: ChunkType.ToolArgPreview,
              tool_arg_preview: { tool_id: tc.id, tool_name: tc.name, content: preview },
            };
          }
        }
        break;
      }

      case 'response.completed': {
        // 本轮 output items 原样留档（reasoning 项是下一轮带 tools 请求的必需项）
        const items = finalItems(ev);
        if (items.length > 0) yield { type: ChunkType.ResponsesItems, responses_items: items };
        // 收尾：补发完整 tool_call（output_item.done 之前可能已逐项补发——
        // 幂等：content_block_stop 后这里只 flush 残留）
        for (const tc of toolsByIndex.values()) {
          yield {
            type: ChunkType.ToolCall,
            tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
          };
        }
        toolsByIndex.clear();
        const u = ev.response?.usage;
        if (u) {
          const cached = u.input_tokens_details?.cached_tokens ?? 0;
          usage = {
            prompt_tokens: u.input_tokens,
            completion_tokens: u.output_tokens,
            total_tokens: u.total_tokens,
            cache_hit_tokens: cached,
            cache_miss_tokens: u.input_tokens - cached,
            cache_creation_tokens: 0,
            reasoning_tokens: u.output_tokens_details?.reasoning_tokens || 0,
            finish_reason: 'stop',
          };
          yield { type: ChunkType.Usage, usage };
        }
        yield { type: ChunkType.Done };
        return;
      }

      case 'response.failed': {
        const raw = ev.response?.error?.message || 'response failed';
        const code = ev.response?.error?.code;
        yield {
          type: ChunkType.Error,
          err: classifyProviderError(new ApiError(classifyStreamError(name, raw), { code, raw }), name),
        };
        return;
      }

      case 'error': {
        // OpenAI 平台流内 error 事件（{error:{message,code,type}}）
        const errObj = (ev as unknown as { error?: { message?: string; code?: string } }).error;
        const raw = errObj?.message || 'stream error';
        const code = errObj?.code;
        yield {
          type: ChunkType.Error,
          err: classifyProviderError(new ApiError(classifyStreamError(name, raw), { code, raw }), name),
        };
        return;
      }
    }
  }

  // 流意外结束（无 completed）——已收到的完整 items 照样留档（reasoning 项
  // 不回放 = 下一轮 400），再 flush 残留 tool + Done（不静默吞）
  const dangling = [...itemsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  if (dangling.length > 0) yield { type: ChunkType.ResponsesItems, responses_items: dangling };
  for (const tc of toolsByIndex.values()) {
    yield {
      type: ChunkType.ToolCall,
      tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
    };
  }
  yield { type: ChunkType.Done };
}
