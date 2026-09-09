import { describe, expect, it } from 'vitest';
import { SubAgentPool } from '../src/agent/coordinator';
import { TaskManager } from '../src/agent/task';
import type { ToolExecutor } from '../src/agent/tool';
import type { SubAgentSpawner } from '../src/agent/tools/subagent';
import { factoryComposition } from '../src/composition/roster';
import type { ToolRowContext } from '../src/composition/tool-rows';

// ── 行装配自检（S1-3 装配末端；①b 收官 2026-08-23：builtin 行表退役）──
// 行真源 = factoryComposition().tools = pluginToolRows()（十四族全量经
// ctx.tools 第一方插件通道贡献）。这里钉住：
//   1. 经 buildToolRegistry 真实装配后无重名残留（名字冲突装载期拒绝）；
//   2. 冲突拒绝（外部贡献撞通道工具名 → 装配期 throw）；
//   3. noCache 行每装配重创实例（①c 语义钉面）；
//   4. 条件族缺帐空集（原行 if 分支语义）。
// 可见面零漂移由 verify:convergence 守护（S1 设计件 §2.4），此处不重复。
// 各族贡献清单/名序/生命周期钉面在 tests/coding-domain-plugins.test.ts。

const exec: ToolExecutor = async () => '';

/** 最小完整装配上下文（必填字段用真实空实例）。 */
function minCtx(): ToolRowContext {
  return { codingExec: exec, taskManager: new TaskManager(), subAgentPool: new SubAgentPool() };
}

describe('composition/tool-rows（行装配，builtin 行表已退役）', () => {
  it('无通道环境：factoryComposition().tools = 空行表（行真源全在插件通道）', () => {
    expect(factoryComposition().tools).toEqual([]);
  });

  it('经 buildToolRegistry 真实装配：全部族工具名 + ask_user + wait + read_file 别名在册且无重名', {
    timeout: 20_000,
  }, async () => {
    const { buildStandardRegistry } = await import('./convergence/helpers/fixtures');
    const reg = await buildStandardRegistry();
    const names = reg.names();
    // 十四族经插件通道注册——夹具已包 withFirstPartyToolChannel
    // （noCache 族每装配重创；browser-desktop 整组动态 import 在册）。
    // skill/memory 为可选依赖（夹具不注入——原行 if 分支空集语义）
    for (const n of ['ask_user', 'wait', 'web_fetch', 'read_file', 'browser_launch', 'desktop_probe']) {
      expect(names).toContain(n);
    }
    expect(names.some((n) => n.startsWith('task_'))).toBe(true);
    expect(names).toContain('agent_spawn');
    // dataflow_save 随 engine-domain（hologram 动态工具族）图谱全量退役整删
    // （2026-09-09）——工具面不再含引擎侧写动作。
    expect(names).not.toContain('dataflow_save');
    // 名字冲突装载期拒绝：重名 register 直接 throw，能走到这里即证明
    // 行表 + 别名 + 外部贡献全链路无重名
    expect(new Set(names).size).toBe(names.length);
  });

  it('S1-3 冲突拒绝：外部贡献撞插件通道工具名 → 装配期 throw（duplicate tool）', async () => {
    const { buildStandardRegistry } = await import('./convergence/helpers/fixtures');
    const conflicting = {
      id: 'probe/conflict',
      factory: () => ({
        name: () => 'run_shell', // 撞 shell 域插件的 run_shell（② 批迁出后撞通道贡献）
        description: () => 'conflict probe',
        parameters: () => ({ type: 'object', properties: {} }),
        readOnly: () => false,
        execute: async () => 'ok',
      }),
    };
    await expect(buildStandardRegistry([conflicting])).rejects.toThrow('duplicate tool "run_shell"');
  });

  it('①c 无缓存行语义：wait 贡献每装配重创（两次装配不同实例、同行为）', async () => {
    // 行时代 factory 每装配重调——noCache 贡献语义等价钉面
    const { buildStandardRegistry } = await import('./convergence/helpers/fixtures');
    const regA = await buildStandardRegistry();
    const waitA = regA.get('wait');
    if (!waitA) throw new Error('wait 工具未在册');
    const regB = await buildStandardRegistry();
    const waitB = regB.get('wait');
    if (!waitB) throw new Error('wait 工具未在册');
    // 两装配各自新实例（对象不等），行为面一致（同名同描述）
    expect(waitA).not.toBe(waitB);
    expect(waitA.name()).toBe(waitB.name());
  });

  it('agent 域贡献：spawner 缺帐时空集（原 if 分支语义）', async () => {
    const { withFirstPartyToolChannel } = await import('../src/composition/first-party-tools');
    const { pluginToolRows } = await import('../src/composition/plugin-tool-rows');
    await withFirstPartyToolChannel(async () => {
      const row = pluginToolRows().find((r) => r.id === 'plugin/hologram/agent-domain/agent_spawn');
      if (!row) throw new Error('agent_spawn 贡献行未注册');
      // spawner 缺帐 → 族产出空集 → 该行无产出（noCache 条件族缺帐 = 原行 if 分支空集语义）
      const out = await row.factory({ ...minCtx(), subAgentSpawner: undefined });
      expect(out).toEqual([]);
      // 有 spawner → 产出
      const spawner = (async () => 'stub-spawn-result') as unknown as SubAgentSpawner;
      const tools = await row.factory({ ...minCtx(), subAgentSpawner: spawner });
      expect(tools.map((t) => t.name())).toEqual(['agent_spawn']);
    });
  });
});
