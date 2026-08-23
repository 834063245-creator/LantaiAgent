// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// A-3 capability 贡献通道（composition/capability-service.ts）钉住面
// （设计件 A3-capability-contribution-channel.md §3 验收）：
//   1. 注册语义：贡献经 ctx.capabilities 注册、注册序读取、disposer
//      幂等 + 陈旧性守卫；
//   2. 装载期拒绝三径：撞注册表 key / 撞 builtinCapabilities() key /
//      畸形形状（外部插件纯 JS 无 tsc——形状守卫 fail-fast）；
//   3. 消费闭环：activeCapabilityContributions()（无服务 = 空集）+
//      dispose 守卫式清空（拆卸后新装配不残留）；
//   4. 解析域：factoryComposition() 快照收编贡献（表尾注册序，builtin
//      前缀不动）；patch 可按 key disable 贡献行（diagnostics 记录）；
//      贡献 dispose → 快照行消失；
//   5. 装配消费：fromRoster 按表序装配贡献 capability（context/agent 两
//      阶段 + when() 门控）——runtime 穿线零改动的构造性验证；
//   6. 端到端：贡献 install 的工具注册在 builtin 表尾之后（Agent 装配后
//      模型可见面含贡献工具）。
// 零漂移守护：无贡献环境（convergence 夹具/生产初态）capabilities ≡
// builtinCapabilities()（roster 测试钉面 + convergence 双 preset 实测）。

import { describe, expect, it } from 'vitest';
import { AgentBlueprint, type AgentCapability, builtinCapabilities } from '../src/agent/blueprint';
import {
  activeCapabilityContributions,
  type CapabilityContribution,
  capabilitiesServicePlugin,
} from '../src/composition/capability-service';
import { factoryComposition, resolveRoster } from '../src/composition/roster';
import { Context } from '../src/cordis';

/** 记录调用序的探针贡献。 */
function probeCapability(
  key: string,
  phase: 'context' | 'agent',
  log: string[],
  when?: AgentCapability['when'],
): CapabilityContribution {
  return {
    key,
    phase,
    ...(when ? { when } : {}),
    install: () => {
      log.push(key);
    },
  };
}

/** 注册贡献的工具面贡献（install 往 scope.tools 注册一个工具——端到端用）。 */
function toolRegisteringCapability(key: string, toolName: string): CapabilityContribution {
  return {
    key,
    phase: 'agent',
    install: (scope) => {
      scope.tools.register({
        name: () => toolName,
        description: () => 'A-3 probe',
        parameters: () => ({ type: 'object', properties: {} }),
        readOnly: () => true,
        execute: async () => 'ok',
      });
    },
  };
}

describe('composition/capability-service（A-3 capability 贡献通道）', () => {
  it('注册语义：贡献经 ctx.capabilities 注册，activeCapabilityContributions 保序读取', async () => {
    const root = new Context();
    const fiber = await root.plugin(capabilitiesServicePlugin);
    expect(activeCapabilityContributions()).toEqual([]); // 起点是空集
    const a = root.capabilities.register(probeCapability('acme/ctx-probe', 'context', []));
    const b = root.capabilities.register(probeCapability('acme/agent-probe', 'agent', []));
    expect(activeCapabilityContributions().map((c) => c.key)).toEqual(['acme/ctx-probe', 'acme/agent-probe']);
    a();
    b();
    expect(activeCapabilityContributions()).toEqual([]);
    await fiber.dispose();
  });

  it('重名 key 装载期拒绝（throw，不静默覆盖）', async () => {
    const root = new Context();
    const fiber = await root.plugin(capabilitiesServicePlugin);
    root.capabilities.register(probeCapability('acme/dup', 'agent', []));
    expect(() => root.capabilities.register(probeCapability('acme/dup', 'agent', []))).toThrow(
      /duplicate contribution key/,
    );
    await fiber.dispose();
  });

  it('撞 builtinCapabilities() key 装载期拒绝（寻址空间共享——防装配期 fail-late）', async () => {
    const root = new Context();
    const fiber = await root.plugin(capabilitiesServicePlugin);
    expect(() => root.capabilities.register(probeCapability('auto-tune', 'agent', []))).toThrow(
      /与 builtin capability 撞名/,
    );
    expect(() => root.capabilities.register(probeCapability('graph-hooks', 'agent', []))).toThrow(
      /与 builtin capability 撞名/,
    );
    await fiber.dispose();
  });

  it('形状守卫：畸形贡献装载期拒绝（key 空 / phase 非法 / install 缺失）', async () => {
    const root = new Context();
    const fiber = await root.plugin(capabilitiesServicePlugin);
    expect(() =>
      root.capabilities.register({ key: '', phase: 'agent', install: () => {} } as CapabilityContribution),
    ).toThrow(/key 必须是非空 string/);
    expect(() =>
      root.capabilities.register({
        key: 'acme/bad',
        phase: 'boot',
        install: () => {},
      } as unknown as CapabilityContribution),
    ).toThrow(/phase 必须是/);
    expect(() =>
      root.capabilities.register({ key: 'acme/no-install', phase: 'agent' } as unknown as CapabilityContribution),
    ).toThrow(/缺少 install 函数/);
    expect(activeCapabilityContributions()).toEqual([]); // 拒绝 = 不入册
    await fiber.dispose();
  });

  it('disposer 幂等 + 陈旧性守卫（同 key 重注册后旧 disposer 不误删新行）', async () => {
    const root = new Context();
    const fiber = await root.plugin(capabilitiesServicePlugin);
    const stale = root.capabilities.register(probeCapability('acme/slot', 'agent', []));
    stale(); // 先注销，同 key 重注册才合法（重名是装载期拒绝）
    expect(activeCapabilityContributions()).toEqual([]);
    const fresh = root.capabilities.register(probeCapability('acme/slot', 'agent', []));
    stale(); // 陈旧 disposer 二次调用不误删新行
    expect(activeCapabilityContributions().map((c) => c.key)).toEqual(['acme/slot']);
    fresh();
    expect(activeCapabilityContributions()).toEqual([]);
    await fiber.dispose();
  });

  it('无服务环境：activeCapabilityContributions = 空集（消费面零改写）', () => {
    // 新 Context（未挂 capabilitiesServicePlugin）——模块级活动服务为 null
    // （上一个用例的 fiber dispose 后守卫式清空）
    expect(activeCapabilityContributions()).toEqual([]);
  });

  it('解析域：factoryComposition 快照收编贡献（表尾注册序，builtin 前缀不动）', async () => {
    const root = new Context();
    const fiber = await root.plugin(capabilitiesServicePlugin);
    const d1 = root.capabilities.register(probeCapability('acme/one', 'agent', []));
    const d2 = root.capabilities.register(probeCapability('acme/two', 'context', []));
    const builtinKeys = builtinCapabilities().map((c) => c.key);
    expect(factoryComposition().capabilities.map((c) => c.key)).toEqual([...builtinKeys, 'acme/one', 'acme/two']);
    // 贡献 dispose → 快照行消失（快照读取时点的通道装载态）
    d1();
    expect(factoryComposition().capabilities.map((c) => c.key)).toEqual([...builtinKeys, 'acme/two']);
    d2();
    expect(factoryComposition().capabilities.map((c) => c.key)).toEqual(builtinKeys);
    await fiber.dispose();
  });

  it('解析域：patch 按 key disable 贡献行（diagnostics 记录，builtin 行不动）', async () => {
    const root = new Context();
    const fiber = await root.plugin(capabilitiesServicePlugin);
    const d1 = root.capabilities.register(probeCapability('acme/one', 'agent', []));
    const d2 = root.capabilities.register(probeCapability('acme/two', 'agent', []));
    const r = resolveRoster(factoryComposition(), [{ capabilities: [{ id: 'acme/one', disabled: true }] }]);
    const keys = r.capabilities.map((c) => c.key);
    expect(keys).not.toContain('acme/one');
    expect(keys).toContain('acme/two');
    expect(r.diagnostics.disabled).toEqual(['acme/one']);
    // builtin 行仍可禁用（既有寻址面不受贡献收编影响）
    const r2 = resolveRoster(factoryComposition(), [{ capabilities: [{ id: 'auto-tune', disabled: true }] }]);
    expect(r2.capabilities.map((c) => c.key)).not.toContain('auto-tune');
    d1();
    d2();
    await fiber.dispose();
  });

  it('装配消费：fromRoster 按表序装配贡献（context/agent 两阶段 + when() 门控）', async () => {
    const root = new Context();
    const fiber = await root.plugin(capabilitiesServicePlugin);
    const order: string[] = [];
    root.capabilities.register(probeCapability('acme/ctx-late', 'context', order));
    root.capabilities.register(probeCapability('acme/agent-gated', 'agent', order, () => false));
    root.capabilities.register(probeCapability('acme/agent-live', 'agent', order));

    // 复刻 _assembleAgent 的 capability 循环（runtime 穿线零改动的构造性
    // 验证：fromRoster 消费整张表，贡献随表序进两阶段循环）。builtin 项的
    // install 需要真实 scope——只执行贡献项，builtin 项验证表位与门控求值。
    const bp = AgentBlueprint.fromRoster(factoryComposition().capabilities);
    // context 阶段：贡献项是表尾（builtin 前缀不动）
    const contextKeys = bp.capabilities('context').map((c) => c.key);
    expect(contextKeys).toEqual([
      ...builtinCapabilities()
        .filter((c) => c.phase === 'context')
        .map((c) => c.key),
      'acme/ctx-late',
    ]);
    // 贡献 context 项按表序执行（when 缺省恒装；builtin 项不执行 install）
    for (const cap of bp.capabilities('context')) {
      if (cap.key.startsWith('acme/') && (cap.when?.({} as never) ?? true)) cap.install({} as never);
    }
    expect(order).toEqual(['acme/ctx-late']);

    // agent 阶段：贡献项在表尾（gated 项在 live 项之前——注册序）
    const agentKeys = bp.capabilities('agent').map((c) => c.key);
    expect(agentKeys.slice(-2)).toEqual(['acme/agent-gated', 'acme/agent-live']);
    // when() 门控：agent 阶段循环跳过 gated 项（builtin 项的 when/install
    // 需要真实 scope——只对贡献项求值执行，表位已由 keys 断言钉住）
    const executed: string[] = [];
    for (const cap of bp.capabilities('agent')) {
      if (!cap.key.startsWith('acme/')) {
        executed.push(cap.key);
        continue;
      }
      if (cap.when?.({} as never) ?? true) {
        cap.install({} as never);
        executed.push(cap.key);
      }
    }
    expect(executed).not.toContain('acme/agent-gated'); // 门控生效
    expect(executed.at(-1)).toBe('acme/agent-live'); // 表尾贡献存活且最后执行
    await fiber.dispose();
  });

  it('端到端：贡献 install 的工具注册进 Agent 装配面（builtin 表尾之后）', async () => {
    const root = new Context();
    const fiber = await root.plugin(capabilitiesServicePlugin);
    root.capabilities.register(toolRegisteringCapability('acme/tool-probe', 'acme_probe_tool'));

    const { AgentRuntime } = await import('../src/agent/runtime/runtime');
    const { ToolRegistry } = await import('../src/agent/tool');
    const { readOnlyTool, scriptedProvider } = await import('./convergence/helpers/fixtures');
    const rt = new AgentRuntime(); // 无 projectPath → 纯内存；composition 缺省
    await rt.ready();
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());
    const handle = await rt.createAgent({
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools,
      eventSink: () => {},
    });
    const names = (handle as unknown as { _getAgent(): { tools: ToolRegistry } })
      ._getAgent()
      .tools.all()
      .map((t) => t.name());
    expect(names).toContain('acme_probe_tool'); // 贡献工具进模型可见面
    // builtin 表尾之后（converge-tools 折叠面之后——表尾追加序）
    expect(names.indexOf('acme_probe_tool')).toBeGreaterThan(names.indexOf('read_file'));
    handle.dispose();

    // 通道拆卸后守卫式清空——新装配不再折叠贡献
    await fiber.dispose();
    expect(activeCapabilityContributions()).toEqual([]);
    const rt2 = new AgentRuntime();
    await rt2.ready();
    const tools2 = new ToolRegistry();
    tools2.register(readOnlyTool());
    const handle2 = await rt2.createAgent({
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools: tools2,
      eventSink: () => {},
    });
    const names2 = (handle2 as unknown as { _getAgent(): { tools: ToolRegistry } })
      ._getAgent()
      .tools.all()
      .map((t) => t.name());
    expect(names2).not.toContain('acme_probe_tool'); // 拆卸后不残留
    handle2.dispose();
  });

  it('贡献变更 = 组合输入变更（代数钩子可订阅——preset-assembly/bootShell 消费面）', async () => {
    const root = new Context();
    const fiber = await root.plugin(capabilitiesServicePlugin);
    let generation = 0;
    const { onCapabilityContributionsChanged } = await import('../src/composition/capability-service');
    const off = onCapabilityContributionsChanged(() => generation++);
    expect(generation).toBe(0);
    const d = root.capabilities.register(probeCapability('acme/gen', 'agent', []));
    expect(generation).toBe(1); // register 触发
    d();
    expect(generation).toBe(2); // 实际删除触发
    off();
    await fiber.dispose();
  });
});
