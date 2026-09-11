// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 链路挂起自愈回归（2026-09-12 实测事故）。
//
// 事故形态：HTTP 通了但服务商一个字节都不回，30s 空闲守卫逐个掐断。旧的
// 「3 次计数预算」约 2 分钟耗尽即放弃——链路是**分钟级**瞬态，恢复后应用不会
// 自己再试，用户手点重发又落在同一个故障窗口内，只能干等（实测持续十余分钟）。
//
// 本文件钉三件事：
//   ① 挂起错误走**时间预算**：重试次数超过 MAX_RETRIES 仍继续，链路恢复即自动
//      成功，无需用户重发；
//   ② 非挂起错误仍走**计数预算**：到 MAX_RETRIES 就停——不许被顺手改成无限重试；
//   ③ 预算判定 / 挂起分类 / 时长格式的纯函数语义（快、不依赖时钟）。

import { describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import type { Agent } from '../src/agent/agent';
import { formatElapsed, isStallError, MAX_RETRIES, STALL_RETRY_BUDGET_MS, withinRetryBudget } from '../src/agent/retry';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

/** 事故原文形态（[响应超时] 前缀是分类标记，文案随 2026-09-12 精确化）。 */
const STALL_MSG = '[响应超时] 30 秒内未收到服务商任何数据（连接未建立或流式输出中途停止），已中止本次请求';

/** 前 `failures` 次 stream 调用抛 `message`，之后正常回答（模拟链路恢复）。 */
function makeFlakyProvider(failures: number, message: string): { prov: Provider; calls: () => number } {
  let calls = 0;
  const prov: Provider = {
    name: () => 'mock',
    model: () => 'mock',
    stream: (_signal: AbortSignal, _req: unknown) => {
      calls++;
      const n = calls;
      return (async function* (): AsyncGenerator<Chunk> {
        if (n <= failures) throw new Error(message);
        yield { type: ChunkType.Text, text: 'recovered' };
        yield { type: ChunkType.Done } as Chunk;
      })();
    },
  };
  return { prov, calls: () => calls };
}

function makeAgent(prov: Provider): Agent {
  return createTestAgent(prov, new ToolRegistry(), 'sys', { eventSink: () => {}, contextWindow: 0 });
}

/** 把假时钟推完所有退避（单次推进量 < 挂起预算，避免误触「超预算放弃」）。 */
async function drainBackoff(steps = 20, stepMs = 5_000): Promise<void> {
  for (let i = 0; i < steps; i++) await vi.advanceTimersByTimeAsync(stepMs);
}

describe('挂起重试预算 — 纯策略（retry.ts 单点）', () => {
  it('isStallError 只认 [响应超时] 分类前缀', () => {
    expect(isStallError(new Error(STALL_MSG))).toBe(true);
    expect(isStallError(new Error('[服务商限流] "x" 请求过于频繁'))).toBe(false);
    expect(isStallError(new Error('[网络问题] ENOTFOUND x'))).toBe(false);
  });

  it('挂起走时间预算：超过 MAX_RETRIES 次仍允许重试', () => {
    const stall = new Error(STALL_MSG);
    // 计数预算早已用尽（attempt > MAX_RETRIES），时间预算内仍应继续
    expect(withinRetryBudget(stall, MAX_RETRIES, 60_000)).toBe(true);
    expect(withinRetryBudget(stall, 12, STALL_RETRY_BUDGET_MS - 1)).toBe(true);
  });

  it('挂起超时预算即放弃（不会无限重试）', () => {
    const stall = new Error(STALL_MSG);
    expect(withinRetryBudget(stall, 5, STALL_RETRY_BUDGET_MS)).toBe(false);
    expect(withinRetryBudget(stall, 5, STALL_RETRY_BUDGET_MS + 1)).toBe(false);
  });

  it('非挂起错误仍走计数预算（到 MAX_RETRIES 就停）', () => {
    const rate = new Error('[服务商限流] "x" 请求过于频繁');
    expect(withinRetryBudget(rate, 0, 0)).toBe(true);
    expect(withinRetryBudget(rate, MAX_RETRIES - 1, 0)).toBe(true);
    // 时间再久也不给额外额度——限流不该被无限重试
    expect(withinRetryBudget(rate, MAX_RETRIES, STALL_RETRY_BUDGET_MS * 10)).toBe(false);
  });

  it('formatElapsed 人读时长', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(9_400)).toBe('9s');
    expect(formatElapsed(60_000)).toBe('1m00s');
    expect(formatElapsed(905_000)).toBe('15m05s');
    expect(formatElapsed(STALL_RETRY_BUDGET_MS)).toBe('15m00s');
  });
});

describe('挂起自愈 — runLoop 集成', () => {
  it('挂起超过计数预算仍继续重试，链路恢复后自动成功（无需用户重发）', async () => {
    vi.useFakeTimers();
    try {
      // 旧行为：MAX_RETRIES=3 → 最多 4 次尝试即放弃；本用例需要第 5 次才成功。
      const { prov, calls } = makeFlakyProvider(MAX_RETRIES + 1, STALL_MSG);
      const agent = makeAgent(prov);

      const runPromise = agent.run(new AbortController().signal, 'hi');
      await drainBackoff();
      await runPromise;

      expect(calls()).toBe(MAX_RETRIES + 2);
      // 成功收口：assistant 文本已入 session（不是错误收场）
      const texts = agent.session.filter((m) => m.role === 'assistant').map((m) => m.content);
      expect(texts.join('')).toContain('recovered');
    } finally {
      vi.useRealTimers();
    }
  });

  it('非挂起错误到计数预算即停（没有被顺手改成无限重试）', async () => {
    vi.useFakeTimers();
    try {
      const { prov, calls } = makeFlakyProvider(Number.MAX_SAFE_INTEGER, '[服务商限流] "mock" 请求过于频繁');
      const agent = makeAgent(prov);

      const runPromise = agent.run(new AbortController().signal, 'hi').catch(() => {});
      await drainBackoff();
      await runPromise;

      // 首次 + MAX_RETRIES 次重试 = 4 次尝试，一次不多
      expect(calls()).toBe(MAX_RETRIES + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
