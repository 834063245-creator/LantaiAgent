// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// code_execution 程序体流式预览（2026-11-22 卷 165 后续）。
//
// 缺口：程序的参数可能上万字符、生成 30 秒以上。折叠着的程文卡在此期间只有折叠行可见，
// 用户读作「卡在 code_execution pending」。修法 = 三方言在参数流期间把**已生成的部分
// 程序体**按 ARG_PREVIEW_BEAT_MS（120ms）节流送成 ToolArgPreview（与 write/edit 的
// content 预览同一条通道、同一个 chunk 类型）；展示面把它写进 part.preview，折叠行
// 显示最新一行。
//
// 本文件钉三件事：
//   ① 三方言都发（openai / anthropic / responses），且内容是**已生成的部分程序体**；
//   ② 节流生效：一帧 burst（同一毫秒内到齐的多段参数）只发一条预览，不按 token 刷屏；
//   ③ 既有语义零漂移：最终 ToolCall 的 arguments 一字不差。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../src/plugins/builtin/llm-adapters/anthropic';
import { createOpenAIProvider } from '../src/plugins/builtin/llm-adapters/openai';
import { createResponsesProvider } from '../src/plugins/builtin/llm-adapters/responses';
import { ARG_PREVIEW_BEAT_MS, extractCodePreview } from '../src/plugins/builtin/llm-adapters/shared';
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

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(body));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

let sseCalls: Array<Array<Record<string, unknown>>> = [];
const fetchMock = vi.fn<typeof fetch>(async () => sseResponse(sseCalls.shift() ?? []));

function tcDelta(toolCalls: unknown[]): Record<string, unknown> {
  return { choices: [{ delta: { tool_calls: toolCalls } }] };
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

describe('extractCodePreview — 部分 JSON 里抠程序体', () => {
  it('code_execution：只认 code 键，反转义 + 去尾垃圾', () => {
    expect(extractCodePreview('code_execution', '{"code":"const a = 1;\\nconst b = 2;"')).toBe(
      'const a = 1;\nconst b = 2;',
    );
    // 未闭合的部分 JSON 同样可用（流式中途的常态）
    expect(extractCodePreview('code_execution', '{"code":"await tools.fs({ action: \\"read\\"')).toBe(
      'await tools.fs({ action: "read"',
    );
  });

  it('别的工具 / 没有 code 键 → null（不误伤 write 预览）', () => {
    expect(extractCodePreview('fs', '{"action":"write","content":"x"}')).toBeNull();
    expect(extractCodePreview('code_execution', '{"description":"先列目录"')).toBeNull();
  });
});

describe('三方言 — 程序体预览', () => {
  it('openai：参数增量 → ToolArgPreview（节流：一个 burst 只发一条）', async () => {
    const prov = createOpenAIProvider({ name: 'prev-openai', apiKey: 'k', baseUrl: 'http://x.test/v1', model: 'm' });
    sseCalls = [
      [
        tcDelta([
          { index: 0, id: 'call_code', function: { name: 'code_execution', arguments: '{"code":"const a = 1;\\n' } },
        ]),
        tcDelta([{ index: 0, function: { arguments: 'const b = 2;\\n' } }]),
        tcDelta([{ index: 0, function: { arguments: 'return a + b;"}' } }]),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ],
    ];
    const chunks: Chunk[] = [];
    for await (const c of prov.stream(new AbortController().signal, REQ)) chunks.push(c);

    const previews = chunks.filter((c) => c.type === ChunkType.ToolArgPreview);
    // 同一毫秒里到齐的三段参数：节流门只开一次（不按 token 刷屏）
    expect(previews).toHaveLength(1);
    expect(previews[0]?.tool_arg_preview?.tool_id).toBe('call_code');
    expect(previews[0]?.tool_arg_preview?.content).toBe('const a = 1;\n');
    expect(ARG_PREVIEW_BEAT_MS).toBe(120);
    // 终值不漂：完整 arguments 一字不差
    expect(chunks.find((c) => c.type === ChunkType.ToolCall)?.tool_call?.arguments).toBe(
      '{"code":"const a = 1;\\nconst b = 2;\\nreturn a + b;"}',
    );
  });

  it('anthropic：input_json_delta → ToolArgPreview', async () => {
    const prov = createAnthropicProvider({ name: 'prev-anthropic', apiKey: 'k', baseUrl: 'http://x.test', model: 'm' });
    sseCalls = [
      [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call_code', name: 'code_execution' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"code":"x = 1;\\ny = 2;' },
        },
        { type: 'content_block_stop', index: 0 },
      ],
    ];
    const chunks: Chunk[] = [];
    for await (const c of prov.stream(new AbortController().signal, REQ)) chunks.push(c);

    const previews = chunks.filter((c) => c.type === ChunkType.ToolArgPreview);
    expect(previews).toHaveLength(1);
    expect(previews[0]?.tool_arg_preview?.content).toBe('x = 1;\ny = 2;');
  });

  it('responses：function_call_arguments.delta → ToolArgPreview', async () => {
    const prov = createResponsesProvider({ name: 'prev-responses', apiKey: 'k', baseUrl: 'http://x.test', model: 'm' });
    sseCalls = [
      [
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_code', name: 'code_execution' },
        },
        { type: 'response.function_call_arguments.delta', output_index: 0, partial_json: '{"code":"z = 3;' },
        { type: 'response.completed', response: {} },
      ],
    ];
    const chunks: Chunk[] = [];
    for await (const c of prov.stream(new AbortController().signal, REQ)) chunks.push(c);

    const previews = chunks.filter((c) => c.type === ChunkType.ToolArgPreview);
    expect(previews).toHaveLength(1);
    expect(previews[0]?.tool_arg_preview?.content).toBe('z = 3;');
  });
});
