import { describe, expect, it } from 'vitest';
import { SubAgentPool } from '../src/agent/coordinator';
import { TaskManager } from '../src/agent/task';
import type { ToolExecutor } from '../src/agent/tool';
import type { SubAgentSpawner } from '../src/agent/tools/subagent';
import { builtinToolRows, type ToolRowContext } from '../src/composition/tool-rows';

// ── 行表自检：S1-2 coding 面 + S1-3 装配末端（现存 9 内置族）──
// 行表是 standard preset 装配序的事实来源（表序 = 组合序）。这里钉住：
//   1. 行 id 唯一且稳定（未来 preset 按 id 引用行）；
//   2. 各族行产出 = 迁移前现行装配的表序（机械重述）；
//   3. 行 factory 无共享可变状态（多次装配互不串扰）；
//   4. 可选依赖族缺帐时产出空集（原 if 分支语义）；
//   5. 经 buildToolRegistry 真实装配后无重名残留（名字冲突装载期拒绝）。
// 可见面零漂移由 verify:convergence 守护（S1 设计件 §2.4），此处不重复。
// git/search（B①）+ fs/shell/agent-isolation（②，均 2026-08-23）五族已迁出
// 至 ctx.tools 第一方插件通道（钉住面在 tests/coding-domain-plugins.test.ts）。

const exec: ToolExecutor = async () => '';

/** 最小完整装配上下文（必填字段用真实空实例）。 */
function minCtx(): ToolRowContext {
  return { codingExec: exec, taskManager: new TaskManager(), subAgentPool: new SubAgentPool() };
}

/** 按 id 取行（表形状由表序测试钉住，缺行直接炸）。 */
function row(id: string) {
  const r = builtinToolRows().find((x) => x.id === id);
  if (!r) throw new Error(`row not found: ${id}`);
  return r;
}

/** 全部 9 行 id（表序 = 组合序；git/search/fs/shell/agent-isolation 已迁
 *  第一方插件通道——五族序钉在 tests/coding-domain-plugins.test.ts）。 */
const ALL_ROW_IDS = [
  'builtin/hologram',
  'builtin/web',
  'builtin/ask',
  'builtin/skill',
  'builtin/memory',
  'builtin/task',
  'builtin/agent',
  'builtin/browser-desktop',
  'builtin/wait',
];

/** web 族现行表序（单工具）。 */
const WEB_TOOL_ORDER = ['web_fetch'];

/** ask 族现行表序（单工具，常驻可见）。 */
const ASK_TOOL_ORDER = ['ask_user'];

/** task 族工具名前缀（createTaskTools 产出的 task_* 细粒度名）。 */
const TASK_TOOL_PREFIX = 'task_';

/** agent 族（subAgentSpawner 缺帐 → 空集；有 spawner → spawn/status 对）。 */
const AGENT_TOOL_NAMES = ['agent_spawn', 'agent_status'];

/** wait 族（单工具，常驻可见）。 */
const WAIT_TOOL_NAMES = ['wait'];

/** ② 批迁出族的工具名序（经插件通道注册——端到端在册断言仍覆盖）。 */
const FS_TOOL_ORDER = [
  'read_file_content',
  'write_file',
  'edit_file',
  'list_directory',
  'read_constraints',
  'write_constraints',
  'glob',
  'delete_file',
  'create_directory',
  'move_file',
  'rename_file',
];
const SHELL_TOOL_ORDER = ['run_shell', 'bash_output', 'bash_kill', 'bash_wait'];
const GIT_TOOL_ORDER = [
  'git_status',
  'git_diff',
  'git_log',
  'git_stage',
  'git_commit',
  'git_push',
  'git_pull',
  'git_init',
  'git_checkout',
  'git_create_branch',
  'git_discard',
  'git_stash_push',
  'git_stash_pop',
];
const SEARCH_TOOL_ORDER = ['search_content'];
const AGENT_ISOLATION_TOOL_ORDER = [
  'agent_isolation_create',
  'agent_isolation_diff',
  'agent_isolation_merge',
  'agent_isolation_discard',
  'agent_isolation_status',
];

describe('composition/tool-rows（内置行表全族）', () => {
  it('行 id 唯一且稳定，表序 = 组合序（9 行）', () => {
    const ids = builtinToolRows().map((r) => r.id);
    expect(ids).toEqual(ALL_ROW_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('各 coding 族行产出工具名序 = 迁移前现行表序', async () => {
    const expectOrder = async (id: string, order: string[]) => {
      const names = (await row(id).factory(minCtx())).map((t) => t.name());
      expect(names).toEqual(order);
    };
    await expectOrder('builtin/web', WEB_TOOL_ORDER);
    await expectOrder('builtin/ask', ASK_TOOL_ORDER);
  });

  it('hologram 行：graphData 缺帐时产出空集（原 if 分支语义）', async () => {
    const tools = await row('builtin/hologram').factory(minCtx()); // 无 graphData
    expect(tools).toEqual([]);
  });

  it('task / wait / browser-desktop 行：必填依赖下产出非空', async () => {
    const ctx = minCtx();
    const taskNames = (await row('builtin/task').factory(ctx)).map((t) => t.name());
    expect(taskNames.length).toBeGreaterThan(0);
    expect(taskNames.every((n) => n.startsWith(TASK_TOOL_PREFIX))).toBe(true);
    const waitNames = (await row('builtin/wait').factory(ctx)).map((t) => t.name());
    expect(waitNames).toEqual(WAIT_TOOL_NAMES);
    const bdNames = (await row('builtin/browser-desktop').factory(ctx)).map((t) => t.name());
    expect(bdNames.length).toBeGreaterThan(0);
    expect(bdNames.some((n) => n.startsWith('browser_'))).toBe(true);
    expect(bdNames.some((n) => n.startsWith('desktop_'))).toBe(true);
  });

  it('agent 行：spawner 缺帐时空集；有 spawner 时产出 spawn/status 对', async () => {
    expect(await row('builtin/agent').factory(minCtx())).toEqual([]);
    const spawner = (async () => 'stub-spawn-result') as unknown as SubAgentSpawner;
    const names = (await row('builtin/agent').factory({ ...minCtx(), subAgentSpawner: spawner })).map((t) => t.name());
    expect(names).toEqual(AGENT_TOOL_NAMES);
  });

  it('skill / memory 行：依赖缺帐时空集（原 if 分支语义）', async () => {
    expect(await row('builtin/skill').factory(minCtx())).toEqual([]);
    expect(await row('builtin/memory').factory(minCtx())).toEqual([]);
  });

  it('行 factory 每次调用产出独立实例（无共享可变状态）', async () => {
    const webRow = row('builtin/web');
    const a = await webRow.factory(minCtx());
    const b = await webRow.factory(minCtx());
    expect(a).not.toBe(b);
    expect(a.map((t) => t.name())).toEqual(b.map((t) => t.name()));
  });

  it('经 buildToolRegistry 真实装配：全部族工具名 + ask_user + read_file 别名在册且无重名', async () => {
    const { buildStandardRegistry } = await import('./convergence/helpers/fixtures');
    const reg = await buildStandardRegistry();
    const names = reg.names();
    // 表内族 + ②/B① 迁出族（经插件通道注册——夹具已包 withFirstPartyToolChannel）
    for (const n of [
      ...FS_TOOL_ORDER,
      ...SHELL_TOOL_ORDER,
      ...GIT_TOOL_ORDER,
      ...SEARCH_TOOL_ORDER,
      ...WEB_TOOL_ORDER,
      ...AGENT_ISOLATION_TOOL_ORDER,
      ...ASK_TOOL_ORDER,
      ...WAIT_TOOL_NAMES,
      'read_file',
    ]) {
      expect(names).toContain(n);
    }
    // task/browser/desktop/agent 族的产出也必须在册（行表装配端到端生效）
    expect(names.some((n) => n.startsWith('task_'))).toBe(true);
    expect(names.some((n) => n.startsWith('browser_'))).toBe(true);
    expect(names.some((n) => n.startsWith('desktop_'))).toBe(true);
    expect(names).toContain('agent_spawn');
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
});
