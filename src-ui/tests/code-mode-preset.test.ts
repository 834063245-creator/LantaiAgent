// code 模式 preset（2026-11-21）——组合面到底有没有把工具从**直调面**收进程序。
//
// 判据只有一条：`schemas()`（模型直调面）受 directOnly allowlist 约束，而 `visibleTools()`
// （code_execution 的绑定集）照旧包含它们。任何一侧漏了，code 模式要么半残
// （程序里也调不到 = 剪行的失败形态），要么是空话（直调面没变）。
import './helpers/kernel-registry';
import { describe, expect, it } from 'vitest';
import { AgentContext } from '../src/agent/context';
import { buildToolRegistry } from '../src/agent/runtime/agent-builder';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { resolvePresetComposition } from '../src/composition/presets';
import { SubAgentPool } from '../src/plugins/builtin/subagent-in-process/coordinator';
import { TaskManager } from '../src/plugins/builtin/task-domain/task';
import { scriptedProvider } from './convergence/helpers/fixtures';
import { installCompactionForTest } from './helpers/compaction-impl';
import { installPlanModeForTest } from './helpers/plan-mode-impl';
import { installStateHooksForTest } from './helpers/state-hooks-impl';

installPlanModeForTest();
installStateHooksForTest();
installCompactionForTest();

describe('code 模式：直调面收进程序', () => {
  it('组合 → 注册表：allowlist 外的名字仍进 visibleTools、不进 schemas（标准组合零变化）', async () => {
    const built = await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        const code = resolvePresetComposition('code');
        const standard = resolvePresetComposition('standard');
        const deps = () => ({
          deps: {},
          taskManager: new TaskManager(),
          subAgentPool: new SubAgentPool(),
        });
        const codeReg = await buildToolRegistry({
          ...deps(),
          toolRows: code.tools,
          programOnly: code.programOnly,
          directOnly: code.directOnly,
        });
        const stdReg = await buildToolRegistry({ ...deps(), toolRows: standard.tools });
        return { code, standard, codeReg, stdReg };
      }),
    );

    const { code, codeReg, stdReg } = built;
    expect(code.directOnly).not.toBeNull();
    expect(code.directOnly?.length).toBeGreaterThan(0);
    const allowed = new Set(code.directOnly ?? []);

    // 真实装配会在装配期再克隆一次注册表；directOnly / hidden 是注册表策略，
    // 克隆必须一并带走，否则组合在真实会话里会静默退回全直调面。
    const runtimeReg = codeReg.clone();

    // ① 直调面 fail-closed：只允许 allowlist 内的名字
    const direct = runtimeReg.schemas().map((s) => s.name);
    expect(direct.every((name) => allowed.has(name))).toBe(true);
    expect(direct).not.toContain('fs');
    expect(direct).not.toContain('shell');
    // 常驻原语仍直调（问人与 wait 不是「日常工具」）
    expect(direct).toContain('ask_user');
    expect(direct).toContain('wait');

    // ② 程序面：绑定集照旧包含它们（这是 code 模式不残废的证据）
    const visible = runtimeReg.visibleTools().map((t) => t.name());
    expect(visible).toContain('fs');
    expect(visible).toContain('shell');

    // ③ 标准组合零漂移：同一把尺子下直调面 ≡ 可见面
    expect(
      stdReg
        .schemas()
        .map((s) => s.name)
        .sort(),
    ).toEqual(
      stdReg
        .visibleTools()
        .map((t) => t.name())
        .sort(),
    );
  });

  it('真实 AgentRuntime 装配：directOnly 策略保真，plan 工具不注册', async () => {
    let codeDirectOnly: readonly string[] | null = null;
    const observed = await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        const code = resolvePresetComposition('code');
        codeDirectOnly = code.directOnly;
        const registry = await buildToolRegistry({
          deps: {},
          taskManager: new TaskManager(),
          subAgentPool: new SubAgentPool(),
          toolRows: code.tools,
          programOnly: code.programOnly,
          directOnly: code.directOnly,
        });
        const rt = new AgentRuntime(undefined, undefined, code);
        await rt.ready();
        const ctx = new AgentContext(
          { agentId: 'code-preset-runtime', parentId: null, subagentDepth: 0, projectPath: '/projects/demo' },
          {
            provider: scriptedProvider([]),
            tools: registry,
            eventSink: () => {},
            messageBus: rt.getBus(),
          },
        );
        const handle = await rt.createAgentFromContext(ctx, {});
        const agent = (
          handle as unknown as { _getAgent(): { tools: { names(): string[]; schemas(): Array<{ name: string }> } } }
        )._getAgent();
        const snapshot = {
          all: agent.tools.names(),
          direct: agent.tools.schemas().map((s) => s.name),
        };
        handle.dispose();
        return snapshot;
      }),
    );

    // 策略保真：真实 runtime 克隆注册表后，程序内专属名仍从直调面扣掉。
    expect(observed.all).toContain('fs');
    expect(observed.all).toContain('shell');
    expect(observed.direct).not.toContain('fs');
    expect(observed.direct).not.toContain('shell');
    expect(observed.direct).toContain('code_execution');
    const allowed = new Set(codeDirectOnly ?? []);
    expect(observed.direct.every((name) => allowed.has(name))).toBe(true);
    // plan 两项 capability 被 code preset 裁掉：工具面里根本没有入口。
    expect(observed.all).not.toContain('enter_plan_mode');
    expect(observed.all).not.toContain('exit_plan_mode');
  });
});
