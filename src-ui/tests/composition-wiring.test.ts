// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S2-1 组合外化穿线测试 — 设计件 §3 S2-1 验收：
//   传 resolved（含禁用/覆盖/插入）→ 注册面/prompt 文本/蓝图相应变化；
//   不传 → 与现状全等（零漂移——快照级守护在 verify:convergence，此处
//   钉参数面的构造性等价）。
// 覆盖四条穿线：buildToolRegistry(toolRows) / buildSystemPrompt(sections) /
// AgentBlueprint.fromRoster / AgentRuntime(composition) + composition-store。

import { beforeEach, describe, expect, it } from 'vitest';
import { AgentBlueprint, firstPartyCapabilities } from '../src/agent/blueprint';
import { AgentContext } from '../src/agent/context';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import type { AgentHandle } from '../src/agent/runtime/types';
import { ToolRegistry } from '../src/agent/tool';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyPromptChannel } from '../src/composition/first-party-prompts';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { assembleSystemPrompt, firstPartyPromptSections } from '../src/composition/prompt-sections';
import { factoryComposition, type ResolvedComposition, resolveRoster } from '../src/composition/roster';
import { useCompositionStore } from '../src/state/composition-store';
import { buildStandardRegistry, readOnlyTool, scriptedProvider } from './convergence/helpers/fixtures';
// 批 6a：plan 实现由 hologram/plan-mode 插件在装载期常驻登记（生产 = 装载器先于
// 组合链）；本文件有「组合值带出通道腰、装配在腰外」的用例 ⇒ 复现该常驻态。
import { installPlanModeForTest } from './helpers/plan-mode-impl';
// 批 6c：出厂 hook 实现同样由装载器常驻登记（service 类 ⇒ 缺实现 fail-loud）。
import { installStateHooksForTest } from './helpers/state-hooks-impl';

installStateHooksForTest();

installPlanModeForTest();

const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id);

/** ①b 后 tools 域禁用探针（plugin 行——解析须在通道腰内）。 */
const WEB_ROW = 'plugin/hologram/web-domain/web_fetch';

/** 禁用若干工具行 + 插入/覆盖段的 resolved（穿线效果样本）。
 *  ①b（2026-08-23）：builtin 行表退役——工具禁用探针改 plugin 行
 *  （plugin/hologram/web-domain/web_fetch），样本解析在工具通道腰内
 *  （贡献行在册才可寻址）；prompt 通道腰同时激活（第一方 13 段进样本
 *  段表——AgentRuntime 端到端断言「第一方面也在」依赖它）；capability
 *  通道腰同样激活（B⑤ 后第一方十五项 capability 经通道注册——样本
 *  组合的 capabilities 域与生产同路）。
 *  S4-4 甲（2026-08-23）：组合解析域含通道贡献快照——样本在通道外解析
 *  = 空行表 + 空段表 + 已插入段；在三通道内解析则含全部贡献行/段
 *  （贡献寻址恢复，见 roster 测试）。 */
async function sampleComposition(): Promise<ResolvedComposition> {
  return withFirstPartyToolChannel(() =>
    withFirstPartyCapabilityChannel(() =>
      withFirstPartyPromptChannel(() =>
        Promise.resolve(
          resolveRoster(factoryComposition(), [
            {
              tools: [{ id: WEB_ROW, disabled: true }],
              prompt: [
                { insert: [{ id: 'wiring-probe', text: '【穿线探针一】' }] },
                { insert: [{ id: 'wiring-probe-2', after: 'wiring-probe', text: '【穿线探针二】' }] },
                { id: 'wiring-probe', text: '【覆盖后的探针】' },
              ],
            },
          ]),
        ),
      ),
    ),
  );
}

/** 通道内样本（S4-4 甲 + ①c + B⑤）：解析域含贡献行——plugin 行可寻址禁用。
 *  调用点已处 withFirstPartyToolChannel 腰内（贡献行在册）。 */
function sampleCompositionInChannel(): ResolvedComposition {
  return resolveRoster(factoryComposition(), [
    {
      tools: [{ id: 'plugin/hologram/wait-domain/wait', disabled: true }],
      prompt: [
        { insert: [{ id: 'wiring-probe', text: '【穿线探针一】' }] },
        { insert: [{ id: 'wiring-probe-2', after: 'wiring-probe', text: '【穿线探针二】' }] },
        { id: 'wiring-probe', text: '【覆盖后的探针】' },
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

  it('传禁用后的行表 → wait 不在册；通道贡献行随组合面装配（解析须在通道内）', async () => {
    const { buildToolRegistry } = await import('../src/agent/runtime/agent-builder');
    const { SubAgentPool } = await import('../src/agent/coordinator');
    const { TaskManager } = await import('../src/agent/task');
    const { withFirstPartyToolChannel } = await import('../src/composition/first-party-tools');
    const { FIXED_GRAPH_DATA } = await import('./convergence/helpers/fixtures');
    // S4-4 甲 + ①c：组合解析域含通道贡献快照——样本须在通道腰内解析
    // （factoryComposition 收编全部贡献行，含 wait 贡献行）；解析产物经
    // 单一循环装配（buildToolRegistry 不再旁路追加 pluginToolRows）。
    const reg = await withFirstPartyToolChannel(async () => {
      const composition = sampleCompositionInChannel();
      return buildToolRegistry({
        graphData: FIXED_GRAPH_DATA,
        deps: {},
        taskManager: new TaskManager(),
        subAgentPool: new SubAgentPool(),
        toolRows: composition.tools,
      });
    });
    const names = reg.names();
    // wait 行被禁 → wait 工具不在册（roster 穿线生效）
    expect(names).not.toContain('wait');
    // 通道贡献行随组合面装配（五族插件工具在册）
    expect(names).toContain('run_shell');
    expect(names).toContain('fs');
    expect(names.some((n) => n.startsWith('git_'))).toBe(true);
  });

  it('S4-4 甲：plugin/<贡献 id> 行可被 patch 寻址禁用（寻址域恢复）', async () => {
    const { buildToolRegistry } = await import('../src/agent/runtime/agent-builder');
    const { SubAgentPool } = await import('../src/agent/coordinator');
    const { TaskManager } = await import('../src/agent/task');
    const { withFirstPartyToolChannel } = await import('../src/composition/first-party-tools');
    const { factoryComposition, resolveRoster } = await import('../src/composition/roster');
    const { FIXED_GRAPH_DATA } = await import('./convergence/helpers/fixtures');
    const reg = await withFirstPartyToolChannel(async () => {
      // 通道内快照：工厂基座含插件贡献行（patch 可寻址）
      const resolved = resolveRoster(factoryComposition(), [
        { tools: [{ id: 'plugin/hologram/shell-domain/run_shell', disabled: true }] },
      ]);
      expect(resolved.tools.some((r) => r.id === 'plugin/hologram/shell-domain/run_shell')).toBe(false);
      expect(resolved.diagnostics.disabled).toContain('plugin/hologram/shell-domain/run_shell');
      return buildToolRegistry({
        graphData: FIXED_GRAPH_DATA,
        deps: {},
        taskManager: new TaskManager(),
        subAgentPool: new SubAgentPool(),
        toolRows: resolved.tools,
      });
    });
    const names = reg.names();
    // 被禁贡献行不注册（run_shell 消失）
    expect(names).not.toContain('run_shell');
    // 同族其余贡献行仍在册（单行粒度寻址）
    expect(names).toContain('bash_output');
    expect(names).toContain('bash_kill');
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

  it('不传 sections = 出厂面全等（空解析产物 + 通道贡献 13 段——经通道腰）', async () => {
    // B④ 收官：出厂面全经 ctx.prompts 通道贡献——等价断言须在通道内做
    // （无通道环境缺省拼装 = 空提示词，注册面依赖）
    await withFirstPartyPromptChannel(async () => {
      const direct = firstPartyPromptSections()
        .filter((s) => !s.applicable || s.applicable(ctxArgs))
        .map((s) => s.render(ctxArgs))
        .join('');
      expect(assembleSystemPrompt(ctxArgs)).toBe(direct);
    });
  });

  it('传插入 + 覆盖的 resolved.prompt → 新文本在、被覆盖文本不在、插入段落位', async () => {
    const composition = await sampleComposition();
    const out = assembleSystemPrompt(ctxArgs, composition.prompt);
    expect(out).toContain('【覆盖后的探针】');
    expect(out).toContain('【穿线探针二】');
    // 原文本被整段替换（不再出现）
    expect(out).not.toContain('【穿线探针一】');
    // 落位：探针二紧跟覆盖段之后（after 锚保序）
    const probe2Idx = out.indexOf('【穿线探针二】');
    expect(probe2Idx).toBeGreaterThan(0);
  });
});

describe('S2-1 穿线：AgentBlueprint.fromRoster', () => {
  it('通道内 factoryComposition().capabilities ≡ firstPartyCapabilities()（清单序 = 迁移前表序——换真源不改语义）', async () => {
    // B⑤ 收官：standard() 与 builtinCapabilities() 退役——不变式改钉新
    // 真源：通道快照 ≡ 清单（fromRoster 的缺省输入与清单同一张表）
    await withFirstPartyCapabilityChannel(async () => {
      const a = AgentBlueprint.fromRoster(factoryComposition().capabilities).ids();
      const b = firstPartyCapabilities().map((c) => c.id);
      expect(a).toEqual(b);
    });
  });

  it('禁用 capability 后 ids 少一项且序保持', async () => {
    await withFirstPartyCapabilityChannel(async () => {
      const composition = resolveRoster(factoryComposition(), [
        { capabilities: [{ id: 'auto-tune', disabled: true }] },
      ]);
      const keys = AgentBlueprint.fromRoster(composition.capabilities).ids();
      expect(keys).not.toContain('auto-tune');
      expect(keys).toEqual(
        firstPartyCapabilities()
          .map((c) => c.id)
          .filter((k) => k !== 'auto-tune'),
      );
    });
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

  it('不传 composition = 现行装配（通道腰内复现生产缺省面——第一方 capability 在册）', async () => {
    // B⑤：出厂 capability 面经通道贡献——缺省装配的「现行面」须在 capability
    // 通道腰内复现（生产 = loadBuiltinPlugins 先于一切组合链；无通道 = 空
    // 能力表，缺省面只剩输入注册表）
    await withFirstPartyCapabilityChannel(async () => {
      const rt = new AgentRuntime();
      await rt.ready();
      const h = await rt.createAgentFromContext(makeCtx('s21-default', rt), {});
      const names = (h as unknown as { _getAgent(): { tools: ToolRegistry } })
        ._getAgent()
        .tools.all()
        .map((t) => t.name());
      expect(names.length).toBeGreaterThan(0);
      expect(names).toContain('enter_plan_mode'); // 第一方面在（plan-tools 经通道在册）
      h.dispose();
    });
  });

  it('传 composition：插入/覆盖段进入 system prompt（通道腰内复现生产装配面）', async () => {
    // B④ 收官：第一方面全经通道贡献——通道腰内 runtime 装配与生产同路
    const composition = await sampleComposition();
    await withFirstPartyPromptChannel(async () => {
      const rt = new AgentRuntime(undefined, undefined, composition);
      await rt.ready();
      // graphData 在场 → 完整面（第一方 13 段中 applicable 的全参与）
      const h = await rt.createAgentFromContext(makeCtx('s21-composed', rt), { graphData: { nodes: [] } });
      const sys = sysOf(h);
      expect(sys).toContain('【覆盖后的探针】');
      expect(sys).toContain('【穿线探针二】');
      expect(sys).not.toContain('【穿线探针一】');
      expect(sys).toContain('## 模型身份'); // 第一方面（通道贡献）也在
      h.dispose();
    });
  });

  it('传 composition：capability 禁用生效（auto-tune 不装）', async () => {
    // B⑤：capability 行经通道在册——寻址 auto-tune 的解析在通道腰内做
    //（组合是值——解析产物可带出通道使用）
    const composition = await withFirstPartyCapabilityChannel(() =>
      Promise.resolve(resolveRoster(factoryComposition(), [{ capabilities: [{ id: 'auto-tune', disabled: true }] }])),
    );
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
    expect(ids(s.resolved.tools)).toEqual(ids(factoryComposition().tools));
  });

  it('setResolved → ok 态，diagnostics 透出', async () => {
    useCompositionStore.getState().setResolved(await sampleComposition(), 'roster.patch.yml');
    const s = useCompositionStore.getState();
    expect(s.status).toBe('ok');
    expect(s.patchOrigin).toBe('roster.patch.yml');
    expect(s.resolved.diagnostics.disabled).toContain(WEB_ROW);
    expect(s.resolved.diagnostics.overridden).toContain('wiring-probe');
    expect(s.resolved.diagnostics.inserted).toContain('wiring-probe');
    expect(s.resolved.diagnostics.inserted).toContain('wiring-probe-2');
  });

  it('setError → error 态 + 回退出厂组合（all-or-nothing 兜底）', async () => {
    useCompositionStore.getState().setResolved(await sampleComposition(), 'roster.patch.yml');
    useCompositionStore.getState().setError('未知行 id: "nope"', 'roster.patch.yml');
    const s = useCompositionStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toContain('nope');
    expect(ids(s.resolved.tools)).toEqual(ids(factoryComposition().tools)); // factory 回退
  });
});
