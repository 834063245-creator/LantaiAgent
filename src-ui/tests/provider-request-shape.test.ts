// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// provider 请求体形状契约（2026-09-01 重发锚点工程护栏）：
// UI 概念（sandbox / uiId / sessionIndex 等）绝不允许漏进 API 请求体——
// 两个方言的消息块都必须由白名单字段构造。此契约用「被 UI 概念污染过的
// Message」直打真 socket，钉死请求体形状：任何人往 Message 上挂 UI 字段
// 而不在方言构造处洗掉，这里先红（宁可洗两遍不可漏一次）。

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/provider/anthropic';
import { createOpenAIProvider } from '../src/provider/openai';
import type { Message } from '../src/provider/types';

/** 起一个本地 SSE server（照 provider-realsocket 同款姿势），捕获请求体。 */
function startServer(
  handler: (body: string, sse: (payload: string) => void, res: http.ServerResponse) => void,
): Promise<{
  server: http.Server;
  url: string;
  bodies: string[];
}> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      handler(body, (payload) => res.write(`data: ${payload}\n\n`), res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, bodies });
    });
  });
}

/** 被 UI 概念污染的会话——模拟有人往 Message 上挂了 UI 字段的最坏情形。 */
function pollutedMessages(): Message[] {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi', sandbox: { uiId: 'm1' }, sessionIndex: 1 } as unknown as Message,
    {
      role: 'assistant',
      content: 'ok',
      reasoning_content: 'think',
      uiId: 'a1',
      respondingTo: 'm1',
    } as unknown as Message,
    { role: 'user', content: 'again', sandbox: { uiId: 'm2' } } as unknown as Message,
  ];
}

/** 请求体里不得出现的 UI 概念痕迹。 */
const UI_LEAK_MARKERS = ['sandbox', 'uiId', 'ui_id', 'respondingTo', 'responding_to', 'sessionIndex', 'session_index'];

describe('provider 请求体形状契约（UI 概念零泄漏）', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    srv = await startServer((body, sse, res) => {
      void body;
      // 双方言各自的最小合法 SSE 流
      if ('thinking' in JSON.parse(body) || body.includes('"stream_options"')) {
        // openai 兼容方言
        sse(JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }));
        sse(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
        res.write('data: [DONE]\n\n');
      } else {
        // anthropic 方言
        sse(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }));
        sse(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }));
        sse(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }));
        sse(JSON.stringify({ type: 'message_stop' }));
      }
      res.end();
    });
  });

  afterAll(() => new Promise<void>((r) => srv.server.close(() => r())));

  it('openai 方言：消息块只含白名单字段，无任何 UI 概念痕迹', async () => {
    const prov = createOpenAIProvider({
      name: 'contract-openai',
      apiKey: 'sk-test',
      baseUrl: srv.url,
      model: 'deepseek-v4-pro',
    });
    for await (const _c of prov.stream(AbortSignal.timeout(5000), {
      messages: pollutedMessages(),
      tools: [],
      temperature: 0,
      max_tokens: 100,
    })) {
      void _c; // 只需让请求发出、流走完
    }

    const body = JSON.parse(srv.bodies[srv.bodies.length - 1]);
    // reasoning_content = 思考链回传（2026-09-23 批次）：带 tools 的请求里历史
    // assistant 轮的思考必须原样上行，否则 DeepSeek 400（见
    // tests/provider-reasoning-passback.test.ts 的规则面）。
    const WHITELIST = new Set(['role', 'content', 'tool_call_id', 'name', 'tool_calls', 'reasoning_content']);
    for (const m of body.messages) {
      for (const key of Object.keys(m)) {
        expect(WHITELIST.has(key), `openai 消息出现白名单外字段: ${key}`).toBe(true);
      }
    }
    const raw = srv.bodies[srv.bodies.length - 1];
    for (const marker of UI_LEAK_MARKERS) {
      expect(raw.includes(marker), `openai 请求体泄漏 UI 概念: ${marker}`).toBe(false);
    }
    // 思考链回传的真 socket 证据（而不仅是白名单放行）：历史思考确实上了线。
    expect(raw.includes('"reasoning_content":"think"')).toBe(true);
  });

  it('anthropic 方言：消息块只含白名单字段，无任何 UI 概念痕迹', async () => {
    const prov = createAnthropicProvider({
      name: 'contract-anthropic',
      apiKey: 'sk-test',
      baseUrl: srv.url,
      model: 'claude-sonnet-4',
    });
    for await (const _c of prov.stream(AbortSignal.timeout(5000), {
      messages: pollutedMessages(),
      tools: [],
      temperature: 0,
      max_tokens: 100,
    })) {
      void _c;
    }

    const body = JSON.parse(srv.bodies[srv.bodies.length - 1]);
    const WHITELIST = new Set(['role', 'content', 'cache_control']);
    for (const m of body.messages) {
      for (const key of Object.keys(m)) {
        expect(WHITELIST.has(key), `anthropic 消息出现白名单外字段: ${key}`).toBe(true);
      }
      // content 可能是块数组（tool_use/text 块）——逐块扫白名单
      if (Array.isArray(m.content)) {
        const BLOCK_KEYS = new Set(['type', 'text', 'id', 'name', 'input', 'cache_control', 'signature', 'thinking']);
        for (const block of m.content) {
          for (const key of Object.keys(block)) {
            expect(BLOCK_KEYS.has(key), `anthropic 块出现白名单外字段: ${key}`).toBe(true);
          }
        }
      }
    }
    const raw = srv.bodies[srv.bodies.length - 1];
    for (const marker of UI_LEAK_MARKERS) {
      expect(raw.includes(marker), `anthropic 请求体泄漏 UI 概念: ${marker}`).toBe(false);
    }
  });
});
