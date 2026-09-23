// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Responses API 协议级守护（provider-refactor 方案乙 Phase 2）：
// 手写协议必须配协议级测试（INVARIANTS #6 精神）——钉住请求构建形状
// （buildResponsesRequest）与完整 provider 流的 SSE 事件映射。

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildResponsesRequest, createResponsesProvider } from '../src/provider/responses';
import { resetProxyPort } from '../src/provider/transport';
import { ChunkType, type Request } from '../src/provider/types';

// ── 传输桩：llm_proxy_port 返回 0 → proxyFetch 直连 → global fetch mock 捕获 ──
const mockInvoke = vi.fn(async () => '0');
vi.mock('../src/bridge', () => ({
  invoke: vi.fn(),
  rpc: (method: string) => mockInvoke(method),
  listen: vi.fn(),
  isMockMode: () => false,
}));

function sseBody(events: Array<Record<string, unknown>>): Response {
  const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(sse));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 待回放事件队列：每次 fetch 消费一组 SSE 事件（shift）。 */
let sseCalls: Array<Array<Record<string, unknown>>> = [];

const fetchMock = vi.fn<typeof fetch>(async () => {
  const events = sseCalls.shift() ?? [];
  return sseBody(events);
});

describe('buildResponsesRequest（Responses 协议请求形状）', () => {
  it('system 消息合并为 instructions，不进 input', () => {
    const req = buildResponsesRequest(
      [
        { role: 'system', content: '你是助手' },
        { role: 'system', content: '第二段' },
        { role: 'user', content: 'hi' },
      ],
      [],
      'gpt-5.6-sol',
      8000,
      undefined,
    );
    expect(req.instructions).toBe('你是助手\n第二段');
    expect(req.input).toHaveLength(1);
    expect(req.input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(req.model).toBe('gpt-5.6-sol');
    expect(req.stream).toBe(true);
    expect(req.max_output_tokens).toBe(8000);
  });

  it('user 消息 → message item，input_text content', () => {
    const req = buildResponsesRequest([{ role: 'user', content: 'hello' }], [], 'm', 100, undefined);
    expect(req.input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    });
  });

  it('assistant tool_calls → **顶层** function_call item（官方 schema：非 message 子字段）', () => {
    const req = buildResponsesRequest(
      [
        {
          role: 'assistant',
          content: 'let me check',
          tool_calls: [{ id: 'call_1', name: 'fs', arguments: '{"action":"read"}' }],
        },
      ],
      [],
      'm',
      100,
      undefined,
    );
    expect(req.input[0]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'input_text', text: 'let me check' }],
    });
    expect(req.input[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'fs',
      arguments: '{"action":"read"}',
    });
  });

  it('tool 消息 → function_call_output item（字段名 output，schema 无 output_text）', () => {
    const req = buildResponsesRequest(
      [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', name: 'fs', arguments: '{}' }],
        },
        { role: 'tool', content: 'file contents', tool_call_id: 'call_1', name: 'fs' },
      ],
      [],
      'm',
      100,
      undefined,
    );
    expect(req.input[1]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'fs', arguments: '{}' });
    expect(req.input[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'file contents',
    });
  });

  it('留档 output items 原样回放（reasoning 项在前、与 function_call 相邻）', () => {
    const items = [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: '想过' }],
        encrypted_content: 'enc-blob',
        status: 'completed',
      },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'fs', arguments: '{"a":1}', status: 'completed' },
    ];
    const req = buildResponsesRequest(
      [
        { role: 'user', content: '问' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', name: 'fs', arguments: '{"a":1}' }],
          responses_items: items,
        },
        { role: 'tool', content: 'ok', tool_call_id: 'call_1', name: 'fs' },
      ],
      [],
      'm',
      100,
      undefined,
    );
    // 逐字段原样（含 id / encrypted_content / status）——漏 reasoning 项 = 400
    expect(req.input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(req.input[1]).toEqual(items[0]);
    expect(req.input[2]).toEqual(items[1]);
    expect(req.input[3]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'ok' });
    // 留档里已有该 function_call → 不再补合成项（不重复）
    expect(req.input.filter((it) => it.type === 'function_call')).toHaveLength(1);
  });

  it('留档缺 message 项的正文 / 缺 function_call 的调用 → 各自补齐（不丢正文、不悬空配对）', () => {
    const req = buildResponsesRequest(
      [
        { role: 'user', content: '问' },
        {
          role: 'assistant',
          content: '回答正文',
          tool_calls: [{ id: 'call_9', name: 'fs', arguments: '{}' }],
          // 只有 reasoning 项（function_call 的 done 没到、message 项也缺）
          responses_items: [{ type: 'reasoning', id: 'rs_9', summary: [] }],
        },
        { role: 'tool', content: 'ok', tool_call_id: 'call_9', name: 'fs' },
      ],
      [],
      'm',
      100,
      undefined,
    );
    expect(req.input[1]).toMatchObject({ type: 'reasoning', id: 'rs_9' });
    expect(req.input[2]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'input_text', text: '回答正文' }],
    });
    expect(req.input[3]).toEqual({ type: 'function_call', call_id: 'call_9', name: 'fs', arguments: '{}' });
  });

  it('回放时剥掉 output_text 的 logprobs（逐 token 概率不进卷、不回放）', () => {
    const req = buildResponsesRequest(
      [
        {
          role: 'assistant',
          content: '答',
          responses_items: [
            {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: '答', annotations: [], logprobs: [{ token: 'a' }] }],
            },
          ],
        },
      ],
      [],
      'm',
      100,
      undefined,
    );
    expect(req.input[0]).toEqual({
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '答', annotations: [] }],
    });
  });

  it('tools → 平铺 type/name/description/parameters（非 chat function 嵌套）', () => {
    const req = buildResponsesRequest(
      [{ role: 'user', content: 'hi' }],
      [
        {
          name: 'fs',
          description: 'file ops',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      'm',
      100,
      undefined,
    );
    expect(req.tools).toEqual([
      {
        type: 'function',
        name: 'fs',
        description: 'file ops',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
  });

  it('命名思考档位 → reasoning.effort（canonical 原值）', () => {
    const req = buildResponsesRequest([{ role: 'user', content: 'hi' }], [], 'm', 100, 'high');
    expect(req.reasoning).toEqual({ effort: 'high' });
  });

  it("思考 'off'/'auto'/数字遗留 → 不下发 reasoning（Responses 无关闭方言）", () => {
    expect(buildResponsesRequest([{ role: 'user', content: 'hi' }], [], 'm', 100, 'off').reasoning).toBeUndefined();
    expect(buildResponsesRequest([{ role: 'user', content: 'hi' }], [], 'm', 100, '').reasoning).toBeUndefined();
    expect(buildResponsesRequest([{ role: 'user', content: 'hi' }], [], 'm', 100, '8000').reasoning).toBeUndefined();
  });

  it('max_output_tokens：maxTok 缺省回落默认上限', () => {
    const req = buildResponsesRequest([{ role: 'user', content: 'hi' }], [], 'm', 0, undefined);
    expect(req.max_output_tokens).toBeGreaterThan(0);
  });

  it('无状态请求形状：store:false + include reasoning.encrypted_content（Codex 同款）', () => {
    const req = buildResponsesRequest([{ role: 'user', content: 'hi' }], [], 'm', 100, undefined);
    expect(req.store).toBe(false);
    expect(req.include).toEqual(['reasoning.encrypted_content']);
  });

  it('孤立 tool 结果前置空 user 消息防 400（input 首条不可为 function_call_output）', () => {
    const req = buildResponsesRequest(
      [{ role: 'tool', content: 'out', tool_call_id: 'c1', name: 'fs' }],
      [],
      'm',
      100,
      undefined,
    );
    expect(req.input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(req.input[1]).toMatchObject({ type: 'function_call_output', call_id: 'c1' });
  });
});

describe('createResponsesProvider stream（SSE 解析端到端）', () => {
  const prov = createResponsesProvider({
    name: 'resp1',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
  });

  function req(): Request {
    return { messages: [{ role: 'user', content: 'q' }], tools: [], temperature: 0, max_tokens: 0 };
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    resetProxyPort();
    sseCalls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function collect(events: Array<Record<string, unknown>>) {
    sseCalls = [events];
    const chunks = [];
    for await (const c of prov.stream(new AbortController().signal, req())) chunks.push(c);
    return chunks;
  }

  it('文本流：output_text.delta → Text；completed → Usage + Done', async () => {
    const chunks = await collect([
      { type: 'response.output_text.delta', delta: '你好' },
      { type: 'response.output_text.delta', delta: '世界' },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens_details: { reasoning_tokens: 5 },
          },
        },
      },
    ]);
    expect(
      chunks
        .filter((c) => c.type === ChunkType.Text)
        .map((c) => c.text)
        .join(''),
    ).toBe('你好世界');
    const usage = chunks.find((c) => c.type === ChunkType.Usage);
    expect(usage?.usage?.prompt_tokens).toBe(10);
    expect(usage?.usage?.completion_tokens).toBe(20);
    expect(usage?.usage?.cache_hit_tokens).toBe(4);
    expect(usage?.usage?.cache_miss_tokens).toBe(6);
    expect(usage?.usage?.reasoning_tokens).toBe(5);
    expect(chunks[chunks.length - 1].type).toBe(ChunkType.Done);
  });

  it('思考流：reasoning_summary_text.delta / reasoning_text.delta → Reasoning chunk', async () => {
    const chunks = await collect([
      { type: 'response.reasoning_summary_text.delta', delta: '思考中' },
      { type: 'response.reasoning_text.delta', delta: '更多思考' },
      { type: 'response.completed', response: {} },
    ]);
    expect(
      chunks
        .filter((c) => c.type === ChunkType.Reasoning)
        .map((c) => c.text)
        .join(''),
    ).toBe('思考中更多思考');
  });

  it('工具调用：added → ToolCallStart（配对键取 call_id）；arguments.delta 累积 → completed flush', async () => {
    const chunks = await collect([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc_1', call_id: 'call_1', type: 'function_call', name: 'fs' },
      },
      { type: 'response.function_call_arguments.delta', output_index: 0, partial_json: '{"action":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, partial_json: '"read"}' },
      { type: 'response.completed', response: {} },
    ]);
    const starts = chunks.filter((c) => c.type === ChunkType.ToolCallStart);
    expect(starts).toHaveLength(1);
    // call_id（call_…）才是与 function_call_output 的配对键——item.id（fc_…）不是
    expect(starts[0].tool_call).toEqual({ id: 'call_1', name: 'fs', arguments: '' });
    const full = chunks.find((c) => c.type === ChunkType.ToolCall);
    expect(full?.tool_call).toEqual({ id: 'call_1', name: 'fs', arguments: '{"action":"read"}' });
    expect(chunks[chunks.length - 1].type).toBe(ChunkType.Done);
  });

  it('output items 留档：reasoning 项取 done 那一份，随 completed 的 response.output 上行', async () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: '想过' }],
      encrypted_content: 'enc-from-done',
      status: 'completed',
    };
    const call = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'fs',
      arguments: '{}',
      status: 'completed',
    };
    const chunks = await collect([
      // added 里的 reasoning 可能不完整——不得作为留档
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: '' },
      },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_1', call_id: 'call_1', type: 'function_call', name: 'fs' },
      },
      { type: 'response.output_item.done', output_index: 1, item: call },
      { type: 'response.completed', response: { output: [reasoning, call] } },
    ]);
    const items = chunks.find((c) => c.type === ChunkType.ResponsesItems);
    expect(items?.responses_items).toEqual([reasoning, call]);
    // Done 是最后一块（留档块在其之前）
    expect(chunks[chunks.length - 1].type).toBe(ChunkType.Done);
  });

  it('completed 未带 response.output → 回落 output_item.done 累积（按 output_index 排序）', async () => {
    const a = { type: 'reasoning', id: 'rs_a', summary: [] };
    const b = { type: 'message', id: 'msg_b', role: 'assistant', content: [{ type: 'output_text', text: '答' }] };
    const chunks = await collect([
      { type: 'response.output_item.done', output_index: 1, item: b },
      { type: 'response.output_item.done', output_index: 0, item: a },
      { type: 'response.completed', response: {} },
    ]);
    const items = chunks.find((c) => c.type === ChunkType.ResponsesItems);
    expect(items?.responses_items).toEqual([a, b]);
  });

  it('failed 事件 → Error chunk（带 code），流终止', async () => {
    const chunks = await collect([
      { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } },
    ]);
    expect(chunks[0].type).toBe(ChunkType.Error);
    expect(String(chunks[0].err?.message ?? '')).toContain('slow down');
    expect(chunks).toHaveLength(1);
  });

  it('error 事件（平台 error type）→ Error chunk', async () => {
    const chunks = await collect([{ type: 'error', error: { message: 'bad request', code: 'invalid_request' } }]);
    expect(chunks[0].type).toBe(ChunkType.Error);
    expect(chunks).toHaveLength(1);
  });

  it('流意外结束（无 completed）→ flush 残留 tool_call + Done', async () => {
    const chunks = await collect([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc_2', type: 'function_call', name: 'fs' },
      },
      { type: 'response.function_call_arguments.delta', output_index: 0, partial_json: '{}' },
    ]);
    const full = chunks.find((c) => c.type === ChunkType.ToolCall);
    expect(full?.tool_call).toEqual({ id: 'fc_2', name: 'fs', arguments: '{}' });
    expect(chunks[chunks.length - 1].type).toBe(ChunkType.Done);
  });
});
