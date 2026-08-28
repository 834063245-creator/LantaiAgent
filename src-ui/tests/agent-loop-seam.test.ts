// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ctx.agentLoop seam 守护（平台化 Phase 5 · D13，2026-08-28）：
//   ① 服务构造期登记默认实现；active() 后注册胜（替换契约）
//   ② 无服务环境 resolveAgentLoop 回落默认（单一实现，无兼容分支）
//   ③ Agent 装配：显式注入的替换 loop 接管 runLoop（host 面活性断言）
//   ④ 默认 loop id = builtin/default（出厂面可寻址证明）

import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent';
import {
  AgentLoopService,
  agentLoopServicePlugin,
  resetAgentLoopForTests,
  resolveAgentLoop,
} from '../src/agent/agent-loop/agent-loop-service';
import { DEFAULT_AGENT_LOOP_ID, defaultAgentLoop } from '../src/agent/agent-loop/default-loop';
import type { AgentLoop, AgentLoopHost } from '../src/agent/agent-loop/types';
import { AgentContext } from '../src/agent/context';
import type { ToolRegistry } from '../src/agent/tool';
import { Context } from '../src/cordis';
import type { Provider } from '../src/provider/types';

afterEach(() => {
  resetAgentLoopForTests();
});

async function booted(): Promise<{ service: AgentLoopService; dispose: () => Promise<void> }> {
  const root = new Context();
  await root.plugin(agentLoopServicePlugin);
  const service = (root as unknown as { agentLoop: AgentLoopService }).agentLoop;
  expect(service).toBeInstanceOf(AgentLoopService);
  return { service, dispose: () => root.fiber.dispose() };
}

function stubProvider(): Provider {
  return {
    name: () => 'loop-test-model',
    stream: async function* () {
      /* 不产流 */
    },
  };
}

function stubRegistry(): ToolRegistry {
  return { get: () => undefined } as unknown as ToolRegistry;
}

function testAgent(opts: { agentLoop?: AgentLoop } = {}): Agent {
  const ctx = new AgentContext(
    { agentId: 'loop-test', parentId: null, subagentDepth: 0 },
    {
      provider: stubProvider(),
      tools: stubRegistry(),
      eventSink: () => {},
      execState: undefined,
      messageBus: undefined,
      taskBoard: undefined,
      discoveryBoard: undefined,
    },
  );
  return new Agent(ctx, 'test', { ...opts });
}

describe('ctx.agentLoop（D13 loop seam）', () => {
  it('① 服务构造期登记默认实现；active() 后注册胜（替换契约）', async () => {
    const { service, dispose } = await booted();
    expect(service.list().map((l) => l.id)).toContain(DEFAULT_AGENT_LOOP_ID);
    expect(service.active().id).toBe(DEFAULT_AGENT_LOOP_ID);
    const custom: AgentLoop = { id: 'third-party/loop', run: async () => {} };
    const disposeCustom = service.register(custom);
    expect(service.active().id).toBe('third-party/loop');
    disposeCustom();
    expect(service.active().id).toBe(DEFAULT_AGENT_LOOP_ID);
    await dispose();
  });

  it('② 无服务环境 resolveAgentLoop 回落默认（单一实现）', () => {
    expect(resolveAgentLoop().id).toBe(DEFAULT_AGENT_LOOP_ID);
    expect(resolveAgentLoop()).toBe(defaultAgentLoop); // 同一实现引用——无兼容分支
  });

  it('③ Agent 装配：显式注入的替换 loop 接管 runLoop；host 面活性断言', async () => {
    const seen: Array<{ kind: string; isRunning: boolean; contextWindow: number; id: string }> = [];
    const custom: AgentLoop = {
      id: 'test/replacing-loop',
      run: async (host: AgentLoopHost, signal) => {
        seen.push({ kind: 'enter', isRunning: host.isRunning, contextWindow: host.contextWindow, id: host.id });
        // 宿主面活性：写标量 → 读回（Agent 侧字段真的变了）
        host.isRunning = true;
        host.transientReminders = ['a', 'b'];
        host.transientReminders = [...host.transientReminders, 'c'];
        seen.push({ kind: 'mutations', isRunning: host.isRunning, contextWindow: host.contextWindow, id: host.id });
        host.sink({ kind: 0, text: 'probe' } as never);
        expect(signal.aborted).toBe(false);
      },
    };
    const agent = testAgent({ agentLoop: custom });
    await agent.run(new AbortController().signal, 'hello');
    // run() 入口已置 isRunning=true——loop 入口读到的是活值
    expect(seen[0]).toEqual({ kind: 'enter', isRunning: true, contextWindow: 1000000, id: 'loop-test' });
    expect(seen[1]).toEqual({ kind: 'mutations', isRunning: true, contextWindow: 1000000, id: 'loop-test' });
    // 默认实现未介入：默认 loop 的 turn/step 事件未发射（替换实现完全接管）
    expect(seen.map((s) => s.kind)).toEqual(['enter', 'mutations']);
  });

  it('④ 默认实现可寻址：builtin/default 是出厂面一条真实现', () => {
    expect(DEFAULT_AGENT_LOOP_ID).toBe('builtin/default');
    expect(typeof defaultAgentLoop.run).toBe('function');
  });
});
