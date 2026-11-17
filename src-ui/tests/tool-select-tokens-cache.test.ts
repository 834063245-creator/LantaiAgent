// @vitest-environment node

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// StableSchemaSelector.tokensOf 的锁存守卫（2026-11-17 动效台架批）。
//
// 病灶：一次发送里 pre-flight 与信封计量各对**同一批**工具 schema 分一次词
// （Chrome 采样实测 countToolSchemas inclusive 27.6ms，占 pre-flight 那次
//  tokenCountWithEstimation 的四成）。
//
// 为什么单独一个文件、为什么要 spy：同一组断言先前写进 domains-convergence
// 时用的是「值相等」——把缓存整个人删掉，测试照样全绿（2026-11-17 实测）。
// 缓存这种东西，值永远是对的；有信息量的只有**算了几次**。故本文件 spy
// token-counter 的计数函数，直接数调用次数。

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 调用计数（vi.mock 工厂里累加；beforeEach 清零）。 */
const countCalls = { n: 0 };

vi.mock('../src/agent/token-counter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/token-counter')>();
  return {
    ...actual,
    countToolSchemas: (schemas: Parameters<typeof actual.countToolSchemas>[0]) => {
      countCalls.n += 1;
      return actual.countToolSchemas(schemas);
    },
  };
});

const { createStableSchemaSelector, userContext } = await import('../src/agent/tool-select');
const { ToolRegistry } = await import('../src/agent/tool');
const { countToolSchemas } = await import('../src/agent/token-counter');

/** 最小 registry：一个工具即可（tokensOf 只关心「这批 schema 分过没有」）。 */
function makeRegistry(): InstanceType<typeof ToolRegistry> {
  const reg = new ToolRegistry();
  reg.register({
    name: () => 'demo_tool',
    description: () => '演示用的工具，描述长度足够触发一次真实分词',
    parameters: () => ({ type: 'object', properties: { a: { type: 'string' } } }),
    readOnly: () => true,
    execute: async () => 'ok',
  } as never);
  return reg;
}

describe('StableSchemaSelector.tokensOf —— 整批分词的锁存', () => {
  beforeEach(() => {
    countCalls.n = 0;
  });

  it('同 key 连续两次：分词器只被调用一次', () => {
    const s = createStableSchemaSelector();
    const r = makeRegistry();
    s.tokensOf(r, 4, 'ctx');
    const first = countCalls.n;
    s.tokensOf(r, 4, 'ctx');
    expect(first).toBe(1);
    expect(countCalls.n).toBe(1); // 第二次命中缓存，不再分词
  });

  it('先 select 再 tokensOf：共锁，分词仍只发生一次', () => {
    const s = createStableSchemaSelector();
    const r = makeRegistry();
    s.select(r, 4, 'ctx'); // 只选 schema，不计 token
    expect(countCalls.n).toBe(0);
    s.tokensOf(r, 4, 'ctx');
    s.tokensOf(r, 4, 'ctx');
    expect(countCalls.n).toBe(1);
  });

  it('key 变化（新用户消息）→ 重算一次', () => {
    const s = createStableSchemaSelector();
    const r = makeRegistry();
    s.tokensOf(r, 4, 'ctx');
    s.tokensOf(r, 4, 'ctx2');
    expect(countCalls.n).toBe(2);
  });

  it('registry / limit 变化 → 各自重算', () => {
    const s = createStableSchemaSelector();
    const r1 = makeRegistry();
    const r2 = makeRegistry();
    s.tokensOf(r1, 4, 'ctx');
    s.tokensOf(r2, 4, 'ctx');
    s.tokensOf(r1, 5, 'ctx');
    expect(countCalls.n).toBe(3);
  });

  it('userContext 稳定契约：工具循环里的 assistant/tool 消息不触发重算', () => {
    const s = createStableSchemaSelector();
    const r = makeRegistry();
    const loopCtx = userContext([
      { role: 'user', content: 'ctx' },
      { role: 'assistant', content: 'round 1' },
      { role: 'tool', content: 'output' },
    ] as never);
    expect(loopCtx).toBe('ctx');
    s.tokensOf(r, 4, loopCtx);
    s.tokensOf(r, 4, 'ctx');
    expect(countCalls.n).toBe(1);
  });

  it('值仍然正确（缓存不能改答案）', () => {
    const s = createStableSchemaSelector();
    const r = makeRegistry();
    const cached = s.tokensOf(r, 4, 'ctx');
    expect(cached).toBe(countToolSchemas(r.schemas()));
    expect(s.tokensOf(r, 4, 'ctx')).toBe(cached);
  });
});
