// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 真 socket 测试层（P14）— 本地 node:http SSE server 走完整 provider 链路：
// createProvider → stream → proxyFetch（测试环境无 Tauri → 自动直连）→
// sendWithRetry → sseEvents → Chunk 协议。
//
// 与 fetch mock 测试的本质区别：SSE 分块边界由真 TCP 写缓冲决定（一次 write
// 可能粘连两帧 / 帧可能被拆半），CORS/头部编码等网络层问题只有真 socket 才暴露。
// 背景（provider-system-spec.md P13）：全仓库测试 mock 了 fetch，从未真机跑通
// 一条真实 LLM 调用——代码全绿但真实链路从未打通。本层补的是「协议栈过真
// socket」这一段；真机对厂商端点的回归（P3）仍需人工跑。

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/plugins/builtin/llm-adapters/anthropic';
import { createOpenAIProvider } from '../src/plugins/builtin/llm-adapters/openai';
import { STREAM_IDLE_TIMEOUT_MS, streamWithIdleTimeout } from '../src/provider/idle-stream';
import { type Chunk, ChunkType } from '../src/provider/types';

/** 起一个本地 SSE server。handler 收到 (req body, res writer helper)。 */
function startServer(
  handler: (
    body: string,
    sse: (payload: string) => void,
    res: http.ServerResponse,
    rawReq: http.IncomingMessage,
  ) => void,
): Promise<{ server: http.Server; url: string; requests: { body: string; headers: http.IncomingHttpHeaders }[] }> {
  const requests: { body: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ body, headers: { ...req.headers } });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const sse = (payload: string) => res.write(`data: ${payload}\n\n`);
      handler(body, sse, res, req);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

async function collect(gen: AsyncGenerator<Chunk>): Promise<Chunk[]> {
  const out: Chunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('真 socket — OpenAI 兼容流式全链路', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    srv = await startServer((body, sse, res) => {
      const req = JSON.parse(body);
      if (req.model === 'err-model') {
        sse(JSON.stringify({ error: { message: 'insufficient balance' } }));
        res.end();
        return;
      }
      if (req.model === 'reasoning-variant-model') {
        // 网关方言（2026-09-06 尸检）：思考文本在 delta.reasoning（OpenRouter 系），
        // 非 DeepSeek 的 delta.reasoning_content——usage 仍计 reasoning_tokens
        //（真机病灶形态：计费在、内容换字段名）。
        sse(JSON.stringify({ choices: [{ delta: { reasoning: 'variant-think' } }] }));
        sse(JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }));
        sse(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      // 模拟真实 SSE：一次 write 粘连两帧（TCP 缓冲语义）
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'he' } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'think…' } }] })}\n\n`,
      );
      sse(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"content":"' } }],
              },
            },
          ],
        }),
      );
      sse(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'hi"}' } }] } }] }));
      sse(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
      sse(
        JSON.stringify({
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 40 },
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        }),
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  afterAll(() => new Promise<void>((r) => srv.server.close(() => r())));

  it('文本/推理/工具调用/usage 全链路（声明档位 low 直连）', async () => {
    const prov = createOpenAIProvider({
      name: 'test-openai',
      apiKey: 'sk-test',
      baseUrl: srv.url,
      model: 'deepseek-v4-pro',
      thinking: 'low',
    });
    const chunks = await collect(
      prov.stream(new AbortController().signal, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        temperature: 0,
        max_tokens: 100,
      }),
    );

    const texts = chunks
      .filter((c) => c.type === ChunkType.Text)
      .map((c) => c.text)
      .join('');
    const reasoning = chunks
      .filter((c) => c.type === ChunkType.Reasoning)
      .map((c) => c.text)
      .join('');
    const toolCalls = chunks.filter((c) => c.type === ChunkType.ToolCall);
    const usage = chunks.find((c) => c.type === ChunkType.Usage)?.usage;
    const done = chunks.some((c) => c.type === ChunkType.Done);

    expect(texts).toBe('he');
    expect(reasoning).toBe('think…');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].tool_call).toMatchObject({ id: 'call_1', name: 'write_file', arguments: '{"content":"hi"}' });
    expect(usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 10, cache_hit_tokens: 40 });
    expect(usage?.finish_reason).toBe('tool_calls');
    expect(done).toBe(true);
  });

  it('思考字段双形状容忍（2026-09-06 尸检）：delta.reasoning 网关变体同产 Reasoning chunk', async () => {
    // 真机病灶：commandcodegoat 中转 + deepseek-v4-flash——usage 计 reasoning_tokens
    //（1303/411…）而纸面零夹注。同中转另一轮（reasoning_content 字段）截获过
    // 完整思考 → 解析只认单字段名是盲区。网关生态两形状并存（DeepSeek
    // reasoning_content / OpenRouter 系 reasoning），与 usage 双形状读取
    //（prompt_cache_hit_tokens ?? prompt_tokens_details.cached_tokens）同款惯例。
    const prov = createOpenAIProvider({
      name: 'test-openai',
      apiKey: 'sk-test',
      baseUrl: srv.url,
      model: 'reasoning-variant-model',
    });
    const chunks = await collect(
      prov.stream(new AbortController().signal, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        temperature: 0,
        max_tokens: 100,
      }),
    );
    const reasoning = chunks
      .filter((c) => c.type === ChunkType.Reasoning)
      .map((c) => c.text)
      .join('');
    const texts = chunks
      .filter((c) => c.type === ChunkType.Text)
      .map((c) => c.text)
      .join('');
    expect(reasoning).toBe('variant-think');
    expect(texts).toBe('ok');
    expect(chunks.some((c) => c.type === ChunkType.Done)).toBe(true);
  });

  it('wire 请求体：DeepSeek 声明驱动 thinking 包裹 + reasoning_effort low', async () => {
    const prov = createOpenAIProvider({
      name: 'test-openai',
      apiKey: 'sk-test',
      baseUrl: srv.url,
      model: 'deepseek-v4-pro',
      thinking: 'low',
    });
    await collect(
      prov.stream(new AbortController().signal, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        temperature: 0,
        max_tokens: 100,
      }),
    );
    const last = srv.requests[srv.requests.length - 1];
    const body = JSON.parse(last.body);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_tokens).toBe(100);
    // 真实 HTTP 头透传（Bearer 鉴权）
    expect(last.headers.authorization).toBe('Bearer sk-test');
  });

  it('流内 error 事件 → Error chunk（余额不足分类）', async () => {
    const prov = createOpenAIProvider({
      name: 'test-openai',
      apiKey: 'sk-test',
      baseUrl: srv.url,
      model: 'err-model',
    });
    const chunks = await collect(
      prov.stream(new AbortController().signal, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        temperature: 0,
        max_tokens: 100,
      }),
    );
    const err = chunks.find((c) => c.type === ChunkType.Error);
    expect(err?.err?.message).toContain('[余额不足]');
  });

  it('声明外档位（medium）→ 任何 socket I/O 之前抛错（服务器零请求）', async () => {
    const before = srv.requests.length;
    const prov = createOpenAIProvider({
      name: 'test-openai',
      apiKey: 'sk-test',
      baseUrl: srv.url,
      model: 'deepseek-v4-pro',
      thinking: 'medium',
    });
    await expect(
      collect(
        prov.stream(new AbortController().signal, {
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          temperature: 0,
          max_tokens: 100,
        }),
      ),
    ).rejects.toThrow(/不支持/);
    expect(srv.requests.length).toBe(before);
  });
});

describe('真 socket — Anthropic Messages 流式全链路', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    srv = await startServer((body, sse, res) => {
      const req = JSON.parse(body);
      if (req.model === 'err-model') {
        sse(JSON.stringify({ type: 'error', error: { message: 'overloaded' } }));
        res.end();
        return;
      }
      sse(
        JSON.stringify({
          type: 'message_start',
          message: {
            usage: { input_tokens: 50, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 0 },
          },
        }),
      );
      sse(
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' },
        }),
      );
      sse(
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":"' },
        }),
      );
      // 粘连帧：thinking_delta + signature_delta 一次 write
      res.write(
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'reason' } })}\n\n` +
          `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig1' } })}\n\n`,
      );
      sse(
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'a.ts"}' },
        }),
      );
      sse(JSON.stringify({ type: 'content_block_stop', index: 0 }));
      sse(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }));
      sse(JSON.stringify({ type: 'message_stop' }));
      res.end();
    });
  });

  afterAll(() => new Promise<void>((r) => srv.server.close(() => r())));

  it('message_start/工具流/思考签名/usage 全链路', async () => {
    const prov = createAnthropicProvider({
      name: 'test-anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: srv.url,
      model: 'claude-sonnet-4-6',
      thinking: 'high',
    });
    const chunks = await collect(
      prov.stream(new AbortController().signal, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        temperature: 0,
        max_tokens: 100,
      }),
    );

    const toolCalls = chunks.filter((c) => c.type === ChunkType.ToolCall);
    const reasoning = chunks.filter((c) => c.type === ChunkType.Reasoning);
    const usage = chunks.find((c) => c.type === ChunkType.Usage)?.usage;

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].tool_call).toMatchObject({ id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.ts"}' });
    expect(reasoning.map((c) => c.text || c.signature).join('')).toBe('reasonsig1');
    expect(usage).toMatchObject({
      prompt_tokens: 50,
      completion_tokens: 7,
      cache_hit_tokens: 20,
      cache_creation_tokens: 5,
      finish_reason: 'tool_calls',
    });
    expect(chunks.some((c) => c.type === ChunkType.Done)).toBe(true);
  });

  it('wire 请求体：thinking budget（high → 16000）+ x-api-key 头', async () => {
    const prov = createAnthropicProvider({
      name: 'test-anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: srv.url,
      model: 'claude-sonnet-4-6',
      thinking: 'high',
    });
    await collect(
      prov.stream(new AbortController().signal, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        temperature: 0,
        max_tokens: 100,
      }),
    );
    const last = srv.requests[srv.requests.length - 1];
    const body = JSON.parse(last.body);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    expect(last.headers['x-api-key']).toBe('sk-ant-test');
    expect(last.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('流内 error 事件 → Error chunk', async () => {
    const prov = createAnthropicProvider({
      name: 'test-anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: srv.url,
      model: 'err-model',
    });
    const chunks = await collect(
      prov.stream(new AbortController().signal, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        temperature: 0,
        max_tokens: 100,
      }),
    );
    const err = chunks.find((c) => c.type === ChunkType.Error);
    expect(err?.err?.message).toContain('[服务商繁忙]');
  });

  it('maxTokensFor 优先于目录（真 socket 钳制，per-model）', async () => {
    const prov = createAnthropicProvider({
      name: 'test-anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: srv.url,
      model: 'claude-sonnet-4-6',
      thinking: '',
      maxTokensFor: () => 777,
    });
    await collect(
      prov.stream(new AbortController().signal, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        temperature: 0,
        max_tokens: 999999,
      }),
    );
    const body = JSON.parse(srv.requests[srv.requests.length - 1].body);
    expect(body.max_tokens).toBe(777);
  });
});

describe('真 socket — 空闲超时（idle-stream）', () => {
  it('30s 无 chunk → 中止并标记 idleTimedOut（测试用 50ms 短超时）', async () => {
    const srv2 = await startServer((_body, _sse, res) => {
      // 挂死流：开头发一帧，然后永远不出数据
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'stuck' } }] })}\n\n`);
      // 不 end —— 模拟上游挂起
    });
    try {
      const prov = createOpenAIProvider({
        name: 'stuck',
        apiKey: 'sk-test',
        baseUrl: srv2.url,
        model: 'deepseek-v4-pro',
      });
      const wrapped = streamWithIdleTimeout(
        prov,
        new AbortController().signal,
        { messages: [{ role: 'user', content: 'hi' }], tools: [], temperature: 0, max_tokens: 100 },
        50,
      );
      const chunks: Chunk[] = [];
      await expect(async () => {
        for await (const c of wrapped.chunks) chunks.push(c);
      }).rejects.toThrow();
      expect(wrapped.idleTimedOut).toBe(true);
      expect(chunks.some((c) => c.type === ChunkType.Text)).toBe(true); // 卡住前的帧已收到
    } finally {
      srv2.server.close();
    }
  });

  it('默认超时常量 = 30s（回归钉子）', () => {
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(30_000);
  });
});
