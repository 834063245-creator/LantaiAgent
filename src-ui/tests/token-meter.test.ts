// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// token-meter 计量层钉值（2026-09-13）——DSH `@deepseek-ai/dsh-token-meter`
// 语义移植的行为锚：分桶归一不变式 / prompt 侧压力 / 投影占用 / 逐轮用量 /
// 缓存命中诚实舍入 / 账本快照往返与毒化容忍。

import { describe, expect, it } from 'vitest';
import { measureEnvelope } from '../src/agent/token-meter/estimate';
import { SessionTokenMeter } from '../src/agent/token-meter/meter';
import type { TokenRequestRecord } from '../src/agent/token-meter/types';
import {
  billedInputTokens,
  bucketsFrom,
  cacheHitPercentText,
  formatTokens,
  totalTokens,
} from '../src/agent/token-meter/usage';
import type { Usage } from '../src/provider/types';

function usage(over: Partial<Usage> = {}): Usage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    finish_reason: 'stop',
    ...over,
  };
}

function record(over: Partial<TokenRequestRecord> = {}): TokenRequestRecord {
  const breakdown = over.breakdown ?? { systemTokens: 100, toolsTokens: 200, messageTokens: 300 };
  return {
    turn: 1,
    step: 1,
    breakdown,
    surfaceTokens: breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens,
    contextWindow: 100_000,
    ...over,
  };
}

describe('token-meter · 分桶归一', () => {
  it('OpenAI 兼容口径：prompt 含缓存读，未缓存部分走残差', () => {
    const b = bucketsFrom(usage({ prompt_tokens: 1000, completion_tokens: 40, cache_hit_tokens: 800 }));
    expect(b).toEqual({ uncachedInputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 40 });
    expect(billedInputTokens(b)).toBe(1000); // 归一不变式：四桶输入侧恒等于 prompt_tokens
    expect(totalTokens(b)).toBe(1040);
  });

  it('Anthropic 口径：缓存写单列，残差补未缓存', () => {
    const b = bucketsFrom(
      usage({ prompt_tokens: 1000, completion_tokens: 10, cache_hit_tokens: 600, cache_creation_tokens: 100 }),
    );
    expect(b).toEqual({ uncachedInputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 10 });
    expect(billedInputTokens(b)).toBe(1000);
  });

  it('越界/脏值不炸也不编造：读桶封顶 prompt，负值归零', () => {
    const b = bucketsFrom(usage({ prompt_tokens: 100, cache_hit_tokens: 999, cache_creation_tokens: -5 }));
    expect(b.cacheReadTokens).toBe(100);
    expect(b.cacheWriteTokens).toBe(0);
    expect(b.uncachedInputTokens).toBe(0);
    expect(billedInputTokens(b)).toBe(100);
    const dirty = bucketsFrom(usage({ prompt_tokens: Number.NaN as unknown as number, completion_tokens: -3 }));
    expect(billedInputTokens(dirty)).toBe(0);
    expect(dirty.outputTokens).toBe(0);
  });
});

describe('token-meter · 缓存命中诚实舍入（DSH formatCacheHitPercent 移植）', () => {
  it('无计费输入 → null；全中 → 100', () => {
    expect(cacheHitPercentText(0, 0)).toBeNull();
    expect(cacheHitPercentText(500, 500)).toBe('100');
  });

  it('近满但非满：加精度绝不舍入成 100', () => {
    expect(cacheHitPercentText(986, 1000)).toBe('99'); // 98.6 → 整数档
    expect(cacheHitPercentText(995, 1000)).toBe('99.5');
    expect(cacheHitPercentText(9_995, 10_000)).toBe('99.95');
    expect(cacheHitPercentText(99_995, 100_000)).toBe('99.995');
    expect(cacheHitPercentText(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER)).toMatch(/^99\.9+$/);
  });
});

describe('token-meter · 紧凑计数', () => {
  it('千/百万两级缩写，阈值与 DSH 一致', () => {
    expect(formatTokens(517)).toBe('517');
    expect(formatTokens(1_000)).toBe('1k');
    expect(formatTokens(12_200)).toBe('12.2k');
    expect(formatTokens(99_400)).toBe('99.4k');
    expect(formatTokens(517_000)).toBe('517k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});

describe('token-meter · 每卷计量器', () => {
  it('逐请求累进四桶 + 轮内步数', () => {
    const m = new SessionTokenMeter();
    m.recordRequest(record({ usage: usage({ prompt_tokens: 1000, completion_tokens: 50, cache_hit_tokens: 900 }) }));
    m.recordRequest(record({ step: 2, usage: usage({ prompt_tokens: 1200, completion_tokens: 80 }) }));
    const v = m.measure();
    expect(v.attempts).toBe(2);
    expect(v.totals).toEqual({
      uncachedInputTokens: 1_300,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      outputTokens: 130,
    });
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0]?.steps).toBe(2);
    expect(v.turns[0]?.peakPressureTokens).toBe(1200);
  });

  it('压力 = prompt 侧最新一次（不含输出）；投影 = 压力 + 采样后表面增量', () => {
    const m = new SessionTokenMeter();
    m.setContextWindow(100_000);
    m.recordSurface(1_000);
    m.recordRequest(record({ surfaceTokens: 1_000, usage: usage({ prompt_tokens: 1_000, completion_tokens: 500 }) }));
    let v = m.measure();
    expect(v.pressureTokens).toBe(1_000); // 输出 500 不进压力
    expect(v.projectedTokens).toBe(1_000);
    expect(v.percent).toBe(1);
    expect(v.usedSource).toBe('projected');

    // 采样之后表面又长了（工具结果入场）——流式期间压力站住，投影跟着涨
    m.recordSurface(1_800);
    v = m.measure();
    expect(v.pressureTokens).toBe(1_000);
    expect(v.projectedTokens).toBe(1_800);
    expect(v.surfaceTokens).toBe(1_800);
  });

  it('投影夹零：压缩把表面削到采样点之下不出负数', () => {
    const m = new SessionTokenMeter();
    m.recordSurface(5_000);
    m.recordRequest(record({ surfaceTokens: 5_000, usage: usage({ prompt_tokens: 5_000 }) }));
    m.recordSurface(1_200); // 压缩后载荷骤降
    expect(m.measure().projectedTokens).toBe(1_200);
    m.recordSurface(0);
    expect(m.measure().projectedTokens).toBe(0);
  });

  it('失败请求（无回报）计数但零入账；空 usage 不构成采样', () => {
    const m = new SessionTokenMeter();
    m.recordRequest(record({ usage: undefined }));
    m.recordRequest(record({ step: 2, usage: usage({ prompt_tokens: 0, completion_tokens: 0 }) }));
    const v = m.measure();
    expect(v.attempts).toBe(2);
    expect(totalTokens(v.totals)).toBe(0);
    expect(v.pressureTokens).toBeUndefined();
    expect(v.last).toBeUndefined();
  });

  it('无回报时占用回落到载荷估算（标估算源），窗口未知时不给百分比', () => {
    const m = new SessionTokenMeter();
    m.recordSurface(4_000);
    expect(m.measure().usedSource).toBe('none'); // 窗口未知：无分母不冒充占用
    m.setContextWindow(100_000);
    const v = m.measure();
    expect(v.usedSource).toBe('surface');
    expect(v.usedTokens).toBe(4_000);
    expect(v.percent).toBe(4);
  });

  it('逐轮分组：跨轮各自成槽，旧轮不被新轮改写', () => {
    const m = new SessionTokenMeter();
    m.recordRequest(record({ turn: 1, step: 1, usage: usage({ prompt_tokens: 100, completion_tokens: 10 }) }));
    m.recordRequest(record({ turn: 2, step: 1, usage: usage({ prompt_tokens: 200, completion_tokens: 20 }) }));
    m.recordRequest(record({ turn: 2, step: 2, usage: usage({ prompt_tokens: 300, completion_tokens: 30 }) }));
    const v = m.measure();
    expect(v.turns.map((t) => [t.turn, t.steps, t.totalTokens])).toEqual([
      [1, 1, 110],
      [2, 2, 550],
    ]);
  });

  it('账本快照往返（重启不丢账）', () => {
    const m = new SessionTokenMeter();
    m.setContextWindow(200_000);
    m.recordSurface(3_000);
    m.recordRequest(
      record({
        turn: 1,
        step: 1,
        contextWindow: 200_000,
        surfaceTokens: 3_000,
        usage: usage({ prompt_tokens: 3_000, completion_tokens: 120 }),
      }),
    );
    m.recordRequest(
      record({
        turn: 2,
        step: 1,
        contextWindow: 200_000,
        surfaceTokens: 3_400,
        usage: usage({ prompt_tokens: 3_400, completion_tokens: 90 }),
      }),
    );
    const snap = m.snapshot();
    expect(snap).not.toBeNull();

    const revived = SessionTokenMeter.restore(snap);
    const v = revived.measure();
    expect(v.totals).toEqual(m.measure().totals);
    expect(v.attempts).toBe(2);
    expect(v.turns).toEqual(m.measure().turns);
    expect(v.pressureTokens).toBe(3_400);
    expect(v.contextWindow).toBe(200_000);
    expect(v.surfaceTokens).toBe(3_400); // 表面随快照回来（采样基准同源）
    expect(v.projectedTokens).toBe(3_400);
  });

  it('空账本不落盘；毒化快照降级为缺省而不抛', () => {
    expect(new SessionTokenMeter().snapshot()).toBeNull();
    const junk = SessionTokenMeter.restore({
      version: 1,
      totals: { uncachedInputTokens: -5, cacheReadTokens: Number.NaN, cacheWriteTokens: 3, outputTokens: 1 },
      attempts: -2,
      turns: [null, { turn: 1, steps: 'x' }],
      surfaceTokens: -100,
      contextWindow: -9,
    } as never);
    const v = junk.measure();
    expect(v.attempts).toBe(0);
    expect(v.totals.cacheWriteTokens).toBe(3); // 合法桶保留
    expect(v.totals.uncachedInputTokens).toBe(0);
    expect(v.surfaceTokens).toBe(0);
    expect(v.contextWindow).toBeUndefined();
    expect(SessionTokenMeter.restore(undefined).measure().attempts).toBe(0);
  });
});

describe('token-meter · 上下文构成', () => {
  it('系统提示/工具 schema/对话三段分开计价，三项之和 = 载荷估算量', () => {
    const m = measureEnvelope(
      [
        { role: 'system', content: '你是兰台' },
        { role: 'user', content: '帮我看看这段代码' },
        { role: 'user', content: '<system-reminder>注入提醒</system-reminder>' },
        { role: 'assistant', content: '好的' },
        { role: 'tool', content: 'tool output here', tool_call_id: 't1', name: 'read' },
      ],
      [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } }],
      ['<system-reminder>临时提醒</system-reminder>'],
    );
    expect(m.breakdown.systemTokens).toBeGreaterThan(0);
    expect(m.breakdown.toolsTokens).toBeGreaterThan(0);
    expect(m.breakdown.messageTokens).toBe(
      m.userTokens + m.reminderTokens + m.assistantTokens + m.toolResultTokens + m.transientTokens,
    );
    expect(m.surfaceTokens).toBe(m.breakdown.systemTokens + m.breakdown.toolsTokens + m.breakdown.messageTokens);
    expect(m.systemMessages).toBe(1);
    expect(m.schemaCount).toBe(1);
    expect(m.reminderTokens).toBeGreaterThan(0);
    expect(m.transientTokens).toBeGreaterThan(0);
  });

  it('空信封全零（不编造基数）', () => {
    const m = measureEnvelope([], [], []);
    expect(m.surfaceTokens).toBe(0);
    expect(m.breakdown).toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 });
  });
});
