// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// token 计量端到端接线钉（2026-09-13）——Agent 侧账本：
//   ① 每次请求落一条记录（构成 + 用量）→ 四桶/逐轮/压力/投影；
//   ② Usage 事件携带 token 记录（UI 侧入账的唯一数据通道）；
//   ③ run() 递增轮号，跨轮各自成槽；
//   ④ 失败请求计数不入账（发了没账单）；
//   ⑤ newSession 清账、快照/恢复往返（卷文件持久化的形状）。

import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/agent/agent';
import type { AgentEvent } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';
import { ToolRegistry } from '../src/agent/tool';
import type { Provider, Usage } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

/** 固定回报用量的 mock provider；usage 可给函数（按调用序号变化）。
 *  fail=true 时抛错（无回报路径）。 */
function makeProvider(
  usage: Usage | undefined | ((call: number) => Usage | undefined),
  opts: { text?: string; fail?: boolean } = {},
): { prov: Provider; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    prov: {
      name: () => 'mock',
      model: () => 'mock-model',
      async *stream() {
        n++;
        if (opts.fail) throw new Error('mock 网络故障');
        yield { type: ChunkType.Text, text: opts.text ?? `回复${n}` } as never;
        const u = typeof usage === 'function' ? usage(n) : usage;
        if (u) yield { type: ChunkType.Usage, usage: u } as never;
        yield { type: ChunkType.Done } as never;
      },
    },
  };
}

function usageOf(over: Partial<Usage> = {}): Usage {
  return {
    prompt_tokens: 1_000,
    completion_tokens: 50,
    total_tokens: 1_050,
    cache_hit_tokens: 800,
    cache_miss_tokens: 200,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    finish_reason: 'stop',
    ...over,
  };
}

function makeAgent(prov: Provider, events: AgentEvent[] = []): Agent {
  return createTestAgent(prov, new ToolRegistry(), '你是兰台的测试 Agent。', {
    contextWindow: 100_000,
    eventSink: (ev) => events.push(ev),
  });
}

const SIGNAL = new AbortController().signal;

describe('token-meter · Agent 侧入账', () => {
  it('一次请求落一条记录：四桶 + 构成 + 压力/投影 + 逐轮', async () => {
    const events: AgentEvent[] = [];
    const { prov } = makeProvider(usageOf());
    const agent = makeAgent(prov, events);

    await agent.run(SIGNAL, '你好，帮我看看这段代码');

    const stats = agent.getTokenStats();
    expect(stats.attempts).toBe(1);
    // 四桶：prompt 1000 = 未缓存 200 + 缓存读 800（写 0）；输出 50 单列
    expect(stats.totals).toEqual({
      uncachedInputTokens: 200,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      outputTokens: 50,
    });
    // 压力 = prompt 侧（不含输出）
    expect(stats.pressureTokens).toBe(1_000);
    expect(stats.contextWindow).toBe(100_000);
    expect(stats.percent).toBe(1);
    // 构成三段齐备且加总 = 表面量
    expect(stats.breakdown).toBeDefined();
    const b = stats.breakdown!;
    expect(b.systemTokens).toBeGreaterThan(0); // 系统提示重头戏
    expect(b.messageTokens).toBeGreaterThan(0);
    expect(stats.surfaceTokens).toBe(b.systemTokens + b.toolsTokens + b.messageTokens);
    // 逐轮
    expect(stats.turns).toHaveLength(1);
    expect(stats.turns[0]?.turn).toBe(1);
    expect(stats.turns[0]?.steps).toBe(1);
    expect(stats.turns[0]?.totalTokens).toBe(1_050);
    // 缓存命中率（800/1000）
    expect(stats.cacheHitPercent).toBe('80');
  });

  it('Usage 事件携带 token 记录（UI 入账通道）', async () => {
    const events: AgentEvent[] = [];
    const { prov } = makeProvider(usageOf());
    const agent = makeAgent(prov, events);

    await agent.run(SIGNAL, '第一句');

    const usageEvents = events.filter((e) => e.kind === EventKind.Usage);
    expect(usageEvents).toHaveLength(1);
    const rec = usageEvents[0]?.token;
    expect(rec).toBeDefined();
    expect(rec?.turn).toBe(1);
    expect(rec?.step).toBe(1);
    expect(rec?.contextWindow).toBe(100_000);
    expect(rec?.usage?.total_tokens).toBe(1_050);
    expect(rec?.surfaceTokens).toBeGreaterThan(0);
  });

  it('跨轮累进：轮号递增，逐轮各自成槽', async () => {
    const { prov } = makeProvider((call) =>
      call === 1 ? usageOf() : usageOf({ prompt_tokens: 2_000, cache_hit_tokens: 1_000, cache_miss_tokens: 1_000 }),
    );
    const agent = makeAgent(prov);

    await agent.run(SIGNAL, '第一句');
    await agent.run(SIGNAL, '第二句');

    const stats = agent.getTokenStats();
    expect(stats.attempts).toBe(2);
    expect(stats.turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(stats.totals.uncachedInputTokens).toBe(200 + 1_000);
    expect(stats.totals.cacheReadTokens).toBe(800 + 1_000);
    expect(stats.turns[0]?.peakPressureTokens).toBe(1_000);
    expect(stats.turns[1]?.peakPressureTokens).toBe(2_000);
    expect(stats.last?.turn).toBe(2);
  });

  it('失败请求计数不入账（发了但没账单）', async () => {
    const events: AgentEvent[] = [];
    const { prov } = makeProvider(undefined, { fail: true });
    const agent = makeAgent(prov, events);

    await agent.run(SIGNAL, '会失败的请求').catch(() => {});

    const stats = agent.getTokenStats();
    expect(stats.attempts).toBeGreaterThanOrEqual(1);
    expect(stats.totals.outputTokens).toBe(0);
    expect(stats.totals.uncachedInputTokens).toBe(0);
    // 构成仍测到了（记录在场），只是无用量
    expect(stats.breakdown).toBeDefined();
    expect(stats.pressureTokens).toBeUndefined();
  });

  it('newSession 清账：旧账不跨卷', async () => {
    const { prov } = makeProvider(usageOf());
    const agent = makeAgent(prov);
    await agent.run(SIGNAL, '第一句');
    expect(agent.getTokenStats().attempts).toBe(1);

    agent.newSession();

    const stats = agent.getTokenStats();
    expect(stats.attempts).toBe(0);
    expect(stats.turns).toEqual([]);
    expect(stats.totals.outputTokens).toBe(0);
  });

  it('账本快照/恢复往返（卷文件持久化形状）', async () => {
    const { prov } = makeProvider(usageOf());
    const agent = makeAgent(prov);
    await agent.run(SIGNAL, '第一句');
    await agent.run(SIGNAL, '第二句');

    const snapshot = agent.snapshotTokenLedger();
    expect(snapshot).not.toBeNull();
    const before = agent.getTokenStats();

    const revived = makeAgent(makeProvider(undefined).prov);
    revived.restoreTokenLedger(snapshot);
    const after = revived.getTokenStats();

    expect(after.attempts).toBe(before.attempts);
    expect(after.totals).toEqual(before.totals);
    expect(after.turns).toEqual(before.turns);
    expect(after.pressureTokens).toBe(before.pressureTokens);
    expect(after.contextWindow).toBe(100_000); // 窗口按新句柄的运行时值（不吃旧快照的窗口）
  });

  it('空账本不落盘；毒化快照降级不抛', async () => {
    const agent = makeAgent(makeProvider(undefined).prov);
    expect(agent.snapshotTokenLedger()).toBeNull();
    expect(() => agent.restoreTokenLedger({ totals: 'garbage' } as never)).not.toThrow();
    expect(agent.getTokenStats().attempts).toBe(0);
  });
});
