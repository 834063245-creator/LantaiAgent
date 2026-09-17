// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 自定义请求头（2026-09-17 连接怪癖用户可编辑面）：
//   1. 纯函数——行文本解析 / 渲染 / 加载边界毒化清洗；
//   2. 三方言真 socket——对话与模型目录请求都带自定义头，且凭据头不可被覆写
//      （合并序「自定义头在前、内核必需头与凭据头在后」= 单一权威源）。

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../src/provider/anthropic';
import {
  formatHeaderLines,
  headerEntryError,
  MAX_CUSTOM_HEADERS,
  parseHeaderLines,
  sanitizeProviderHeaders,
} from '../src/provider/custom-headers';
import { createOpenAIProvider } from '../src/provider/openai';
import { createResponsesProvider } from '../src/provider/responses';

describe('custom-headers 纯函数', () => {
  it('parseHeaderLines：认 `Name: Value`，跳过空行与注释，值内冒号保留', () => {
    const { entries, errors } = parseHeaderLines(
      ['# 注释', '', 'x-opencode-session: sess-1', 'origin: https://a.example:8443'].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { name: 'x-opencode-session', value: 'sess-1' },
      { name: 'origin', value: 'https://a.example:8443' },
    ]);
  });

  it('parseHeaderLines：缺冒号 / 非法头 / 同名重复 / 超限逐条报错（错误不静默）', () => {
    expect(parseHeaderLines('no-colon').errors[0]).toContain('缺少「:」');
    expect(parseHeaderLines('bad name: v').errors[0]).toContain('不是 Fetch 能发送的请求头');
    expect(parseHeaderLines('x-a: 1\nx-a: 2').errors[0]).toContain('重复');
    const many = Array.from({ length: MAX_CUSTOM_HEADERS + 1 }, (_, i) => `x-h-${i}: v`).join('\n');
    expect(parseHeaderLines(many).errors[0]).toContain('请求头过多');
  });

  it('headerEntryError：头值含换行/控制字符整条拒绝', () => {
    expect(headerEntryError({ name: 'x-ok', value: 'a\nb' })).not.toBeNull();
    expect(headerEntryError({ name: ' x-ok ', value: 'v' })).toBeNull();
  });

  it('formatHeaderLines 保序渲染，sanitizeProviderHeaders 丢弃毒化条目并保留合法项', () => {
    expect(formatHeaderLines({ a: '1', b: '2' })).toBe('a: 1\nb: 2');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clean = sanitizeProviderHeaders({ 'x-ok': 'v', 'bad name': 'v', 'x-num': 42 }, 'p1');
    expect(clean).toEqual({ 'x-ok': 'v' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/** 捕获请求头的最小 SSE server（照 provider-request-shape 同款姿势）。 */
function startServer(): Promise<{
  server: http.Server;
  url: string;
  requests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
}> {
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      void body;
      if ((req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const sse = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (req.url === '/v1/messages') {
        sse({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } });
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
        sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
        sse({ type: 'message_stop' });
      } else if (req.url === '/responses') {
        sse({ type: 'response.output_text.delta', delta: 'ok' });
        sse({ type: 'response.completed', response: {} });
      } else {
        sse({ choices: [{ delta: { content: 'ok' } }] });
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

describe('三方言请求携带自定义头（凭据头不可覆写）', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const custom = { 'x-opencode-session': 'sess-123', 'x-extra': 'v1' };

  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(() => new Promise<void>((r) => srv.server.close(() => r())));

  const req = { messages: [{ role: 'user' as const, content: 'hi' }], tools: [], temperature: 0, max_tokens: 16 };

  it('openai：stream 与 fetchModels 都带自定义头；Authorization 归凭据', async () => {
    const prov = createOpenAIProvider({
      name: 't-openai',
      apiKey: 'sk-test',
      baseUrl: srv.url,
      model: 'm1',
      headers: { ...custom, authorization: 'Bearer HACK' },
    });
    for await (const _c of prov.stream(AbortSignal.timeout(5000), req)) void _c;
    const chat = srv.requests.at(-1)!;
    expect(chat.headers['x-opencode-session']).toBe('sess-123');
    expect(chat.headers['x-extra']).toBe('v1');
    expect(chat.headers.authorization).toBe('Bearer sk-test');

    await prov.fetchModels?.();
    const models = srv.requests.at(-1)!;
    expect(models.url).toBe('/models');
    expect(models.headers['x-opencode-session']).toBe('sess-123');
    expect(models.headers.authorization).toBe('Bearer sk-test');
  });

  it('anthropic：x-api-key 归凭据，自定义头同发', async () => {
    const prov = createAnthropicProvider({
      name: 't-anthropic',
      apiKey: 'sk-anthropic',
      baseUrl: srv.url,
      model: 'm1',
      headers: { ...custom, 'x-api-key': 'HACK' },
    });
    for await (const _c of prov.stream(AbortSignal.timeout(5000), req)) void _c;
    const sent = srv.requests.at(-1)!;
    expect(sent.url).toBe('/v1/messages');
    expect(sent.headers['x-opencode-session']).toBe('sess-123');
    expect(sent.headers['x-api-key']).toBe('sk-anthropic');

    await prov.fetchModels?.();
    const models = srv.requests.at(-1)!;
    expect(models.url).toBe('/v1/models');
    expect(models.headers['x-opencode-session']).toBe('sess-123');
  });

  it('responses：自定义头垫在 OAuth/凭据头之下', async () => {
    const prov = createResponsesProvider({
      name: 't-responses',
      apiKey: 'sk-resp',
      baseUrl: srv.url,
      model: 'm1',
      extraHeaders: { 'chatgpt-account-id': 'acct-1' },
      headers: { ...custom, authorization: 'Bearer HACK' },
    });
    for await (const _c of prov.stream(AbortSignal.timeout(5000), req)) void _c;
    const sent = srv.requests.at(-1)!;
    expect(sent.url).toBe('/responses');
    expect(sent.headers['x-opencode-session']).toBe('sess-123');
    expect(sent.headers.authorization).toBe('Bearer sk-resp');
    expect(sent.headers['chatgpt-account-id']).toBe('acct-1');

    await prov.fetchModels?.();
    const models = srv.requests.at(-1)!;
    expect(models.headers['x-opencode-session']).toBe('sess-123');
    expect(models.headers.authorization).toBe('Bearer sk-resp');
  });

  it('缺省无自定义头：请求不带附加头（老行零迁移）', async () => {
    const prov = createOpenAIProvider({ name: 't-none', apiKey: 'sk-test', baseUrl: srv.url, model: 'm1' });
    for await (const _c of prov.stream(AbortSignal.timeout(5000), req)) void _c;
    const sent = srv.requests.at(-1)!;
    expect(sent.headers['x-opencode-session']).toBeUndefined();
    expect(sent.headers['x-extra']).toBeUndefined();
  });
});
