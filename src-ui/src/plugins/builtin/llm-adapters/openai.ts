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
  thinkingCapability,
  thinkingWireFor,
} from './host';
import { sendWithRetry } from './retry';
import {
  ARG_PREVIEW_BEAT_MS,
  extractCodePreview,
  extractWritePreview,
  fetchJsonWithTimeout,
  makeArgActivityBeat,
  mergeHeaders,
  modelsFetchFailure,
  prewarmEndpoint,
  type SseEvent,
  type SseLogMeta,
  sentCredential,
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
      const url = `${baseUrl}/chat/completions`;
      const response = await sendWithRetry({
        url,
        headers: mergeHeaders(customHeaders, {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          // ⚡ 空 Key 不发 Authorization（2026-09-28 无 Key 放行批）：本地端点
          //   （Ollama / LM Studio 等）无鉴权，而空 `Bearer ` 会被部分网关判成
          //   「提供了无效凭据」（401）而不是「没提供」——不发才是诚实的形态。
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        }),
        body: JSON.stringify(body),
        signal,
        name,
        // 日志接缝（批 2）：出网四相的身份面（模型/方言/工具数）
        meta: { model, kind: 'openai', tools: req.tools?.length },
      });

      if (!response.body) throw new Error(`${name}: no response body`);

      yield* readSSE(response.body, name, signal, { model, kind: 'openai', url });
    },

    prewarm(): void {
      prewarmEndpoint(
        `${baseUrl}/models`,
        mergeHeaders(customHeaders, { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }),
      );
    },

    async fetchModels(): Promise<ModelDescriptor[]> {
      const headers = mergeHeaders(customHeaders, { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) });
      const { json, status } = await fetchJsonWithTimeout(`${baseUrl}/models`, headers, 10000);
      // C5（2026-08-27）：目录失败面——fetchJsonWithTimeout 对非 ok/网络/超时
      // 一律给 null，此前被静默当成「无模型」（调用面 .catch(() => {}) 永不
      // 触发，用户完全无感）。上抛让调用面可记失败（compact 选择器分组头标注 /
      // 手动刷新报真实原因）；静态目录 + 已合并的 last-good 动态模型兜底，不因
      // 失败丢失。
      // ⚡ 2026-09-28：无 Key 行被 401/403 拒 → 文案点名「本行没有 API Key」
      //   （modelsFetchFailure 的 keyless 支）；其余形态沿用既有文案。
      if (!json) throw new Error(modelsFetchFailure(name, status, !sentCredential(headers)));
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
  reasoning_effort?: string;
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
  // reasoningDisabled（用户显式声明不推理）时，行级默认档位也不得下发。
  const level = isThinkingMode(stored) && resolved?.reasoningDisabled !== true ? stored : '';
  const declaredWire = thinkingWireFor(resolved, level);
  let thinkingBlock: ChatRequest['thinking'];
  let effort: ChatRequest['reasoning_effort'];
  if (declaredWire !== undefined) {
    // 用户自定义推理等级（2026-10-22 对齐 DSH）：值即请求里的 API 参数原样；
    // off:null = 该档不发送参数（不编造包裹）。
    if (declaredWire !== null) {
      if (level !== 'off' && cap.deepseekWrap) thinkingBlock = { type: 'enabled' };
      effort = declaredWire;
    }
  } else if (level === 'off') {
    if (cap.off) {
      if (cap.deepseekWrap) thinkingBlock = { type: 'disabled' };
      else effort = 'none';
    }
  } else if (level !== '') {
    if (cap.deepseekWrap) thinkingBlock = { type: 'enabled' };
    effort = level;
  }
  const chatMsgs: ChatMessage[] = [];

  // 工具附图通道 P0a（docs/archive/render-paper-line/tool-image-context-plan.md）：OpenAI 兼容 chat 的
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

async function* readSSE(
  body: ReadableStream<Uint8Array>,
  name: string,
  signal?: AbortSignal,
  obsMeta?: SseLogMeta,
): AsyncGenerator<Chunk> {
  /* ⚡ 累加器按 (index, id) 认——**不是**按 index 唯一（2026-11-20「工具卡片卡在
   *  运行态」真机根因）：OpenAI 兼容网关会在一轮里放多个 tool_calls，而它们的
   *  `index` 可能相同（真机 amr-link 网关实测：两个 fs(edit) 调用都带 index 0，
   *  另有整轮缺省 index 的形态）。旧实现按 index 建唯一累加器，后果两连：
   *    ① 第二个调用的 id/name 覆盖同一个累加器 ⇒ 第一个调用**只发过
   *       ToolCallStart**，永远等不到自己的 ToolCall/结果 ⇒ 卡片停在「行 Ns」；
   *    ② 两个调用的 arguments 拼成一条 ⇒ JSON.parse 失败（真机原文
   *       「Unexpected non-whitespace character after JSON at position 1272」，
   *       错误窗口里两段 `{"action": "edit"…}` 首尾相接）。
   *  判据：**id 变了就是另一个调用**（id 是模型生成的调用身份，index 只是增量
   *  的槽位提示）。同 id 的后续增量照旧累加；同 index 不同 id 另起一条。 */
  interface ToolAcc {
    index: number;
    id: string;
    name: string;
    arguments: string;
    /** 已发过 ToolCallStart（name 到齐那一拍）——同 id 后续 name 增量不再补发。 */
    started: boolean;
  }
  /** 在途累加器：按**出现序**排（= 调用序，也是 ToolCall 的发射序）。 */
  const pending: ToolAcc[] = [];
  /** 参数流心跳（v68）：参数增量不产语义 chunk，长参数的生成会被空闲守卫误判成
   *  「服务商零字节」（卷 165）。按节流发 Heartbeat 复位守卫计时。 */
  const argBeat = makeArgActivityBeat();
  /** 程序体预览节流（v68 后续）：预览是 O(args) 的正则 + 反转义，且每帧重渲染折叠行。 */
  const codePreviewBeat = makeArgActivityBeat(ARG_PREVIEW_BEAT_MS);
  /** 单条调用的终值事件（收尾统一发射）。 */
  const flushOne = (acc: ToolAcc): Chunk => ({
    type: ChunkType.ToolCall,
    tool_call: { id: acc.id, name: acc.name, arguments: acc.arguments },
  });
  let usage: Chunk['usage'];

  for await (const ev of sseEvents<OpenAiSseEvent>(body, name, signal, obsMeta)) {
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
          const idx = tcDelta.index ?? 0;
          /* 归属判据 = **id**（index 只是槽位提示，网关会给出重复的）：
           *   · 带 id 且与在途某条不同 ⇒ 另起一条（并行调用，哪怕 index 相同）；
           *   · 带 id 且命中在途某条 ⇒ 认领它（少数实现只首帧带 id）；
           *   · 不带 id ⇒ 归给同 index 最近一条在途调用（标准增量形态）。 */
          let tc: ToolAcc | undefined;
          if (tcDelta.id) {
            tc = pending.find((p) => p.id === tcDelta.id);
            if (!tc) {
              /* 先到的匿名条目（首帧没带 id 的实现）就地认领——否则同一个调用会
               * 留下一条 id 为空的条目，收尾时多画一张无身份卡片。只认「同 index
               * 且 id 仍为空」的那条，已有 id 的绝不改认。 */
              const anon = pending.find((p) => p.index === idx && p.id === '');
              if (anon) {
                anon.id = tcDelta.id;
                tc = anon;
              } else {
                tc = { index: idx, id: tcDelta.id, name: '', arguments: '', started: false };
                pending.push(tc);
              }
            }
          } else {
            for (let i = pending.length - 1; i >= 0; i--) {
              if (pending[i].index === idx) {
                tc = pending[i];
                break;
              }
            }
            if (!tc) {
              tc = { index: idx, id: '', name: '', arguments: '', started: false };
              pending.push(tc);
            }
          }
          if (tcDelta.function?.name) tc.name = tcDelta.function.name;
          // ToolCallStart 只在**身份（id）+ 名字都到齐**时发一次：UI 靠它建卡，
          // 卡的身份必须与最终 ToolCall 的 id 一致——先发一张 id 为空的卡再补发
          // 真 id，旧卡就永远没人认领（正是本批要根治的那种「卡住」）。
          // 重复发同样有害（旧实现每个 name 增量发一次 = 同一个调用画两遍）。
          if (!tc.started && tc.name && tc.id) {
            tc.started = true;
            yield {
              type: ChunkType.ToolCallStart,
              tool_call: { id: tc.id, name: tc.name, arguments: '' },
            };
          }
          if (tcDelta.function?.arguments) {
            tc.arguments += tcDelta.function.arguments;
            // 参数流心跳：让空闲守卫看见「数据还在来」（与预览无关——code_execution
            // 这类非 write/edit 工具永远走不到下面的预览分支）。
            if (argBeat()) yield { type: ChunkType.Heartbeat };
            // 流式写入预览：从部分 JSON 参数中提取内容
            const preview = extractWritePreview(tc.name, tc.arguments);
            if (preview) {
              yield {
                type: ChunkType.ToolArgPreview,
                tool_arg_preview: { tool_id: tc.id, tool_name: tc.name, content: preview },
              };
            } else if (tc.name === 'code_execution' && codePreviewBeat()) {
              // 程序体流式预览（2026-11-22 卷 165 后续）：大程序的参数一生成就是几十秒，
              // 折叠着的程文卡只能看到折叠行——把已生成部分送去展示（折叠行显示最后一行）。
              const code = extractCodePreview(tc.name, tc.arguments);
              if (code !== null) {
                yield {
                  type: ChunkType.ToolArgPreview,
                  tool_arg_preview: { tool_id: tc.id, tool_name: tc.name, content: code },
                };
              }
            }
          }
        }
      }

      // 完成原因 — 检测已完成的工具调用
      if (choice.finish_reason) {
        if (usage) {
          usage.finish_reason = choice.finish_reason;
        }
        // 输出已完成的工具调用（出现序 = 调用序，与 provider 的 index 无关）
        for (const tc of pending) {
          yield flushOne(tc);
        }
        pending.length = 0;
      }
    }

    // 在 choices 之后输出 usage（确保 finish_reason 正确）
    if (ev.usage && usage) {
      yield { type: ChunkType.Usage, usage };
    }
  }

  yield { type: ChunkType.Done };
}
