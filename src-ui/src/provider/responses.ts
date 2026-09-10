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

import { getModel } from './catalog';
import { classifyProviderError } from './error-catalog';
import { type ModelMeta, modelEntries, parseModelEntry } from './model-meta';
import { sendWithRetry } from './retry';
import { extractWritePreview, fetchJsonWithTimeout, prewarmEndpoint, type SseEvent, sseEvents } from './shared';
import { assertEffortDeclared, type StoredThinking, thinkingCapability } from './thinking';
import {
  ApiError,
  type Chunk,
  ChunkType,
  classifyStreamError,
  type Message,
  type ModelDescriptor,
  type Provider,
  type Request,
  sanitizeToolPairing,
} from './types';

const DEFAULT_MAX_TOKENS = 64000;

/** Responses API SSE 事件形状（本文件消费的子集）。 */
interface ResponsesSseEvent extends SseEvent {
  response?: {
    id?: string;
    status?: string;
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
  item?: {
    id: string;
    type: string;
    role?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
  };
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
}

export function createResponsesProvider(cfg: ResponsesConfig): Provider {
  const name = cfg.name || 'responses';
  const baseUrl = cfg.baseUrl.replace(/\/$/, '');
  const { model, apiKey } = cfg;
  let thinking: StoredThinking | undefined = cfg.thinking; // setThinking 运行时更新
  const extraHeaders = cfg.extraHeaders ?? {};
  // provider 作用域描述符；缺省回落全局目录（测试直呼面零改动）
  const describe = (m: string): ModelDescriptor | undefined => cfg.describeModel?.(m) ?? getModel(m);
  let fetchedMeta: Record<string, ModelMeta> = {};

  return {
    name() {
      return name;
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
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...extraHeaders,
      };
      // apiKey 空 = oauth 注入路径（extraHeaders 已带 Authorization）——不发空 Bearer
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
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
      const headers: Record<string, string> = { ...extraHeaders };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      prewarmEndpoint(`${baseUrl}/models`, headers);
    },

    async fetchModels(): Promise<ModelDescriptor[]> {
      // Responses 端点可能无公开 /models（chatgpt.com/backend-api）；官方平台
      // /v1/models 同 openai.ts。失败上抛——调用面可见（错误不静默）。
      const headers: Record<string, string> = { ...extraHeaders };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
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

/** input 数组 item：message item 或 function_call_output item（Responses 官方
 *  item-based 形态，非 chat messages 形态）。content 数组元素含 B3 附图
 *  input_image part（image_url = data URI）。 */
interface ResponsesInputItem {
  type?: 'message' | 'function_call_output';
  role?: 'user' | 'assistant' | 'developer' | 'system';
  content?: Array<{ type: string; text?: string; output?: string; image_url?: string }>;
  /** message item 的 assistant 工具输出子项（function_call 数组） */
  output?: Array<{ id?: string; type: 'function_call'; name?: string; arguments?: string; call_id?: string }>;
  /** function_call_output item：关联的 function_call id */
  call_id?: string;
  output_text?: string;
}

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
  input: ResponsesInputItem[];
  tools?: ResponsesTool[];
  reasoning?: { effort?: string; summarize?: 'auto' | 'concise' | 'detailed' };
  max_output_tokens: number;
  stream: true;
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

  // input：非 system 消息（user/assistant/tool）——标准 Responses item 形态：
  //   user/assistant → {type:'message', role, content}
  //   tool 结果      → {type:'function_call_output', call_id, output}
  // assistant 的 tool_calls → message.output 里的 function_call 子项
  const input: ResponsesInputItem[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output_text: m.content || '(no output)',
      });
      continue;
    }
    // user / assistant
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
    const item: ResponsesInputItem = {
      type: 'message',
      role: m.role as 'user' | 'assistant',
      content,
    };
    // assistant 的 tool_calls → message.output 里的 function_call（id/name/arguments）
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      item.output = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function_call' as const,
        name: tc.name,
        arguments: tc.arguments || '',
        call_id: tc.id,
      }));
      // assistant 只有 tool_calls 无文本：content 可为空（output 承载调用）
      if (!m.content) item.content = undefined;
    }
    input.push(item);
  }

  // 历史消息必然 user 开头（首个 user 前无 tool 结果）——若 input 首条是
  // function_call_output（sanitize 失败边缘），前置空 user 防 400
  if (input.length > 0 && input[0].type === 'function_call_output') {
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
  let usage: Chunk['usage'];

  for await (const ev of sseEvents<ResponsesSseEvent>(body, name, signal)) {
    switch (ev.type) {
      case 'response.output_item.added': {
        const item = ev.item;
        // function_call item 开始
        if (item?.type === 'function_call' && ev.output_index !== undefined) {
          toolsByIndex.set(ev.output_index, { id: item.id || '', name: item.name || '', arguments: '' });
          yield {
            type: ChunkType.ToolCallStart,
            tool_call: { id: item.id || '', name: item.name || '', arguments: '' },
          };
        }
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

  // 流意外结束（无 completed）——flush 残留 tool + Done（不静默吞）
  for (const tc of toolsByIndex.values()) {
    yield {
      type: ChunkType.ToolCall,
      tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
    };
  }
  yield { type: ChunkType.Done };
}
