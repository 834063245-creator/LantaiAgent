// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 并行工具调用不得被并进同一张卡（2026-11-20「工具卡片卡在运行态」真机根因）。
//
// 真机取证（D:/research/research-system 151 卷，09:46:28 / 09:46:49 两次）：
// 网关（amr-link.open-design.com，openai 方言）在同一轮里发了**两个** tool_calls
// 增量，但两者带同一个 `index`（或缺省 index）。旧实现按 index 建唯一累加器：
//   ① 第二个调用的 id/name 覆盖同一个累加器 ⇒ 第一个调用**只发过 ToolCallStart**，
//      永远等不到自己的 ToolCall/结果 ⇒ 卡片停在「行 Ns」（用户报的症状）；
//   ② 两个调用的 arguments 被拼接成一条 ⇒ JSON.parse 失败；
//      真机原文：「Unexpected non-whitespace character after JSON at position 1272」，
//      错误窗口里能直接看到两段 `{"action": "edit"…}` 首尾相接。
//
// 判据：id 变了就是另一个调用——累加器按 (index, id) 认，绝不合并。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAIProvider } from '../src/plugins/builtin/llm-adapters/openai';
import { resetProxyPort } from '../src/provider/transport';
import { type Chunk, ChunkType } from '../src/provider/types';

const mockInvoke = vi.fn(async () => '0');
vi.mock('../src/bridge', () => ({
  invoke: vi.fn(),
  rpc: (method: string) => mockInvoke(method),
  listen: vi.fn(),
  isMockMode: () => false,
}));

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

function delta(toolCalls: unknown[]): Record<string, unknown> {
  return { choices: [{ delta: { tool_calls: toolCalls } }] };
}

async function collect(events: Array<Record<string, unknown>>): Promise<Chunk[]> {
  sseCalls = [events];
  const prov = createOpenAIProvider({ name: 'merge-test', apiKey: 'k', baseUrl: 'http://x.test/v1', model: 'm' });
  const out: Chunk[] = [];
  for await (const c of prov.stream(new AbortController().signal, {
    messages: [{ role: 'user', content: 'q' }],
    tools: [],
    temperature: 0,
    max_tokens: 100,
  })) {
    out.push(c);
  }
  return out;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  resetProxyPort();
});

describe('openai 方言 — 同 index 的并行 tool_calls 不得并卡', () => {
  it('两个调用共用 index=0 但 id 不同 ⇒ 各自独立成卡、参数不拼接', async () => {
    const chunks = await collect([
      delta([
        { index: 0, id: 'call_00_alpha', function: { name: 'fs', arguments: '{"action":"edit","newString":"AAA"}' } },
      ]),
      delta([
        { index: 0, id: 'call_01_beta', function: { name: 'fs', arguments: '{"action":"edit","newString":"BBB"}' } },
      ]),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const calls = chunks.filter((c) => c.type === ChunkType.ToolCall).map((c) => c.tool_call);
    expect(calls.map((c) => c?.id)).toEqual(['call_00_alpha', 'call_01_beta']);
    // 参数不得拼接（旧行为：'{"action":"edit","newString":"AAA"}{"action":…'）
    expect(calls[0]?.arguments).toBe('{"action":"edit","newString":"AAA"}');
    expect(calls[1]?.arguments).toBe('{"action":"edit","newString":"BBB"}');

    // 两次分发必须都发过 ToolCallStart（否则 UI 里第一张卡的身份永远悬空）
    const starts = chunks.filter((c) => c.type === ChunkType.ToolCallStart).map((c) => c.tool_call?.id);
    expect(starts).toEqual(['call_00_alpha', 'call_01_beta']);
  });

  it('同一 index 且 id 不变 ⇒ 仍按增量累加（正常路径零漂移）', async () => {
    const chunks = await collect([
      delta([{ index: 0, id: 'call_00_one', function: { name: 'fs', arguments: '{"action":' } }]),
      delta([{ index: 0, function: { arguments: '"read","path":"a.ts"}' } }]),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const calls = chunks.filter((c) => c.type === ChunkType.ToolCall).map((c) => c.tool_call);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('call_00_one');
    expect(calls[0]?.arguments).toBe('{"action":"read","path":"a.ts"}');
    // ToolCallStart 只发一次（旧实现每个 name 增量都发一次）
    expect(chunks.filter((c) => c.type === ChunkType.ToolCallStart)).toHaveLength(1);
  });

  it('首帧不带 id（只有 name）→ 后到的 id 认领同一条，不另起无身份条目', async () => {
    const chunks = await collect([
      delta([{ index: 0, function: { name: 'fs', arguments: '{"action":' } }]),
      delta([{ index: 0, id: 'call_00_late', function: { arguments: '"read","path":"a.ts"}' } }]),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const calls = chunks.filter((c) => c.type === ChunkType.ToolCall).map((c) => c.tool_call);
    expect(calls.map((c) => c?.id)).toEqual(['call_00_late']);
    expect(calls[0]?.arguments).toBe('{"action":"read","path":"a.ts"}');
  });

  it('缺省 index 的并行调用同样各自成卡', async () => {
    const chunks = await collect([
      delta([{ id: 'call_00_a', function: { name: 'fs', arguments: '{"action":"read","path":"a"}' } }]),
      delta([{ id: 'call_01_b', function: { name: 'fs', arguments: '{"action":"read","path":"b"}' } }]),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const calls = chunks.filter((c) => c.type === ChunkType.ToolCall).map((c) => c.tool_call);
    expect(calls.map((c) => c?.id)).toEqual(['call_00_a', 'call_01_b']);
    expect(calls[0]?.arguments).toBe('{"action":"read","path":"a"}');
    expect(calls[1]?.arguments).toBe('{"action":"read","path":"b"}');
  });
});
