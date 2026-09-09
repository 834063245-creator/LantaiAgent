// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Phase 6 T1 — AgentBlueprint 声明式组合原语行为规约。
// 重复 key 拒绝 / 表序保持 / when() 门控 / fromRoster 实例隔离与表审计。
// B⑤（2026-08-24）：standard() 与 builtinCapabilities() 退役——出厂
// capability 面经 ctx.capabilities 通道贡献（firstPartyCapabilities() 是
// 十五项定义真源，plugins/capability-segments-plugin.ts 装载）。表序冻结
// 断言换代为「钉通道面」：通道在册的 factoryComposition().capabilities
// keys ≡ firstPartyCapabilities() 清单序 ≡ 迁移前出厂表序。

import { describe, expect, it } from 'vitest';
import {
  AgentBlueprint,
  type AgentCapability,
  type BlueprintScope,
  firstPartyCapabilities,
} from '../src/agent/blueprint';
import type { DiagnosticsSource } from '../src/agent/state-inject';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { factoryComposition } from '../src/composition/roster';

/** 最小 capability 构造（install 记录调用序）。 */
function cap(
  key: string,
  phase: 'context' | 'agent',
  order: string[],
  when?: AgentCapability['when'],
): AgentCapability {
  return {
    key,
    phase,
    ...(when ? { when } : {}),
    install: () => {
      order.push(key);
    },
  };
}

/** 最小 scope 桩 — 原语级测试不触发真实装配。 */
function stubScope(): BlueprintScope {
  return {
    ctx: {} as BlueprintScope['ctx'],
    inputs: {},
    tools: {} as BlueprintScope['tools'],
    hooks: {} as BlueprintScope['hooks'],
    preflightHooks: {} as BlueprintScope['preflightHooks'],
    deps: {
      isolationExec: async () => '',
      messageBus: {} as BlueprintScope['deps']['messageBus'],
    },
  };
}

describe('AgentBlueprint T1 — 原语行为', () => {
  it('重复 key 拒绝（构造与 add 双路径）', () => {
    expect(() => new AgentBlueprint([cap('a', 'agent', []), cap('a', 'context', [])])).toThrow(/key 重复: a/);
    const bp = new AgentBlueprint([cap('a', 'agent', [])]);
    expect(() => bp.add(cap('a', 'context', []))).toThrow(/key 重复: a/);
  });

  it('capabilities() 按阶段过滤且保持声明序；keys() 反映追加', () => {
    const order: string[] = [];
    const bp = new AgentBlueprint([cap('a', 'context', order), cap('b', 'agent', order), cap('c', 'context', order)]);
    expect(bp.capabilities('context').map((c) => c.key)).toEqual(['a', 'c']);
    expect(bp.capabilities('agent').map((c) => c.key)).toEqual(['b']);
    expect(bp.capabilities().map((c) => c.key)).toEqual(['a', 'b', 'c']);
    bp.add(cap('d', 'agent', order));
    expect(bp.keys()).toEqual(['a', 'b', 'c', 'd']);
    expect(bp.capability('b')?.phase).toBe('agent');
    expect(bp.capability('nope')).toBeUndefined();
  });

  it('install/when 直行：when 缺省恒装，返回 false 跳过', () => {
    const order: string[] = [];
    const scope = stubScope();
    const bp = new AgentBlueprint([
      cap('a', 'context', order),
      cap('gated', 'context', order, () => false),
      cap('kept', 'context', order, () => true),
    ]);
    for (const c of bp.capabilities('context')) {
      if (c.when?.(scope) ?? true) c.install(scope);
    }
    expect(order).toEqual(['a', 'kept']);
  });

  it('fromRoster 每次返回全新实例 — 扩展不污染源表', () => {
    const a = AgentBlueprint.fromRoster(firstPartyCapabilities());
    const before = a.keys().length;
    a.add(cap('custom-x', 'agent', []));
    expect(a.keys()).toContain('custom-x');
    const b = AgentBlueprint.fromRoster(firstPartyCapabilities());
    expect(b.keys()).not.toContain('custom-x');
    expect(b.keys()).toHaveLength(before);
  });

  it('第一方 capability 表序冻结（钉通道面——新增 capability 必须显式改此断言）', async () => {
    // B⑤：出厂面经 ctx.capabilities 通道贡献——表序断言钉「通道快照 =
    // 清单序 = 迁移前出厂表序」三重等价（快照序由注册序保住）
    const expected = [
      // context 阶段
      'plan-tools',
      // agent 阶段（注册序 = 工具面序 — phase-1 effective 快照钉字节）
      'communication-tools',
      'discovery-tools',
      'merge-tools',
      'request-tool',
      'spawn-tool',
      'task-tools',
      'compaction-tools',
      'code-execution-tool',
      'converge-tools',
      'state-hooks',
      'board-tracking-hook',
      'plan-injector',
      'auto-tune',
    ];
    expect(firstPartyCapabilities().map((c) => c.key)).toEqual(expected);
    await withFirstPartyCapabilityChannel(async () => {
      expect(factoryComposition().capabilities.map((c) => c.key)).toEqual(expected);
    });
  });

  it('第一方 capability 均声明 key/phase/install', () => {
    for (const c of firstPartyCapabilities()) {
      expect(c.key, 'key 必须非空').toMatch(/^[a-z][a-z0-9-]*$/);
      expect(['context', 'agent']).toContain(c.phase);
      expect(typeof c.install).toBe('function');
    }
  });
});

describe('state-hooks capability — 状态 + 构建结果 hooks（图谱退役后）', () => {
  /** 记名注册表桩 — 只记录 hook 名，不跑 apply/check。 */
  function recordingRegistries() {
    const hookNames: string[] = [];
    const preflightNames: string[] = [];
    const hooks = {
      register: (h: { name: string }) => {
        hookNames.push(h.name);
        return () => {};
      },
    };
    const preflightHooks = {
      register: (h: { name: string }) => {
        preflightNames.push(h.name);
        return () => {};
      },
    };
    return { hooks, preflightHooks, hookNames, preflightNames };
  }

  function stateHooksCap(): AgentCapability {
    const cap = firstPartyCapabilities().find((c) => c.key === 'state-hooks');
    if (!cap) throw new Error('state-hooks capability 缺席');
    return cap;
  }

  /** state-hooks 安装面 scope 桩（图谱退役后无 graphContext 面——纯状态 hooks）。 */
  function capScope(overrides: {
    diagnosticsSource?: DiagnosticsSource;
    hooksEnabled?: boolean;
    hooks?: unknown;
    preflightHooks?: unknown;
  }): BlueprintScope {
    return {
      ctx: { projectPath: 'D:/proj/demo', resolve: () => ({}) } as unknown as BlueprintScope['ctx'],
      inputs: { ...(overrides.hooksEnabled !== undefined ? { hooksEnabled: overrides.hooksEnabled } : {}) },
      tools: {} as BlueprintScope['tools'],
      hooks: (overrides.hooks ?? {}) as BlueprintScope['hooks'],
      preflightHooks: (overrides.preflightHooks ?? {}) as BlueprintScope['preflightHooks'],
      deps: {
        isolationExec: async () => '',
        messageBus: {} as BlueprintScope['deps']['messageBus'],
        ...(overrides.diagnosticsSource ? { diagnosticsSource: overrides.diagnosticsSource } : {}),
      },
    };
  }

  it('LSP 诊断源在场：state hooks 注册 + build-result hook 注册', () => {
    const { hooks, preflightHooks, hookNames, preflightNames } = recordingRegistries();
    const diagSource: DiagnosticsSource = () => [];
    const scope = capScope({ diagnosticsSource: diagSource, hooks, preflightHooks });
    stateHooksCap().install(scope);
    expect(hookNames).toEqual(['state-read', 'build-result']);
    expect(preflightNames).toEqual(['state-preflight']);
  });

  it('诊断源缺席：仅 build-result hook（构建缓存注入不依赖 LSP）', () => {
    const { hooks, preflightHooks, hookNames, preflightNames } = recordingRegistries();
    const scope = capScope({ hooks, preflightHooks });
    stateHooksCap().install(scope);
    expect(hookNames).toEqual(['build-result']);
    expect(preflightNames).toEqual([]);
  });

  it('hooksEnabled=false：全不注册（提示注入类总开关）', () => {
    const { hooks, preflightHooks, hookNames, preflightNames } = recordingRegistries();
    const diagSource: DiagnosticsSource = () => [];
    const scope = capScope({ diagnosticsSource: diagSource, hooksEnabled: false, hooks, preflightHooks });
    stateHooksCap().install(scope);
    expect(hookNames).toEqual([]);
    expect(preflightNames).toEqual([]);
  });
});
