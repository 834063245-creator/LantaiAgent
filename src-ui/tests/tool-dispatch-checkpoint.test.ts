// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 触发点 B（工具副作用前检查点）钉测：
//   ① 时点：钩子在**工具体执行之前** await（顺序可证）
//   ② 动作：钩子 = `SessionLog.flushPersistence()` → 落盘面排空（增量写 ⇒ 队列空即 no-op）
//   ③ 失败语义：fail-open + 可见（钩子抛错不阻断工具执行，但留 warn）
//   ④ 未注入钩子 = 旧行为（无检查点，工具照跑）

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import { ToolRegistry } from '../src/agent/tool';
import type { ToolCall } from '../src/provider/types';

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: logSpies.info, warn: logSpies.warn, error: logSpies.error, debug: logSpies.debug },
}));

/** 一个记录执行时点的工具。 */
function makeTools(order: string[]): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: () => 'write_thing',
    description: () => 'fixture',
    parameters: () => ({ type: 'object', properties: {}, required: [] }),
    readOnly: () => false,
    execute: async () => {
      order.push('body');
      return 'ok';
    },
  });
  return tools;
}

function call(): ToolCall {
  return { id: 'call1', name: 'write_thing', arguments: '{}' } as ToolCall;
}

beforeEach(() => {
  logSpies.warn.mockClear();
});

describe('触发点 B：工具副作用前检查点', () => {
  it('钩子在工具体之前 await（顺序可证），且 await 的是落盘屏障', async () => {
    const order: string[] = [];
    let flushed = 0;
    const executor = new StreamingToolExecutor(
      makeTools(order),
      () => {},
      null,
      null,
      null,
      null,
      async () => {
        // 屏障本身也要 await 到底（模拟真实的「排空队列」）
        await new Promise((r) => setTimeout(r, 5));
        flushed += 1;
        order.push('checkpoint');
      },
    );
    executor.addTool(call());
    const results = await executor.awaitRemaining();

    expect(results).toHaveLength(1);
    expect(flushed).toBe(1);
    // 检查点先于副作用：body 一定在 checkpoint 之后
    expect(order).toEqual(['checkpoint', 'body']);
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it('钩子失败 = fail-open + 可见：工具照跑，warn 留痕', async () => {
    const order: string[] = [];
    const executor = new StreamingToolExecutor(
      makeTools(order),
      () => {},
      null,
      null,
      null,
      null,
      async () => {
        throw new Error('磁盘满');
      },
    );
    executor.addTool(call());
    const results = await executor.awaitRemaining();

    expect(results).toHaveLength(1);
    expect(order).toEqual(['body']); // 工具没被检查点失败挡住
    expect(logSpies.warn).toHaveBeenCalled();
    expect(String(logSpies.warn.mock.calls.at(-1)?.[1] ?? '')).toContain('工具副作用前检查点失败');
  });

  it('未注入钩子 = 旧行为（无检查点，工具照跑）', async () => {
    const order: string[] = [];
    const executor = new StreamingToolExecutor(makeTools(order), () => {});
    executor.addTool(call());
    await executor.awaitRemaining();
    expect(order).toEqual(['body']);
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it('生产接线（T0 源码断言）：default-loop 用 host.sessionLog.flushPersistence 作钩子', () => {
    // 第一方默认 loop 是唯一构造执行器的地方（第三方 loop 自管工具执行）
    // 批 9h-2：默认 loop 实现随 agent-loop-service 产物包（原 agent/agent-loop/default-loop.ts）
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/plugins/builtin/agent-loop-service/default-loop.ts'),
      'utf8',
    );
    expect(src).toContain('new StreamingToolExecutor(');
    expect(src).toContain('host.sessionLog.flushPersistence()');
  });
});
