// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// P1-2 待领信箱（Agent 侧）：程序结束后才返回的嵌套调用结果如何进下一步。
//
// 为什么单独立文件：code-execution.test.ts 走 host 层（fake worker 注入），
// 这一组要真 Agent 实例（构造需要 provider / registry / 内核登记），依赖图不同。
//
// 被测链路：`noteLateNestedResult`（写）→ `_loopHost().applyPendingMemoryUpdates()`
// （每步唯一的挂起注入落地钩子，default-loop 在清空 reminder 之后调它）→
// `transientReminders`（只给本次请求，不落会话）。

import './helpers/kernel-registry';
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent';
import type { AgentLoopHost } from '../src/agent/agent-loop/types';
import { AgentContext } from '../src/agent/context';
import type { ToolRegistry } from '../src/agent/tool';
import type { Provider } from '../src/provider/types';

function stubProvider(): Provider {
  return {
    name: () => 'late-test-model',
    model: () => 'late-test-model',
    stream: async function* () {
      /* 不产流 */
    },
  };
}

function makeAgent(): Agent {
  const ctx = new AgentContext(
    { agentId: 'late-test', parentId: null, subagentDepth: 0 },
    {
      provider: stubProvider(),
      tools: { get: () => undefined } as unknown as ToolRegistry,
      eventSink: () => {},
      execState: undefined,
      messageBus: undefined,
      taskBoard: undefined,
      discoveryBoard: undefined,
    },
  );
  return new Agent(ctx, 'test');
}

/** 每步的挂起注入落地钩子（default-loop 调的就是它；private 但运行时可达）。 */
function loopHost(agent: Agent): AgentLoopHost {
  return (agent as unknown as { _loopHost(): AgentLoopHost })._loopHost();
}

describe('P1 待领信箱（Agent 侧）', () => {
  it('迟到结果在下一步注入一次，第二步不再出现', () => {
    const agent = makeAgent();
    agent.noteLateNestedResult({ name: 'office', elapsedMs: 1234, output: 'rendered ok', isError: false });
    const host = loopHost(agent);
    host.applyPendingMemoryUpdates();
    const first = host.transientReminders.join('\n');
    expect(first).toContain('office');
    expect(first).toContain('rendered ok');
    expect(first).toContain('不要重做');
    // 只投递一次：第二步（reminder 已被 default-loop 清空）不该再看到
    host.transientReminders = [];
    host.applyPendingMemoryUpdates();
    expect(host.transientReminders).toHaveLength(0);
  });

  it('容量与长度都有上限：最多 8 条、单条 800 字截断', () => {
    const agent = makeAgent();
    const long = 'x'.repeat(2000);
    for (let i = 0; i < 10; i++) {
      agent.noteLateNestedResult({ name: `t${i}`, elapsedMs: 10, output: long, isError: false });
    }
    const host = loopHost(agent);
    host.applyPendingMemoryUpdates();
    const text = host.transientReminders.join('\n');
    // 最旧的两条被挤掉，最新的在
    expect(text).not.toContain('t0（');
    expect(text).not.toContain('t1（');
    expect(text).toContain('t9（');
    // 单条正文截断（不是整条丢弃）
    expect(text).toContain('（已截断）');
  });

  it('失败结果标注为失败（不是成功）', () => {
    const agent = makeAgent();
    agent.noteLateNestedResult({ name: 'mcp', elapsedMs: 500, output: 'boom', isError: true });
    const host = loopHost(agent);
    host.applyPendingMemoryUpdates();
    expect(host.transientReminders.join('\n')).toContain('失败');
  });
});
