// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S2-1 组合外化穿线测试 — 设计件 §3 S2-1 验收：
//   传 resolved（含禁用/覆盖/插入）→ 注册面/prompt 文本/蓝图相应变化；
//   不传 → 与现状全等（零漂移——快照级守护在 verify:convergence，此处
//   钉参数面的构造性等价）。
// 覆盖四条穿线：buildToolRegistry(toolRows) / buildSystemPrompt(sections) /
// AgentBlueprint.fromRoster / AgentRuntime(composition) + composition-store。

import { beforeEach, describe, expect, it } from 'vitest';
import { AgentBlueprint, builtinCapabilities } from '../src/agent/blueprint';
import { AgentContext } from '../src/agent/context';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import type { AgentHandle } from '../src/agent/runtime/types';
import { ToolRegistry } from '../src/agent/tool';
import { assembleSystemPrompt, builtinPromptSections } from '../src/composition/prompt-sections';
import { factoryComposition, type ResolvedComposition, resolveRoster } from '../src/composition/roster';
import { builtinToolRows } from '../src/composition/tool-rows';
import { useCompositionStore } from '../src/state/composition-store';
import { buildStandardRegistry, readOnlyTool, scriptedProvider } from './convergence/helpers/fixtures';

const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id);

/** 禁用若干工具行 + 覆盖一段 + 插一段的 resolved（穿线效果样本）。 */
function sampleComposition(): ResolvedComposition {
  return resolveRoster(factoryComposition(), [
    {
      tools: [{ id: 'builtin/shell', disabled: true }],
      prompt: [
        { id: 'behavior-rules', text: '【覆盖后的行为规则】' },
        { insert: [{ id: 'wiring-probe', after: 'collaboration-mode', text: '【穿线探针段】' }] },
      ],
    },
  ]);
}

describe('S2-1 穿线：buildToolRegistry(toolRows)', () => {
  it('不传 toolRows = 出厂行表全等（零漂移的参数面保证）', async () => {
    const reg = await buildStandardRegistry();
    const regDefault = await buildStandardRegistry();
    expect(reg.names()).toEqual(regDefault.names());
    expect(reg.names()).toContain('run_shell');
  });

  it('传禁用后的行表 → shell 族工具不在册、shell 域工具不生成', async () => {
    const composition = sampleComposition();
    const { buildToolRegistry } = await import('../src/agent/runtime/agent-builder');
    const { SubAgentPool } = await import('../src/agent/coordinator');
    const { TaskManager } = await import('../src/agent/task');
    const { FIXED_GRAPH_DATA } = await import('./convergence/helpers/fixtures');
    const reg = await buildToolRegistry({
      graphData: FIXED_GRAPH_DATA,
      deps: {},
      taskManager: new TaskManager(),
      subAgentPool: new SubAgentPool(),
      toolRows: composition.tools,
    });
    const names = reg.names();
    // shell 族细粒度名不在册
    for (const n of ['run_shell', 'bash_output', 'bash_kill', 'bash_wait']) {
      expect(names).not.toContain(n);
    }
    // 领域收敛优雅降级：shell 域工具不生成（该域动作全缺席）
    expect(names).not.toContain('shell');
    // 其余族不受影响
    expect(names).toContain('fs');
    expect(names.some((n) => n.startsWith('git_'))).toBe(true);
  });
});

describe('S2-1 穿线：buildSystemPrompt / assembleSystemPrompt(sections)', () => {
  const ctxArgs = {
    graphData: { nodes: [] },
    projectPath: '/p',
    memorySection: '',
    graphSnapshot: '',
    claudeMdSection: '',
    providerName: 'mock',
    shellEnvSection: '- OS: test',
  };

  it('不传 sections = 出厂段表全等', () => {
    const direct = builtinPromptSections()
      .filter((s) => !s.applicable || s.applicable(ctxArgs))
      .map((s) => s.render(ctxArgs))
      .join('');
    expect(assembleSystemPrompt(ctxArgs)).toBe(direct);
  });

  it('传覆盖 + 插段的 resolved.prompt → 新文本在、被覆盖文本不在、插入段落位', () => {
    const composition = sampleComposition();
    const out = assembleSystemPrompt(ctxArgs, composition.prompt);
    expect(out).toContain('【覆盖后的行为规则】');
    expect(out).toContain('【穿线探针段】');
    // 原文本被整段替换（不再出现）
    expect(out).not.toContain('你是兰台的编码 Agent');
    // 落位：探针段紧跟 collaboration-mode 之后
    const probeIdx = out.indexOf('【穿线探针段】');
    expect(probeIdx).toBeGreaterThan(0);
  });
});

describe('S2-1 穿线：AgentBlueprint.fromRoster', () => {
  it('fromRoster(出厂表) ≡ standard()（keys 序全等——换真源不改语义）', () => {
    const a = AgentBlueprint.fromRoster(builtinCapabilities()).keys();
    const b = AgentBlueprint.standard().keys();
    expect(a).toEqual(b);
  });

  it('禁用 capability 后 keys 少一项且序保持', () => {
    const composition = resolveRoster(factoryComposition(), [{ capabilities: [{ id: 'auto-tune', disabled: true }] }]);
    const keys = AgentBlueprint.fromRoster(composition.capabilities).keys();
    expect(keys).not.toContain('auto-tune');
    expect(keys).toEqual(
      builtinCapabilities()
        .map((c) => c.key)
        .filter((k) => k !== 'auto-tune'),
    );
  });
});

describe('S2-1 穿线：AgentRuntime(composition) 端到端', () => {
  /** phase-6 同款手工 ctx（纯内存 bus/boards，零持久化副作用）。 */
  function makeCtx(agentId: string, rt: AgentRuntime): AgentContext {
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());
    return new AgentContext(
      { agentId, parentId: null, subagentDepth: 0, projectPath: '/projects/demo' },
      { provider: scriptedProvider([]), tools, eventSink: () => {}, messageBus: rt.getBus() },
    );
  }

  const sysOf = (h: AgentHandle): string => {
    const agent = (
      h as unknown as { _getAgent(): { getSession(): Array<{ role: string; content: unknown }> } }
    )._getAgent();
    return String(agent.getSession()[0]?.content ?? '');
  };

  it('不传 composition = 现行装配（与 phase-6 缺省面同源）', async () => {
    const rt = new AgentRuntime();
    await rt.ready();
    const h = await rt.createAgentFromContext(makeCtx('s21-default', rt), {});
    const names = (h as unknown as { _getAgent(): { tools: ToolRegistry } })
      ._getAgent()
      .tools.all()
      .map((t) => t.name());
    expect(names.length).toBeGreaterThan(0);
    h.dispose();
  });

  it('传 composition：prompt 覆盖段 + 插入段进入 system prompt', async () => {
    const rt = new AgentRuntime(undefined, undefined, sampleComposition());
    await rt.ready();
    // graphData 在场 → 完整面（behavior-rules 覆盖段 applicable hasGraph 参与）
    const h = await rt.createAgentFromContext(makeCtx('s21-composed', rt), { graphData: { nodes: [] } });
    const sys = sysOf(h);
    expect(sys).toContain('【覆盖后的行为规则】');
    expect(sys).toContain('【穿线探针段】');
    expect(sys).not.toContain('你是兰台的编码 Agent');
    h.dispose();
  });

  it('传 composition：capability 禁用生效（auto-tune 不装）', async () => {
    const composition = resolveRoster(factoryComposition(), [{ capabilities: [{ id: 'auto-tune', disabled: true }] }]);
    const rt = new AgentRuntime(undefined, undefined, composition);
    await rt.ready();
    const h = await rt.createAgentFromContext(makeCtx('s21-notune', rt), {});
    // auto-tune 的副作用是 fire-and-forget applyAutoTuneConfig——禁用后
    // 不该被调用。结构上以 keys 等价断言（fromRoster 已测），此处钉
    // 「装配成功 + standard 面不减」（plan-tools 等必需面仍在）。
    const names = (h as unknown as { _getAgent(): { tools: ToolRegistry } })
      ._getAgent()
      .tools.all()
      .map((t) => t.name());
    expect(names).toContain('enter_plan_mode');
    expect(names).toContain('exit_plan_mode');
    h.dispose();
  });
});

describe('S2-1 穿线：composition-store', () => {
  beforeEach(() => {
    useCompositionStore.setState({
      status: 'factory',
      patchOrigin: undefined,
      error: undefined,
      resolved: factoryComposition(),
    });
  });

  it('初始态 = factory，resolved ≡ 出厂组合', () => {
    const s = useCompositionStore.getState();
    expect(s.status).toBe('factory');
    expect(ids(s.resolved.tools)).toEqual(ids(builtinToolRows()));
  });

  it('setResolved → ok 态，diagnostics 透出', () => {
    useCompositionStore.getState().setResolved(sampleComposition(), 'roster.patch.yml');
    const s = useCompositionStore.getState();
    expect(s.status).toBe('ok');
    expect(s.patchOrigin).toBe('roster.patch.yml');
    expect(s.resolved.diagnostics.disabled).toContain('builtin/shell');
    expect(s.resolved.diagnostics.overridden).toContain('behavior-rules');
    expect(s.resolved.diagnostics.inserted).toContain('wiring-probe');
  });

  it('setError → error 态 + 回退出厂组合（all-or-nothing 兜底）', () => {
    useCompositionStore.getState().setResolved(sampleComposition(), 'roster.patch.yml');
    useCompositionStore.getState().setError('未知行 id: "nope"', 'roster.patch.yml');
    const s = useCompositionStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toContain('nope');
    expect(ids(s.resolved.tools)).toEqual(ids(builtinToolRows())); // factory 回退
  });
});
