// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具参数流心跳（开放面契约 v68）—— 2026-11-22 卷 165「code_execution 无由来的重复调用」根治。
//
// 事故形态：模型要写一整篇文档（一个很大的 code_execution 程序）。工具头（id + 名字）先到，
// 参数在服务端逐 token 生成；三个方言的参数增量都**只累加、不产语义 chunk**，而空闲守卫
// （provider/idle-stream.ts，30s）只在**收到 chunk** 时复位计时 ⇒ 30 秒后判「服务商零字节」，
// 掐断整轮 → 重试 → 从零重新生成同一份大参数 → 再撞同一面墙（真机连掐三次，卷面堆四张空卡）。
//
// 本文件钉三件事：
//   ① 三方言在参数增量处发 Heartbeat（按 1s 节流），其余语义零漂移；
//   ② 心跳真的喂到空闲守卫：慢参数的流在短空闲阈值下不再被误杀；
//   ③ 节流器本身的语义（首次必发 / 间隔内不发 / 过期再发）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../src/plugins/builtin/llm-adapters/anthropic';
import { createOpenAIProvider } from '../src/plugins/builtin/llm-adapters/openai';
import { createResponsesProvider } from '../src/plugins/builtin/llm-adapters/responses';
import { ARG_ACTIVITY_BEAT_MS, makeArgActivityBeat } from '../src/plugins/builtin/llm-adapters/shared';
import { streamWithIdleTimeout } from '../src/provider/idle-stream';
import { resetProxyPort } from '../src/provider/transport';
import { type Chunk, ChunkType, type Request } from '../src/provider/types';

const mockInvoke = vi.fn(async () => '0');
vi.mock('../src/bridge', () => ({
  invoke: vi.fn(),
  rpc: (method: string) => mockInvoke(method),
  listen: vi.fn(),
  isMockMode: () => false,
}));

const REQ: Request = { messages: [{ role: 'user', content: 'q' }], tools: [], temperature: 0, max_tokens: 0 };

/** 按 `gapMs` 逐个吐事件的 SSE（gapMs=0 = 一次性吐完；>0 = 「参数慢慢流」的真机形态）。 */
function pacedSseResponse(events: Array<Record<string, unknown>>, gapMs: number): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      for (const e of events) {
        if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

let sseCalls: Array<{ events: Array<Record<string, unknown>>; gapMs: number }> = [];
const fetchMock = vi.fn<typeof fetch>(async () => {
  const next = sseCalls.shift() ?? { events: [], gapMs: 0 };
  return pacedSseResponse(next.events, next.gapMs);
});

/** openai 方言的一帧 tool_calls 增量。 */
function tcDelta(toolCalls: unknown[]): Record<string, unknown> {
  return { choices: [{ delta: { tool_calls: toolCalls } }] };
}

function heartbeats(chunks: Chunk[]): number {
  return chunks.filter((c) => c.type === ChunkType.Heartbeat).length;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  sseCalls = [];
  resetProxyPort();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('参数流心跳 — 节流器语义', () => {
  it('首次必发；间隔内不发；过期再发（间隔 = 常量的缺省值）', () => {
    expect(ARG_ACTIVITY_BEAT_MS).toBe(1000);
    let now = 10_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const beat = makeArgActivityBeat();
      expect(beat()).toBe(true); // 首帧
      now += ARG_ACTIVITY_BEAT_MS - 1;
      expect(beat()).toBe(false);
      now += 1;
      expect(beat()).toBe(true); // 满了间隔
      now += ARG_ACTIVITY_BEAT_MS - 1;
      expect(beat()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('参数流心跳 — 三方言都发（非 write/edit 的 code_execution 形态）', () => {
  it('openai：function.arguments 增量 → Heartbeat；ToolCall 参数不漂移', async () => {
    const prov = createOpenAIProvider({ name: 'beat-openai', apiKey: 'k', baseUrl: 'http://x.test/v1', model: 'm' });
    sseCalls = [
      {
        gapMs: 0,
        events: [
          tcDelta([{ index: 0, id: 'call_beat', function: { name: 'code_execution', arguments: '' } }]),
          tcDelta([{ index: 0, function: { arguments: '{"code":"a' } }]),
          tcDelta([{ index: 0, function: { arguments: 'b"}' } }]),
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ],
      },
    ];
    const chunks: Chunk[] = [];
    for await (const c of prov.stream(new AbortController().signal, REQ)) chunks.push(c);

    expect(heartbeats(chunks)).toBeGreaterThanOrEqual(1);
    // 节流生效：参数增量多于一次，心跳不会一帧一条
    expect(heartbeats(chunks)).toBeLessThan(3);
    const call = chunks.find((c) => c.type === ChunkType.ToolCall)?.tool_call;
    expect(call?.arguments).toBe('{"code":"ab"}');
  });

  it('anthropic：input_json_delta → Heartbeat', async () => {
    const prov = createAnthropicProvider({ name: 'beat-anthropic', apiKey: 'k', baseUrl: 'http://x.test', model: 'm' });
    sseCalls = [
      {
        gapMs: 0,
        events: [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_beat', name: 'code_execution' },
          },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"code":"x"}' } },
          { type: 'content_block_stop', index: 0 },
        ],
      },
    ];
    const chunks: Chunk[] = [];
    for await (const c of prov.stream(new AbortController().signal, REQ)) chunks.push(c);

    expect(heartbeats(chunks)).toBeGreaterThanOrEqual(1);
    expect(chunks.find((c) => c.type === ChunkType.ToolCall)?.tool_call?.arguments).toBe('{"code":"x"}');
  });

  it('responses：function_call_arguments.delta → Heartbeat', async () => {
    const prov = createResponsesProvider({ name: 'beat-responses', apiKey: 'k', baseUrl: 'http://x.test', model: 'm' });
    sseCalls = [
      {
        gapMs: 0,
        events: [
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', call_id: 'call_beat', name: 'code_execution' },
          },
          { type: 'response.function_call_arguments.delta', output_index: 0, partial_json: '{"code":"y"}' },
          { type: 'response.completed', response: {} },
        ],
      },
    ];
    const chunks: Chunk[] = [];
    for await (const c of prov.stream(new AbortController().signal, REQ)) chunks.push(c);

    expect(heartbeats(chunks)).toBeGreaterThanOrEqual(1);
    expect(chunks.find((c) => c.type === ChunkType.ToolCall)?.tool_call?.arguments).toBe('{"code":"y"}');
  });
});

describe('参数流心跳 — 接到空闲守卫（卷 165 的真机时序）', () => {
  it('参数慢慢流（每 100ms 一帧、共 1.5s）在 1.8s 空闲阈值下不再被误杀', async () => {
    const prov = createOpenAIProvider({ name: 'beat-slow', apiKey: 'k', baseUrl: 'http://x.test/v1', model: 'm' });
    const events: Array<Record<string, unknown>> = [
      tcDelta([{ index: 0, id: 'call_slow', function: { name: 'code_execution', arguments: '' } }]),
    ];
    for (let i = 0; i < 14; i++) events.push(tcDelta([{ index: 0, function: { arguments: 'x' } }]));
    events.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    sseCalls = [{ events, gapMs: 100 }];

    const wrapped = streamWithIdleTimeout(prov, new AbortController().signal, REQ, 1800);
    const chunks: Chunk[] = [];
    for await (const c of wrapped.chunks) chunks.push(c);

    expect(wrapped.idleTimedOut).toBe(false);
    expect(heartbeats(chunks)).toBeGreaterThanOrEqual(1);
    expect(chunks.find((c) => c.type === ChunkType.ToolCall)?.tool_call?.id).toBe('call_slow');
  }, 15_000);
});
