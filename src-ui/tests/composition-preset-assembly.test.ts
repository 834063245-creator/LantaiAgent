// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S4-1a 装配穿线 + 会话绑定测试 — 设计件 §3 S4-1a 验收：
//   1. 带 composition 覆盖的装配：工具面/prompt 反映 preset（minimal 禁
//      browser-desktop/web 工具行 + graph-hooks capability）；
//   2. 不带覆盖 = S2 现状零漂移；
//   3. 会话作用域注册表路径（resolved ≠ 工作区默认时工厂自建注册表——
//      workspace 源码窗口断言，与 workspace-lifecycle.test.ts 同款纪律）；
//   4. 子 Agent 与父同面（ctx composition 服务 child() 继承）；
//   5. preset-assembly：cache 引用稳定 + 用户层 hash 变更失效（R13）+
//      applyDefaultPreset 跳过语义。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentContext } from '../src/agent/context';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import type { AgentHandle } from '../src/agent/runtime/types';
import { ToolRegistry } from '../src/agent/tool';
import { withFirstPartyPromptChannel } from '../src/composition/first-party-prompts';
import {
  clearUserPatch,
  invalidatePresetCache,
  registerUserPatch,
  resolveCurrentComposition,
  syncPresetSelectionFromSettings,
} from '../src/composition/preset-assembly';
import { factoryComposition, type ResolvedComposition, resolveRoster } from '../src/composition/roster';
import { builtinToolRows } from '../src/composition/tool-rows';
import { useCompositionStore } from '../src/state/composition-store';
import { usePresetStore } from '../src/state/preset-store';
import { readOnlyTool, scriptedProvider } from './convergence/helpers/fixtures';

const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id);

/** minimal preset 的解析产物（穿线效果样本）。 */
function minimalComposition(): ResolvedComposition {
  return resolveRoster(factoryComposition(), [
    {
      tools: [
        { id: 'builtin/browser-desktop', disabled: true },
        { id: 'builtin/web', disabled: true },
      ],
      capabilities: [{ id: 'graph-hooks', disabled: true }],
    },
  ]);
}

/** phase-6 同款手工 ctx（纯内存 bus/boards，零持久化副作用）。 */
function makeCtx(agentId: string, rt: AgentRuntime): AgentContext {
  const tools = new ToolRegistry();
  tools.register(readOnlyTool());
  return new AgentContext(
    { agentId, parentId: null, subagentDepth: 0, projectPath: '/projects/demo' },
    { provider: scriptedProvider([]), tools, eventSink: () => {}, messageBus: rt.getBus() },
  );
}

function agentOf(h: AgentHandle): { tools: ToolRegistry; composition: ResolvedComposition | null } {
  const agent = (
    h as unknown as { _getAgent(): { tools: ToolRegistry; composition: ResolvedComposition | null } }
  )._getAgent();
  return { tools: agent.tools, composition: agent.composition };
}

function sysOf(h: AgentHandle): string {
  const agent = (
    h as unknown as { _getAgent(): { getSession(): Array<{ role: string; content: unknown }> } }
  )._getAgent();
  return String(agent.getSession()[0]?.content ?? '');
}

describe('S4-1a 装配穿线：createAgentFromContext/createAgent 组合覆盖', () => {
  it('不带覆盖 = S2 现状零漂移（Agent.composition = runtime 组合，引用透传）', async () => {
    const rt = new AgentRuntime();
    await rt.ready();
    const h = await rt.createAgentFromContext(makeCtx('s41a-default', rt), {});
    const { tools, composition } = agentOf(h);
    expect(tools.all().length).toBeGreaterThan(0);
    // 缺省路径：ctx composition 服务 = runtime 组合（Agent 可见自己的装配真源）
    expect(composition).not.toBeNull();
    expect(ids(composition ? composition.tools : [])).toEqual(ids(builtinToolRows())); // factory 组合
    h.dispose();
  });

  it('带 minimal 覆盖：Agent.composition = 覆盖组合；prompt 段表反映 preset', async () => {
    // B④ 收官（2026-08-23）：第一方面 13 段全经 ctx.prompts 通道贡献——
    // 系统提示词内容断言须在通道腰内复现生产装配面
    await withFirstPartyPromptChannel(async () => {
      const rt = new AgentRuntime();
      await rt.ready();
      const minimal = minimalComposition();
      // graphData 在场 → 完整面（多 Agent 段/图纪律段参与——minimal 未禁它们）
      const h = await rt.createAgentFromContext(
        makeCtx('s41a-minimal', rt),
        { graphData: { nodes: [] } },
        undefined,
        minimal,
      );
      const { composition } = agentOf(h);
      expect(composition).toBe(minimal); // ctx 服务写入的就是覆盖对象（引用透传）
      const sys = sysOf(h);
      expect(sys).toContain('多 Agent 协作'); // 未被禁的段仍在
      h.dispose();
    });
  });

  it('带覆盖 + capability 禁用：graph-hooks 不装（graphContext 存在时 hooks 不注册）', async () => {
    const rt = new AgentRuntime();
    await rt.ready();
    const minimal = minimalComposition();
    // graph-hooks 禁用 → loadEngineSnapshot 等 capability 不跑；结构断言：
    // 装配成功 + plan 工具面（context 阶段 capability）不受影响
    const h = await rt.createAgentFromContext(
      makeCtx('s41a-caps', rt),
      { graphData: { nodes: [] } },
      undefined,
      minimal,
    );
    const { tools } = agentOf(h);
    expect(tools.all().map((t) => t.name())).toContain('enter_plan_mode');
    expect(tools.all().map((t) => t.name())).toContain('exit_plan_mode');
    h.dispose();
  });

  it('createAgent(config, compositionOverride)：覆盖经翻译层到达装配本体', async () => {
    const rt = new AgentRuntime();
    await rt.ready();
    const minimal = minimalComposition();
    const h = await rt.createAgent(
      {
        agentId: 's41a-config',
        projectPath: '/projects/demo',
        provider: scriptedProvider([]),
        tools: new ToolRegistry(),
        eventSink: () => {},
      },
      minimal,
    );
    expect(agentOf(h).composition).toBe(minimal);
    h.dispose();
  });
});

describe('S4-1a 子 Agent 继承：ctx composition 服务 child() 白名单', () => {
  it('child() 继承 composition（子 Agent 与父同一组合面）', () => {
    const minimal = minimalComposition();
    const parent = new AgentContext(
      { agentId: 'parent-1', parentId: null, subagentDepth: 0, projectPath: '/p' },
      { composition: minimal },
    );
    const child = parent.child({ agentId: 'sub-1' });
    expect(child.get('composition')).toBe(minimal);
  });
  it('spawnSubAgent 的子 Agent ctx 携带父组合（this._ctx.child 继承面）', () => {
    // child() 继承已在上一用例钉住；此处钉 spawnSubAgent 的派生路径本身
    // 走 this._ctx.child（子 Agent 组合面 = 父的 ctx 服务表——不经环境变量
    // 或全局 store，透传是显式的）。
    // 11c 拆分：spawnSubAgent 原体迁 subagent-spawn.ts（agent.ts 留薄委托），
    // 断言定位点随迁，钉住的不变量不变（this._ctx → .child() 调用链）。
    const src = readFileSync(path.resolve(process.cwd(), 'src/agent/subagent-spawn.ts'), 'utf8');
    const spawnIdx = src.indexOf('export async function spawnSubAgentImpl(');
    expect(spawnIdx).toBeGreaterThan(0);
    // child() 调用在 spawnSubAgentImpl 函数体内（isolation/所有权包装之后）
    const window = src.slice(spawnIdx, spawnIdx + 14000);
    const childIdx = window.indexOf('ag._ctx');
    expect(childIdx).toBeGreaterThan(0);
    expect(window.slice(childIdx, childIdx + 600)).toContain('.child(');
  });
});

describe('S4-1a preset-assembly：cache + 选择同步 + boot 应用', () => {
  beforeEach(() => {
    // roster 重置为内置表 + selected 回 standard（PresetStoreState 直写——
    // store 是 zustand，setState 部分字段即可）
    usePresetStore.setState({ selected: 'standard' });
    invalidatePresetCache();
    clearUserPatch();
    useCompositionStore.setState({
      status: 'factory',
      patchOrigin: undefined,
      error: undefined,
      resolved: factoryComposition(),
    });
  });

  it('resolveCurrentComposition：standard ≡ factory（无用户层）', () => {
    const r = resolveCurrentComposition('standard');
    expect(ids(r.tools)).toEqual(ids(builtinToolRows()));
  });

  it('引用稳定：同 (presetId, 用户层) 多次调用返回同一对象', () => {
    const a = resolveCurrentComposition('minimal');
    const b = resolveCurrentComposition('minimal');
    expect(b).toBe(a);
  });

  it('用户层 hash 变更 → cache 失效（R13：改用户层后新装配用新组合）', () => {
    const before = resolveCurrentComposition('standard');
    registerUserPatch({ tools: [{ id: 'builtin/wait', disabled: true }] });
    const after = resolveCurrentComposition('standard');
    expect(after).not.toBe(before);
    expect(ids(after.tools)).not.toContain('builtin/wait');
    // preset 层叠加：minimal 在用户层之上再禁（同 id 后写胜）
    const stacked = resolveCurrentComposition('minimal');
    expect(ids(stacked.tools)).not.toContain('builtin/web');
    expect(ids(stacked.tools)).not.toContain('builtin/wait');
  });

  it('selected 缺省 = preset-store.selected（无参调用读运行时真源）', () => {
    usePresetStore.getState().select('minimal');
    const r = resolveCurrentComposition();
    expect(ids(r.tools)).not.toContain('builtin/browser-desktop');
  });

  it('syncPresetSelectionFromSettings：缺省容错（无 composition 字段 → standard）', () => {
    // settings 走 localStorage——测试环境无存储 → loadSettings 返回 DEFAULTS
    // （composition.preset = 'standard'）；先污染 selected 再同步
    usePresetStore.getState().select('minimal');
    syncPresetSelectionFromSettings();
    expect(usePresetStore.getState().selected).toBe('standard');
  });

  it('applyDefaultPreset：standard = 空 patch → composition-store 不动（零漂移）', async () => {
    const { applyDefaultPreset } = await import('../src/composition/preset-assembly');
    const before = useCompositionStore.getState();
    applyDefaultPreset();
    const after = useCompositionStore.getState();
    expect(after.status).toBe('factory');
    expect(after.resolved).toBe(before.resolved); // 引用不变 = store 未被触碰
  });

  it('applyDefaultPreset：minimal → setResolved（preset 层写进 S2 store）', async () => {
    const { applyDefaultPreset } = await import('../src/composition/preset-assembly');
    usePresetStore.getState().select('minimal');
    applyDefaultPreset();
    const s = useCompositionStore.getState();
    expect(s.status).toBe('ok');
    expect(s.patchOrigin).toContain('preset:minimal');
    expect(ids(s.resolved.tools)).not.toContain('builtin/browser-desktop');
  });

  it('applyDefaultPreset：error 态跳过（S2 可见面保持，不被 preset 改写）', async () => {
    const { applyDefaultPreset } = await import('../src/composition/preset-assembly');
    useCompositionStore.getState().setError('bad patch', 'roster.patch.yml');
    usePresetStore.getState().select('minimal');
    applyDefaultPreset();
    const s = useCompositionStore.getState();
    expect(s.status).toBe('error'); // 仍是 error 态
    expect(s.error).toBe('bad patch');
    expect(ids(s.resolved.tools)).toEqual(ids(builtinToolRows())); // factory 兜底未被动
  });
});

describe('S4-1a workspace 会话工厂：会话作用域注册表路径（源码窗口断言）', () => {
  const src = readFileSync(path.resolve(process.cwd(), 'src/workspace.ts'), 'utf8');

  it('工厂读 resolveCurrentComposition 并做引用不等判定', () => {
    const i = src.indexOf('const factory = async (): Promise<AgentHandle | null> => {');
    expect(i).toBeGreaterThan(0);
    const window = src.slice(i, i + 1600);
    expect(window).toContain('resolveCurrentComposition()');
    expect(window).toContain('sessionComposition !== composition');
  });

  it('覆盖存在时走 buildToolRegistry({toolRows: compositionOverride.tools})', () => {
    const i = src.indexOf('const factory = async (): Promise<AgentHandle | null> => {');
    const window = src.slice(i, i + 2400);
    expect(window).toContain('compositionOverride');
    expect(window).toContain('toolRows: compositionOverride.tools');
    expect(window).toContain('tools: sessionRegistry');
  });

  it('覆盖经 createAgent 第二参透传（AgentConfig 面冻结不破）', () => {
    const i = src.indexOf('const factory = async (): Promise<AgentHandle | null> => {');
    const window = src.slice(i, i + 6000);
    expect(window).toContain('compositionOverride,');
  });
});
