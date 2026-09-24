// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OpenAI 兼容 provider — DeepSeek、MiMo 及任何 OpenAI 兼容端点
// 手写 fetch() + SSE 解析，零第三方 SDK

import {
  ApiError,
  assertEffortDeclared,
  type ChatImageRef,
  type Chunk,
  ChunkType,
  clampMaxTokens,
  classifyProviderError,
  classifyStreamError,
  getModel,
  isThinkingMode,
  type Message,
  type ModelDescriptor,
  type ModelMeta,
  modelEntries,
  type Provider,
  parseModelEntry,
  type Request,
  type Role,
  type StoredThinking,
  sanitizeToolPairing,
  type ThinkingEffort,
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

const DEFAULT_MAX_TOKENS = 32000; // ponytail：跨提供商的安全上限（GLM 上限 131072）

/** OpenAI 兼容 API 的 SSE 事件形状（本文件消费的子集）。 */
interface OpenAiSseEvent extends SseEvent {
  // 2026-08-31 错误码增强：OpenAI 协议 error 对象带 code/type/message
  error?: { message?: string; code?: string; type?: string };
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    // DeepSeek 在 usage 顶层单独报告精确缓存拆解(OpenAI 原生无)。
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
  choices?: Array<{
    delta: {
      content?: string;
      /** 思考文本双形状（2026-09-06 尸检）：DeepSeek 方言 reasoning_content /
       *  OpenRouter 系网关方言 reasoning——两字段生态并存，usage 侧双形状
       *  读取（prompt_cache_hit_tokens ?? prompt_tokens_details）同款惯例。 */
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
}

interface OpenAIConfig {
  name?: string;
  apiKey: string;
  baseUrl: string; // 例如 "https://api.deepseek.com/v1" 或 "https://api.openai.com/v1"
  model: string;
  /** 思考档位（ThinkingPolicy）。'off' = 关闭；命名档位须在模型声明清单内。 */
  thinking?: StoredThinking;
  /** per-model 最大输出覆盖（P14）：请求时按模型解析，0/缺省 = 目录值。 */
  maxTokensFor?: (model: string) => number | undefined;
  /** provider 作用域描述符解析（provider-model-meta）：携带本提供方拉取到的
   *  元数据与用户覆盖；缺省 = 全局目录（getModel）。 */
  describeModel?: (model: string) => ModelDescriptor | undefined;
  /** 自定义请求头（settings.headers）：连接怪癖的用户可编辑面。合并序
   *  「自定义头在前、内核必需头与凭据头在后」——Authorization 恒归凭据权威。 */
  headers?: Record<string, string>;
}

/** 动态模型 reasoning 启发式已迁入 provider/model-meta.ts（三方言共用的
 *  guessReasoningFromId，按协议分野）——本文件不再持有该逻辑（单一真源）。 */

export function createOpenAIProvider(cfg: OpenAIConfig): Provider {
  const name = cfg.name || 'openai';
  const baseUrl = cfg.baseUrl.replace(/\/$/, ''); // 用户在 baseUrl 中控制 v1 前缀
  const { model, apiKey } = cfg;
  let thinking: StoredThinking | undefined = cfg.thinking; // setThinking 运行时更新
  // provider 作用域描述符（拉取元数据 + 用户覆盖 + 静态 seed 合并）；
  // 缺省回落全局目录——测试直呼面与未接线方言零改动。
  const describe = (m: string): ModelDescriptor | undefined => cfg.describeModel?.(m) ?? getModel(m);
  // 自定义请求头（连接怪癖用户可编辑面）：三处请求（stream/prewarm/fetchModels）
  // 一并携带；内核必需头与 Authorization 在后覆盖（合并序见 OpenAIConfig.headers）。
  const customHeaders = cfg.headers ?? {};
  // 最近一次 fetchModels 解析出的元数据（落盘面经 Provider.lastModelMeta 取）
  let fetchedMeta: Record<string, ModelMeta> = {};

  return {
    name() {
      return name;
    },
    model() {
      return model;
    },
    setThinking(cfg: StoredThinking | undefined): void {
      thinking = cfg;
    },
    async *stream(signal: AbortSignal, req: Request): AsyncGenerator<Chunk> {
      // P14 能力协商：模型声明是档位合法性的唯一裁决（声明来自本 provider 作用域
      // 的合并描述符——网关拉取到的档位声明与用户覆盖都能抵达这里）。选中声明外
      // 档位在任何网络 I/O 之前响亮报错（绝不静默替换成别的档位）。
      assertEffortDeclared(thinking, thinkingCapability(describe(model)), 'openai');
      const body = buildChatRequest(
        sanitizeToolPairing(req.messages),
        req.tools,
        model,
        req.max_tokens,
        thinking,
        cfg.maxTokensFor,
        req.imageData,
        describe(model),
      );
      const response = await sendWithRetry({
        url: `${baseUrl}/chat/completions`,
        headers: mergeHeaders(customHeaders, {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        }),
        body: JSON.stringify(body),
        signal,
        name,
      });

      if (!response.body) throw new Error(`${name}: no response body`);

      yield* readSSE(response.body, name, signal);
    },

    prewarm(): void {
      prewarmEndpoint(`${baseUrl}/models`, mergeHeaders(customHeaders, { Authorization: `Bearer ${apiKey}` }));
    },

    async fetchModels(): Promise<ModelDescriptor[]> {
      const json = await fetchJsonWithTimeout(
        `${baseUrl}/models`,
        mergeHeaders(customHeaders, { Authorization: `Bearer ${apiKey}` }),
        10000,
      );
      // C5（2026-08-27）：目录失败面——fetchJsonWithTimeout 对非 ok/网络/超时
      // 一律返回 null，此前被静默当成「无模型」（调用面 .catch(() => {}) 永不
      // 触发，用户完全无感）。上抛让调用面可记失败（compact 选择器分组头标注 /
      // 手动刷新报真实原因）；静态目录 + 已合并的 last-good 动态模型兜底，不因
      // 失败丢失。
      if (!json) throw new Error(`${name}: 模型目录获取失败（网络错误或端点无响应）`);
      // 宽容解析（provider-model-meta）：端点披露什么就填什么——OpenAI 兼容族
      // 的方言差异极大（官方仅 id；聚合网关给 name + context_length；OpenRouter
      // 系给 architecture.input_modalities + supported_parameters）。未披露的字段
      // 保持「未知」语义（不编造）；真披露的字段同时收进 lastModelMeta 供落盘。
      const ctx = { kind: 'openai', vendor: name, baseUrl };
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

/** user 消息多模态 content parts（multimodal-image-plan B3）：文本恒在前，
 *  image_url data URI 依消息内 images 序 join（imageData 键控 ChatImageRef.id；
 *  解析缺图的引用自然跳过——wire 缺图不炸）。 */
interface ChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface ChatMessage {
  role: string;
  content: string | null | ChatContentPart[];
  /** 思考链回传（DeepSeek 官方规则：带 tools 的请求必须回传历史 reasoning_content）。 */
  reasoning_content?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  max_tokens: number;
  stream: true;
  stream_options?: { include_usage: true };
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: ThinkingEffort | 'none';
}

export function buildChatRequest(
  msgs: Message[],
  tools: Request['tools'],
  model: string,
  maxTok: number,
  thinking: StoredThinking | undefined,
  maxTokensFor?: (model: string) => number | undefined,
  imageData?: Request['imageData'],
  /** provider 作用域描述符（拉取元数据 + 用户覆盖 + seed 合并）；缺省 = 全局目录。
   *  测试直呼面不传即保持旧行为（getModel）。 */
  desc?: ModelDescriptor,
): ChatRequest {
  // P14 能力协商：档位合法性由模型声明裁决（deepseek.json 等声明 thinkingEfforts）。
  // 直连 DeepSeek 声明 low/high/max（2026-08-22 用户官方文档核实 low 成立）。
  const resolved = desc ?? getModel(model);
  const cap = thinkingCapability(resolved);
  assertEffortDeclared(thinking, cap, 'openai');

  // wire 翻译（声明驱动，零静默替换）：
  //  - 自动（''/数字遗留）→ 不发参数（模型自定）。
  //  - 命名档位 → reasoning_effort 原值发送；DeepSeek 方言（deepseekThinking 声明）
  //    需 thinking:{type:'enabled'} 包裹——api.deepseek.com 扩展，OpenAI 官方是
  //    400 雷区（P12 曾对 OpenAI 官方发包裹，从未真机验证，P14 移除）。
  //  - 关闭 → 声明可关才发：DeepSeek 方言 thinking:{type:'disabled'}；
  //    OpenAI 官方 5.1+ reasoning_effort:'none'；未声明关闭的模型不发参数
  //    （目录外模型无从关闭——不编造，模型默认即最终行为）。
  const stored = thinking || '';
  const level = isThinkingMode(stored) ? stored : '';
  let thinkingBlock: ChatRequest['thinking'];
  let effort: ChatRequest['reasoning_effort'];
  if (level === 'off') {
    if (cap.off) {
      if (cap.deepseekWrap) thinkingBlock = { type: 'disabled' };
      else effort = 'none';
    }
  } else if (level !== '') {
    if (cap.deepseekWrap) thinkingBlock = { type: 'enabled' };
    effort = level;
  }
  const chatMsgs: ChatMessage[] = [];

  // 工具附图通道 P0a（docs/plans/tool-image-context-plan.md）：OpenAI 兼容 chat 的
  // tool role 不接收图片 → 把工具附图汇成该轮 tool 组**之后**的一条合成 user 消息
  // （组尾最稳：不在 tool 序列中间插 user，兼容性最好）。无图时一行都不产生
  // （D-6：无图路径 wire 形态逐字节不变）。
  let pendingToolImages: ChatImageRef[] = [];
  let pendingToolName = '';
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    const refs = pendingToolImages;
    const name = pendingToolName;
    pendingToolImages = [];
    pendingToolName = '';
    const parts: ChatContentPart[] = [{ type: 'text', text: `（工具附图：${name || 'tool'} —— 图像见下）` }];
    for (const ref of refs) {
      const hit = imageData?.[ref.id];
      if (hit === undefined) continue; // 读失败/超预算图——wire 缺图不炸
      parts.push({ type: 'image_url', image_url: { url: `data:${hit.mediaType};base64,${hit.data}` } });
    }
    if (parts.length > 1) chatMsgs.push({ role: 'user', content: parts });
  };

  for (const m of msgs) {
    // tool 组的连续段结束 → 先补上工具附图（组尾语义）
    if (m.role !== 'tool') flushToolImages();
    switch (m.role as Role) {
      case 'system':
      case 'user':
        // B3（multimodal-image-plan）：user 消息带图且解析表非空 → content
        // parts 数组（text 在前、image_url 在后）。纯文本消息保持 string
        // 紧凑形态（D-6——字节不变，前缀缓存/兼容面零影响）。
        if (m.role === 'user' && m.images !== undefined && m.images.length > 0 && imageData !== undefined) {
          const parts: ChatContentPart[] = [];
          if (m.content) parts.push({ type: 'text', text: m.content });
          for (const ref of m.images) {
            const hit = imageData[ref.id];
            if (hit === undefined) continue; // 读失败/超预算图——wire 缺图不炸
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${hit.mediaType};base64,${hit.data}` },
            });
          }
          chatMsgs.push(
            parts.length > 0 ? { role: m.role, content: parts } : { role: m.role, content: m.content || null },
          );
          break;
        }
        chatMsgs.push({ role: m.role, content: m.content || null });
        break;
      case 'tool':
        chatMsgs.push({
          role: 'tool',
          content: m.content || '(no output)',
          tool_call_id: m.tool_call_id,
          name: m.name,
        });
        // 工具附图（P0a）：本协议 tool role 不收图，攒到组尾合成 user 消息里发
        if (m.images !== undefined && m.images.length > 0 && imageData !== undefined) {
          pendingToolImages.push(...m.images);
          pendingToolName = m.name ?? pendingToolName;
        }
        break;
      case 'assistant': {
        const cm: ChatMessage = { role: 'assistant', content: m.content || null };
        // 思考链回传（2026-09-23 思考回传批次）：**带 tools 参数的请求**里，历史
        // assistant 轮的 `reasoning_content` 必须原样回传，否则 API 返回 400
        // （「The `reasoning_content` in the thinking mode must be passed back to
        // the API.」）；不带 tools 的请求官方会忽略该字段（guides/thinking_mode
        // Tool Calls 节）。此前一律不回传——直连 api.deepseek.com 时第一轮工具调用
        // 之后每个请求都撞 400，且那条缺字段的消息已在卷里，整卷持续重放失败
        // （DSH 同类事故：deepseek-harness#3857）。**空思考不发**：缺字段 = 该轮
        // 思考关闭或网关剥离，编造空串只会改字节、不给模型任何信息。
        // 参照实现：DSH `llm-deepseek` protocols/chat-completions/serialize.ts。
        if (m.reasoning_content) cm.reasoning_content = m.reasoning_content;
        if (m.tool_calls && m.tool_calls.length > 0) {
          cm.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          }));
          // OpenAI 不希望 tool_calls 旁边有 content
          if (!m.content) cm.content = null;
        }
        chatMsgs.push(cm);
        break;
      }
    }
  }
  // 载荷以 tool 组收尾时，附图消息在此补上
  flushToolImages();

  // OpenAI 兼容协议没有 cache_control 字段 — 每个 provider
  // 自行做服务端前缀缓存（DeepSeek 自动，官方 OpenAI 用 prompt_cache_key）。
  // 在此注入 Anthropic 的 cache_control 会在严格的验证器上返回 400
  // （GLM、Qwen 等）。cc-switch regression_gh3805.
  const chatTools: ChatTool[] | undefined =
    tools.length > 0
      ? tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: Object.keys(t.parameters).length > 0 ? t.parameters : { type: 'object', properties: {} },
          },
        }))
      : undefined;

  const r: ChatRequest = {
    model,
    messages: chatMsgs,
    tools: chatTools,
    // 钳制链：用户覆盖 ?? provider 作用域描述符的 maxTokens（= 拉取元数据 ?? 目录
    // seed）。后者此前读不到——网关模型没有 seed 条目，钳制值恒为「无」。
    max_tokens: clampMaxTokens(
      model,
      maxTok > 0 ? maxTok : DEFAULT_MAX_TOKENS,
      maxTokensFor?.(model) ?? resolved?.maxTokens,
    ),
    stream: true,
    stream_options: { include_usage: true },
    thinking: thinkingBlock,
    reasoning_effort: effort,
  };

  return r;
}

// ---- SSE 流解析 ----

async function* readSSE(body: ReadableStream<Uint8Array>, name: string, signal?: AbortSignal): AsyncGenerator<Chunk> {
  const toolsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: Chunk['usage'];

  for await (const ev of sseEvents<OpenAiSseEvent>(body, name, signal)) {
    // 来自 OpenAI 兼容 API 的流内错误（DeepSeek 过载、限流等）
    if (ev.error) {
      const raw = ev.error.message || JSON.stringify(ev.error);
      // 2026-08-31 错误码增强：挂 OpenAI 协议的 error.code ?? error.type
      // Phase 1：经 classifyProviderError 编织（附 kind——上层可语义分流）
      yield {
        type: ChunkType.Error,
        err: classifyProviderError(
          new ApiError(classifyStreamError(name, raw), {
            code: ev.error.code ?? ev.error.type,
            raw: ev.error.message,
          }),
          name,
        ),
      };
      return;
    }

    // Usage 可能出现在单独的 chunk 中，也可能伴随最后一个 choice 出现。
    // 处理它但不要 continue — 同一个 chunk 可能还携带带 finish_reason 的 choices，
    // 我们需要它来检测工具调用是否完成。
    if (ev.usage) {
      const cached = ev.usage.prompt_cache_hit_tokens ?? ev.usage.prompt_tokens_details?.cached_tokens ?? 0;
      usage = {
        prompt_tokens: ev.usage.prompt_tokens,
        completion_tokens: ev.usage.completion_tokens,
        total_tokens: ev.usage.total_tokens,
        cache_hit_tokens: cached,
        cache_miss_tokens: ev.usage.prompt_cache_miss_tokens ?? ev.usage.prompt_tokens - cached,
        // OpenAI 兼容协议不提供缓存创建(写缓存)拆解;DeepSeek 同样只给 read 侧的 hit/miss。
        cache_creation_tokens: 0,
        reasoning_tokens: ev.usage.completion_tokens_details?.reasoning_tokens || 0,
        finish_reason: 'stop',
      };
    }

    for (const choice of ev.choices || []) {
      const delta = choice.delta;

      // 文本内容
      if (delta.content) {
        yield { type: ChunkType.Text, text: delta.content };
      }

      // 推理内容（双形状容忍——DeepSeek thinking 模式 reasoning_content；
      //  OpenRouter 系网关 reasoning。2026-09-06 尸检：commandcodegoat 中转
      //  + deepseek-v4-flash 计费 reasoning_tokens 而纸面零夹注，同中转另一
      //  轮截获过 reasoning_content 全文——单字段解析是盲区，双形状齐认。
      //  同帧齐发时 content 优先（DeepSeek 官方语义）。
      const reasoningText = delta.reasoning_content ?? delta.reasoning;
      if (reasoningText) {
        yield { type: ChunkType.Reasoning, text: reasoningText };
      }

      // 工具调用
      if (delta.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          let tc = toolsByIndex.get(tcDelta.index);
          if (!tc) {
            tc = { id: '', name: '', arguments: '' };
            toolsByIndex.set(tcDelta.index, tc);
          }
          if (tcDelta.id) tc.id = tcDelta.id;
          if (tcDelta.function?.name) {
            tc.name = tcDelta.function.name;
            yield {
              type: ChunkType.ToolCallStart,
              tool_call: { id: tc.id, name: tc.name, arguments: '' },
            };
          }
          if (tcDelta.function?.arguments) {
            tc.arguments += tcDelta.function.arguments;
            // 流式写入预览：从部分 JSON 参数中提取内容
            const preview = extractWritePreview(tc.name, tc.arguments);
            if (preview) {
              yield {
                type: ChunkType.ToolArgPreview,
                tool_arg_preview: { tool_id: tc.id, tool_name: tc.name, content: preview },
              };
            }
          }
        }
      }

      // 完成原因 — 检测已完成的工具调用
      if (choice.finish_reason) {
        if (usage) {
          usage.finish_reason = choice.finish_reason;
        }
        // 输出已完成的工具调用
        for (const tc of toolsByIndex.values()) {
          yield {
            type: ChunkType.ToolCall,
            tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
          };
        }
        toolsByIndex.clear();
      }
    }

    // 在 choices 之后输出 usage（确保 finish_reason 正确）
    if (ev.usage && usage) {
      yield { type: ChunkType.Usage, usage };
    }
  }

  yield { type: ChunkType.Done };
}
