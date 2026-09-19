// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 读图链路「生产镜像」回归 — settings 行 → live 壳 → AgentRuntime 句柄 → 请求期
// 解析（**真** readAttachmentBase64 + fs_cap RPC 桩）→ openai adapter → 出站 body。
//
// Why（2026-09-19 真机复验仍断）：既有用例各自盖一段——provider-live 组用
// createTestAgent + 假 reader（跳过 runtime 翻译层与 app 注入的读盘腰），
// runtime-image-forward 组用 mock provider（跳过能力戳/wire）。两段之间的
// 「workspace 传进 createAgent 的 imageReader 是否真的抵达 Agent」没有任何用例
// 覆盖 —— 与 2026-09-18 事故（壳层能力戳漏测）同型的测试盲区。
//
// 判据（用户真机症状的机器化）：附一张图跑一轮，**出站请求体**里必须出现
// image_url data URI；缺它就是「图压根没送出去」，且必须至少留占位（错误不静默）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
async function mockRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const snakeKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
      normalized[snakeKey] = value;
    }
  }
  return mockInvoke('rpc', { method, params: normalized });
}
vi.mock('../src/bridge', () => ({
  invoke: vi.fn(),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { AgentRuntime } from '../src/agent/runtime/runtime';
import { ToolRegistry } from '../src/agent/tool';
import { attachmentFilePath, bytesToBase64, readAttachmentBase64 } from '../src/app/chat/image-intake';
import { _resetCredentialCacheForTests } from '../src/provider/credentials';
import { createLiveProvider } from '../src/provider/live';
import { resetProxyPort } from '../src/provider/transport';
import type { ChatImageRef, Provider, Request } from '../src/provider/types';
import { providerId } from '../src/settings';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

await ensureProductionChannelsBooted();

const ROOT = 'D:/ws';
const IMG_ID = 'b1cc7fee466e99184f59ab3b5d32653e6c141a95a5acfb200addc6eb33339e6f';
const IMG: ChatImageRef = {
  id: IMG_ID,
  mediaType: 'image/png',
  bytes: 12,
  width: 114,
  height: 1182,
  name: 'image.png',
};
/** 最小 PNG 字节（内容无关——只走通道，不解码）。 */
const PNG_B64 = bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));

/** 用户真机设置行的镜像（2026-09-19 从 WebView2 localStorage 抄出的实际形状）。 */
function seedUserRow(): void {
  localStorage.setItem(
    'hologram_settings',
    JSON.stringify({
      activeProvider: 'opencode',
      providers: [
        {
          kind: 'openai',
          name: providerId('opencode'),
          apiKey: '',
          baseUrl: 'http://a.test/v1',
          model: 'deepseek-v4.1-flash',
          models: ['deepseek-v4.1-flash'],
          modelOverrides: { 'deepseek-v4.1-flash': { contextWindow: 1000000, input: ['text', 'image'] } },
        },
      ],
      projectPath: ROOT,
      agent: { temperature: 0.7, contextWindow: 0 },
      display: { language: 'zh', fontScale: 1 },
    }),
  );
}

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}
const fetchCalls: FetchCall[] = [];

function sseResponse(): Response {
  const enc = new TextEncoder();
  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(events));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** fs_cap 桩：记录被请求的路径，按 Rust 真实回包形状（JsonValue → 结构化对象）回字节。 */
const fsCapCalls: Array<Record<string, unknown>> = [];

function installInvokeStub(opts?: { readFails?: boolean }): void {
  mockInvoke.mockImplementation((_cmd: string, payload: { method: string; params?: Record<string, unknown> }) => {
    if (payload.method === 'credential_get') return Promise.resolve(JSON.stringify('sk-1'));
    if (payload.method === 'fs_cap') {
      fsCapCalls.push(payload.params ?? {});
      if (payload.params?.action === 'read_base64') {
        if (opts?.readFails === true) return Promise.reject(new Error('fs_cap read_base64: 无法读取文件'));
        return Promise.resolve({ path: payload.params.file_path, base64: PNG_B64 });
      }
      return Promise.resolve({});
    }
    if (payload.method === 'llm_proxy_port') return Promise.resolve('0');
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  localStorage.clear();
  fetchCalls.length = 0;
  fsCapCalls.length = 0;
  _resetCredentialCacheForTests();
  resetProxyPort();
  mockInvoke.mockReset();
  installInvokeStub();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 生产装配镜像：live 壳（透传包装以便观察请求）+ runtime 句柄 + app 注入读盘腰。
 *  wired=false 模拟「装配漏接线」（2026-09-19 事故形态）——不注入 imageReader。 */
async function runTurnWithImage(wired = true): Promise<{ seen: Request[] }> {
  seedUserRow();
  const shell = createLiveProvider('opencode', { seamView: null }, { model: 'deepseek-v4.1-flash' });
  const seen: Request[] = [];
  const watched: Provider = {
    name: () => shell.name(),
    model: () => shell.model(),
    get inputModalities() {
      return shell.inputModalities;
    },
    stream: (signal: AbortSignal, req: Request) => {
      seen.push(req);
      return shell.stream(signal, req);
    },
  };
  const runtime = new AgentRuntime();
  const handle = await runtime.createAgent({
    agentId: `main-img-chain-${wired ? 'wired' : 'unwired'}`,
    parentId: null,
    projectPath: ROOT,
    provider: watched,
    tools: new ToolRegistry(),
    systemPrompt: 'test system prompt',
    eventSink: () => {},
    contextWindow: 0,
    // 生产注入点（workspace.ts createAgent 的 config.imageReader）
    ...(wired ? { imageReader: (ref: ChatImageRef) => readAttachmentBase64(ROOT, ref) } : {}),
  });
  await handle.run(new AbortController().signal, '测试，能看到这个图吗', [IMG]);
  return { seen };
}

function userContent(): unknown {
  const messages = fetchCalls[0]?.body.messages as Array<{ role: string; content: unknown }>;
  return messages.find((m) => m.role === 'user')?.content;
}

describe('读图链路生产镜像 — 附图必须抵达出站请求体', () => {
  it('能力戳：live 壳 + 用户真机行形状 → 声明含 image', () => {
    seedUserRow();
    const shell = createLiveProvider('opencode', { seamView: null }, { model: 'deepseek-v4.1-flash' });
    expect(shell.inputModalities).toEqual(['text', 'image']);
  });

  it('createAgent 的 imageReader 抵达 Agent：读盘腰被调用，路径 = {ws}/.lantai/attachments/{id}.png', async () => {
    const { seen } = await runTurnWithImage();
    const expected = attachmentFilePath(ROOT, IMG_ID, 'image/png');
    const readCall = fsCapCalls.find((c) => c.action === 'read_base64');
    expect(readCall?.file_path).toBe(expected);
    expect(readCall?.is_agent).toBe(false);
    // Agent 侧把解析结果挂上 Request（缺它 = 适配器无图可 join）
    expect(Object.keys(seen[0]?.imageData ?? {})).toEqual([IMG_ID]);
  });

  it('出站 body：user 消息 content 为 parts 数组且含 image_url data URI（症状判据）', async () => {
    await runTurnWithImage();
    expect(fetchCalls).toHaveLength(1);
    const parts = userContent() as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]).toEqual({ type: 'text', text: '测试，能看到这个图吗' });
    expect(parts.some((p) => p.type === 'image_url' && p.image_url?.url === `data:image/png;base64,${PNG_B64}`)).toBe(
      true,
    );
  });

  it('读盘腰缺失（装配漏接线）→ 响亮降级：wire 上留占位，不静默丢图', async () => {
    await runTurnWithImage(false);
    expect(fsCapCalls.filter((c) => c.action === 'read_base64')).toHaveLength(0);
    const content = String(userContent());
    expect(content).toContain('未能送达模型');
    expect(content).toContain('image.png');
  });

  it('读盘全失败 → 响亮降级：占位替代（不炸请求、不静默）', async () => {
    installInvokeStub({ readFails: true });
    await runTurnWithImage();
    expect(String(userContent())).toContain('未能送达模型');
  });
});
