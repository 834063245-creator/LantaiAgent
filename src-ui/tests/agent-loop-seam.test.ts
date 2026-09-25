// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ctx.agentLoop seam 守护（平台化 Phase 5 · D13，2026-08-28；批 9h-2 修订）：
//   ① 服务构造期登记默认实现；active() 后注册胜（替换契约）
//   ② 无服务环境 resolveAgentLoop **具名 fail-loud**（批 9h-2：出厂实现随包后，
//      内核不再持有兜底实现——此前这里是「回落默认」的旧行为，已按行为退役重写）
//   ③ Agent 装配：显式注入的替换 loop 接管 runLoop（host 面活性断言）
//   ④ 默认 loop id = builtin/default（出厂面可寻址证明；实现现在住产物包）

import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent';
import { resetAgentLoopForTests, resolveAgentLoop } from '../src/agent/agent-loop/agent-loop-active';
import type { AgentLoop, AgentLoopHost } from '../src/agent/agent-loop/types';
import { AgentContext } from '../src/agent/context';
import { createExecState, type ExecStateInstance } from '../src/agent/execution-state';
import type { ToolRegistry } from '../src/agent/tool';
import { Context } from '../src/cordis';
import { AgentLoopService, agentLoopServicePlugin } from '../src/plugins/builtin/agent-loop-service';
// 批 9h-2：出厂默认实现随包（原 src/agent/agent-loop/default-loop.ts）
import { DEFAULT_AGENT_LOOP_ID, defaultAgentLoop } from '../src/plugins/builtin/agent-loop-service/default-loop';
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
    model: () => 'loop-test-model',
    stream: async function* () {
      /* 不产流 */
    },
  };
}

function stubRegistry(): ToolRegistry {
  return { get: () => undefined } as unknown as ToolRegistry;
}

function testAgent(opts: { agentLoop?: AgentLoop; execState?: ExecStateInstance } = {}): Agent {
  const ctx = new AgentContext(
    { agentId: 'loop-test', parentId: null, subagentDepth: 0 },
    {
      provider: stubProvider(),
      tools: stubRegistry(),
      eventSink: () => {},
      execState: opts.execState,
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

  it('② 无服务环境 resolveAgentLoop 具名 fail-loud（内核不再兜底出厂实现）', () => {
    resetAgentLoopForTests();
    expect(() => resolveAgentLoop()).toThrowError(/AGENT_LOOP_UNAVAILABLE/);
  });

  it('②b 服务在场即取注册表当前实现（出厂实现 = 产物包内那一份）', async () => {
    const { service, dispose } = await booted();
    expect(resolveAgentLoop().id).toBe(DEFAULT_AGENT_LOOP_ID);
    expect(resolveAgentLoop()).toBe(service.active()); // 同一实现引用——无兼容分支
    await dispose();
  });

  it('③ Agent 装配：显式注入的替换 loop 接管 runLoop；host 面活性断言', async () => {
    const exec = createExecState();
    const seen: Array<{ kind: string; reminders: string[]; contextWindow: number; id: string }> = [];
    const custom: AgentLoop = {
      id: 'test/replacing-loop',
      run: async (host: AgentLoopHost, signal) => {
        // 宿主面活性：写标量 → 读回（Agent 侧字段真的变了）。
        // 契约 v43 起 `isRunning` 成员退役——「在不在跑」归运行账（见下方断言），
        // loop 不再声明自己的运行状态。
        seen.push({
          kind: 'enter',
          reminders: [...host.transientReminders],
          contextWindow: host.contextWindow,
          id: host.id,
        });
        // loop 在跑 ⟺ 账上有一条活记录（Agent 已认领本轮 signal；替换实现不必自己登记）
        expect(exec.isRunning).toBe(true);
        expect(exec.runFor(signal)?.kind).toBe('turn');
        host.transientReminders = ['a', 'b'];
        host.transientReminders = [...host.transientReminders, 'c'];
        seen.push({
          kind: 'mutations',
          reminders: [...host.transientReminders],
          contextWindow: host.contextWindow,
          id: host.id,
        });
        host.sink({ kind: 0, text: 'probe' } as never);
        expect(signal.aborted).toBe(false);
      },
    };
    const agent = testAgent({ agentLoop: custom, execState: exec });
    await agent.run(new AbortController().signal, 'hello');
    expect(seen[0]).toEqual({ kind: 'enter', reminders: [], contextWindow: 1000000, id: 'loop-test' });
    // 写标量 → 读回（Agent 侧字段真的变了）
    expect(seen[1]).toEqual({ kind: 'mutations', reminders: ['a', 'b', 'c'], contextWindow: 1000000, id: 'loop-test' });
    // 默认实现未介入：默认 loop 的 turn/step 事件未发射（替换实现完全接管）
    expect(seen.map((s) => s.kind)).toEqual(['enter', 'mutations']);
    // 运行态（v43）：loop 只管跑——run() 收尾即注销自己那条记录
    expect(exec.isRunning).toBe(false);
    expect(agent.isRunning).toBe(false);
  });

  it('④ 默认实现可寻址：builtin/default 是出厂面一条真实现', () => {
    expect(DEFAULT_AGENT_LOOP_ID).toBe('builtin/default');
    expect(typeof defaultAgentLoop.run).toBe('function');
  });
});
