import { describe, expect, it } from 'vitest';
import { SubAgentPool } from '../src/agent/coordinator';
import { TaskManager } from '../src/agent/task';
import type { ToolExecutor } from '../src/agent/tool';
import type { SubAgentSpawner } from '../src/agent/tools/subagent';
import { builtinToolRows, type ToolRowContext } from '../src/composition/tool-rows';

// ── 行表自检：S1-2 coding 面 + S1-3 装配末端 ──
// 行表是 standard preset 装配序的事实来源（表序 = 组合序）。这里钉住：
//   1. 行 id 唯一且稳定（未来 preset 按 id 引用行）；
//   2. web 族行产出 = 迁移前现行装配的表序（机械重述）；
//   3. 经 buildToolRegistry 真实装配后无重名残留（名字冲突装载期拒绝）。
// 可见面零漂移由 verify:convergence 守护（S1 设计件 §2.4），此处不重复。
// 迁出史：git/search（B①）+ fs/shell/agent-isolation（②）+ wait/ask/
// memory/skill/task/agent/hologram（①c 无缓存行，2026-08-23）十二族已迁
// ctx.tools 第一方插件通道（钉住面在 tests/coding-domain-plugins.test.ts）。

const exec: ToolExecutor = async () => '';

/** 最小完整装配上下文（必填字段用真实空实例）。 */
function minCtx(): ToolRowContext {
  return { codingExec: exec, taskManager: new TaskManager(), subAgentPool: new SubAgentPool() };
}

/** 全部 2 行 id（表序 = 组合序；十二族已迁第一方插件通道——序钉在
 *  tests/coding-domain-plugins.test.ts）。 */
const ALL_ROW_IDS = ['builtin/web', 'builtin/browser-desktop'];

/** web 族现行表序（单工具）。 */
const WEB_TOOL_ORDER = ['web_fetch'];

describe('composition/tool-rows（内置行表）', () => {
  it('行 id 唯一且稳定，表序 = 组合序（①c 后 2 行）', () => {
    const ids = builtinToolRows().map((r) => r.id);
    expect(ids).toEqual(ALL_ROW_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('web 族行产出工具名序 = 迁移前现行表序', async () => {
    const row = builtinToolRows().find((r) => r.id === 'builtin/web');
    if (!row) throw new Error('builtin/web 行缺失');
    const names = (await row.factory(minCtx())).map((t) => t.name());
    expect(names).toEqual(WEB_TOOL_ORDER);
  });

  it('browser-desktop 行：必填依赖下产出非空', async () => {
    const row = builtinToolRows().find((r) => r.id === 'builtin/browser-desktop');
    if (!row) throw new Error('builtin/browser-desktop 行缺失');
    const names = (await row.factory(minCtx())).map((t) => t.name());
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => n.startsWith('browser_'))).toBe(true);
    expect(names.some((n) => n.startsWith('desktop_'))).toBe(true);
  });

  it('行 factory 每次调用产出独立实例（无共享可变状态）', async () => {
    const row = builtinToolRows().find((r) => r.id === 'builtin/web');
    if (!row) throw new Error('builtin/web 行缺失');
    const a = await row.factory(minCtx());
    const b = await row.factory(minCtx());
    expect(a).not.toBe(b);
    expect(a.map((t) => t.name())).toEqual(b.map((t) => t.name()));
  });

  it('经 buildToolRegistry 真实装配：全部族工具名 + ask_user + wait + read_file 别名在册且无重名', {
    timeout: 20_000,
  }, async () => {
    const { buildStandardRegistry } = await import('./convergence/helpers/fixtures');
    const reg = await buildStandardRegistry();
    const names = reg.names();
    // ①c 迁出族（wait/ask/memory/skill/task/agent/hologram）经插件通道注册
    // ——夹具已包 withFirstPartyToolChannel（noCache 族每装配重创）。
    // skill/memory 为可选依赖（夹具不注入——原行 if 分支空集语义）
    for (const n of ['ask_user', 'wait', 'web_fetch', 'read_file']) {
      expect(names).toContain(n);
    }
    expect(names.some((n) => n.startsWith('task_'))).toBe(true);
    expect(names).toContain('agent_spawn');
    expect(names).toContain('dataflow_save');
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
