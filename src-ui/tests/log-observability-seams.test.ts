// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 日志可观测性批 2 —— **接缝接线**守护（门面单测在 log-observability.test.ts）。
//
// 批 1 测的是「门面本身的四条不变量」；本文件测的是「接缝真的把事件发出去了」：
//   · 出网四相（llm.send / first_byte / error / done）落在**公共面**上
//     （retry.ts 的 sendWithRetry + shared.ts 的 sseEvents）——不是逐方言插桩，
//     所以「以后加第 4 个方言自动继承」这句话在这里被钉住。
//   · 面板重读与凭据写面（settings-domain 产物域，经宿主面 `./host` 取门面）。
//
// 断言面 = logger 替身捕获的调用（**不**用真 logger）：门面写的是 `log.*` 的
// 第 4 参 extra（见 logger.ts 头注），替身天然收得到——这正是当初不另开写口的
// 理由，这里顺带成为它的守护。

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Captured {
  level: string;
  module: string;
  message: string;
  ctx?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

const H = vi.hoisted(() => ({ calls: [] as Captured[] }));

vi.mock('../src/agent/logger', () => {
  // vi.mock 工厂在 import 期求值：只许碰 vi.hoisted 的载体（不得引用模块顶层 const）
  const rec =
    (level: string) =>
    (module: string, message: string, ctx?: Record<string, unknown>, extra?: Record<string, unknown>): void => {
      H.calls.push({ level, module, message, ctx, extra });
    };
  return {
    log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') },
    logChannelState: () => 'ok',
    logFilePath: () => null,
  };
});

import { sendWithRetry } from '../src/plugins/builtin/llm-adapters/retry';
import { sseEvents } from '../src/plugins/builtin/llm-adapters/shared';

const fastOpts = { baseDelayMs: 1, jitterMs: 0, rateLimitedMultiplier: 1 };

function cfg(over: Partial<Parameters<typeof sendWithRetry>[0]> = {}): Parameters<typeof sendWithRetry>[0] {
  return {
    url: 'https://api.test.com/v1/chat/completions',
    headers: { Authorization: 'Bearer SECRET-SHOULD-NEVER-LOG' },
    body: '{"messages":[{"role":"user","content":"正文绝不落日志"}]}',
    signal: new AbortController().signal,
    name: 'testprov',
    meta: { model: 'qwen', kind: 'openai', tools: 2 },
    ...over,
  };
}

/** 本用例捕获到的 obs 事件（按发出顺序）。 */
function events(): Array<{
  event: string;
  level: string;
  ctx?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}> {
  return H.calls
    .filter((c) => typeof c.extra?.event === 'string')
    .map((c) => ({ event: String(c.extra?.event), level: c.level, ctx: c.ctx, extra: c.extra }));
}

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe('日志可观测性 · 接缝接线（批 2）', () => {
  beforeEach(() => {
    H.calls.length = 0;
    vi.restoreAllMocks();
  });

  // ── ④ 出网四相：公共面（retry.ts + shared.ts）────────────────────

  it('成功路径：llm.send → llm.first_byte，身份面齐全且端点只留 host:port', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await sendWithRetry(cfg(), fastOpts);

    expect(events().map((e) => e.event)).toEqual(['llm.send', 'llm.first_byte']);
    const send = events()[0];
    expect(send.level).toBe('info');
    expect(send.ctx).toMatchObject({
      provider: 'testprov',
      model: 'qwen',
      kind: 'openai',
      target: 'api.test.com',
      tools: 2,
      attempt: 1,
    });
    // 请求头与请求体**一律不进日志**（凭据与消息正文）
    const dumped = JSON.stringify(H.calls);
    expect(dumped).not.toContain('SECRET-SHOULD-NEVER-LOG');
    expect(dumped).not.toContain('正文绝不落日志');
  });

  it('重试链：每次尝试一条 send，每次失败一条 error（带分类与状态）', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    spy.mockResolvedValueOnce(new Response('busy', { status: 503 }));

    await expect(sendWithRetry(cfg(), { ...fastOpts, maxAttempts: 2 })).rejects.toBeTruthy();

    expect(events().map((e) => e.event)).toEqual(['llm.send', 'llm.error', 'llm.send', 'llm.error']);
    const err = events()[1];
    expect(err.level).toBe('error');
    expect(err.ctx).toMatchObject({ status: 503 });
    expect(err.extra?.err).toMatchObject({ status: 503, kind: 'transient' });
    // 第 2 次尝试的 send 带 attempt:2（重试链在日志上数得出来）
    expect(events()[2].ctx).toMatchObject({ attempt: 2 });
  });

  it('网络层失败：llm.error 带原始错误文本（端点不可达也留痕）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch'));

    await expect(sendWithRetry(cfg(), { ...fastOpts, maxAttempts: 1 })).rejects.toBeTruthy();

    const err = events().find((e) => e.event === 'llm.error');
    expect(err?.extra?.err).toMatchObject({ raw: 'Failed to fetch' });
  });

  it('llm.done：流**正常读完**才报 ✓（消费者提前 break 不报——那会记假账）', async () => {
    const meta = { model: 'qwen', kind: 'openai', url: 'https://api.test.com/v1/chat' };

    const all: unknown[] = [];
    for await (const ev of sseEvents(sseBody(['data: {"a":1}\n', 'data: [DONE]\n']), 'testprov', undefined, meta)) {
      all.push(ev);
    }
    expect(all).toHaveLength(1);
    const done = events().find((e) => e.event === 'llm.done');
    expect(done?.ctx).toMatchObject({ provider: 'testprov', model: 'qwen', target: 'api.test.com', events: 1 });

    // 提前 break：生成器被 .return() 收尾 → 不得报 done
    H.calls.length = 0;
    for await (const _ev of sseEvents(sseBody(['data: {"a":1}\n', 'data: {"b":2}\n']), 'testprov', undefined, meta)) {
      break;
    }
    expect(events().map((e) => e.event)).not.toContain('llm.done');
  });

  // ── 产物域桥面（settings-domain 的桥由 host-surface 封印测试结构性守护：
  //    `host.ts` 出口 ⊄ faceDeps 时 tsc 就红——这里不重复引那个重依赖图）──

  it('llm-adapters 的宿主面确实桥出门面四函数（产物域取用面）', async () => {
    const host = await import('../src/plugins/builtin/llm-adapters/host');
    for (const k of ['llmSend', 'llmFirstByte', 'llmDone', 'llmError'] as const) {
      expect(typeof host[k]).toBe('function');
    }
    // 桥的是**同一个函数对象**（门面无状态 ⇒ 产物与内核写同一本日志）
    const obs = await import('../src/agent/obs');
    expect(host.llmSend).toBe(obs.llmSend);
  });
});
