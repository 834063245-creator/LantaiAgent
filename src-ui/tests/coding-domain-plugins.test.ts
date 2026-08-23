// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// codingExec 无状态族域第一方插件（P4 B① git/search + ② fs/shell/
// agent-isolation）钉住面：
//   1. 贡献清单：一工具一贡献，id = '<插件名>/<工具名>'，注册序 = 族声明序；
//   2. factory 装配语义：需要 rowCtx.codingExec（缺则显式 throw）；工具 execute
//      经 rowCtx.codingExec 穿透执行；同族贡献共享首装配建族（族内 exec 锁存）；
//   3. 生命周期：贡献注册经 ctx.effect——fiber dispose 后贡献消失；
//   4. 折算面：pluginToolRows() 行 id = 'plugin/<贡献 id>'，装配真实可用；
//   5. 端到端：经 buildToolRegistry 真实装配后五族旧名与域工具在册
//      （可见面零漂移由 verify:convergence 的 tool-schemas 快照守护）。
// 五族名序钉（手写清单对拍声明序）在本文件——git/search 搬自
// composition-tool-rows.test.ts（B①），fs/shell/agent-isolation 搬自同处（②）。

import { describe, expect, it } from 'vitest';
import { SubAgentPool } from '../src/agent/coordinator';
import { TaskManager } from '../src/agent/task';
import type { Tool, ToolExecutor, ToolRegistry, ToolRowContext } from '../src/agent/tool';
import {
  createAgentIsolationTools,
  createFsTools,
  createGitTools,
  createSearchTools,
  createShellTools,
} from '../src/agent/tools/coding';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { activeToolContributions, compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import {
  agentIsolationDomainPlugin,
  fsDomainPlugin,
  gitDomainPlugin,
  searchDomainPlugin,
  shellDomainPlugin,
} from '../src/plugins/coding-domain-plugins';

/** git 族工具名序（手写清单——对拍插件贡献序，防声明序漂移无人知）。 */
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

/** search 族工具名序（单工具）。 */
const SEARCH_TOOL_ORDER = ['search_content'];

/** fs 族工具名序（② 批搬自 composition-tool-rows.test.ts）。 */
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

/** shell 族工具名序（run_shell → bash_output/kill/wait）。 */
const SHELL_TOOL_ORDER = ['run_shell', 'bash_output', 'bash_kill', 'bash_wait'];

/** agent-isolation 族工具名序（worktree 隔离 5 工具）。 */
const AGENT_ISOLATION_TOOL_ORDER = [
  'agent_isolation_create',
  'agent_isolation_diff',
  'agent_isolation_merge',
  'agent_isolation_discard',
  'agent_isolation_status',
];

/** 五族全部工具名（序 = 插件注册序 = firstPartyToolPlugins 清单序）。 */
const ALL_PLUGIN_TOOL_IDS = [
  ...GIT_TOOL_ORDER.map((n) => `hologram/git-domain/${n}`),
  ...SEARCH_TOOL_ORDER.map((n) => `hologram/search-domain/${n}`),
  ...FS_TOOL_ORDER.map((n) => `hologram/fs-domain/${n}`),
  ...SHELL_TOOL_ORDER.map((n) => `hologram/shell-domain/${n}`),
  ...AGENT_ISOLATION_TOOL_ORDER.map((n) => `hologram/agent-isolation-domain/${n}`),
];

/** 录制型 exec：记录调用并返回空串。 */
function recordingExec(log: Array<{ name: string }>): ToolExecutor {
  return async (name) => {
    log.push({ name });
    return '';
  };
}

function makeRowCtx(exec: ToolExecutor): ToolRowContext {
  return { codingExec: exec, taskManager: new TaskManager(), subAgentPool: new SubAgentPool() };
}

/** 应用五域插件到根 Context（四 service 先行——inject 依赖可解析）。 */
async function applyPlugins(root: Context) {
  await root.plugin(compositionServicesPlugin);
  const gitFiber = await root.plugin(gitDomainPlugin);
  const searchFiber = await root.plugin(searchDomainPlugin);
  const fsFiber = await root.plugin(fsDomainPlugin);
  const shellFiber = await root.plugin(shellDomainPlugin);
  const isolationFiber = await root.plugin(agentIsolationDomainPlugin);
  return { gitFiber, searchFiber, fsFiber, shellFiber, isolationFiber };
}

/** 全部 fiber 逆序拆卸。 */
async function disposeAll(fibers: Awaited<ReturnType<typeof applyPlugins>>) {
  await fibers.isolationFiber.dispose();
  await fibers.shellFiber.dispose();
  await fibers.fsFiber.dispose();
  await fibers.searchFiber.dispose();
  await fibers.gitFiber.dispose();
}

describe('codingExec 无状态族域第一方插件（P4 B① git/search + ② fs/shell/agent-isolation）', () => {
  it('贡献清单：一工具一贡献，注册序 = 族声明序（对拍手写清单，五族全量）', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    expect(activeToolContributions().map((c) => c.id)).toEqual(ALL_PLUGIN_TOOL_IDS);
    await disposeAll(fibers);
  });

  it('factory 需要装配上下文：缺 rowCtx 显式 throw（错误不静默，五族同语义）', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    for (const suffix of ['git_status', 'search_content', 'read_file_content', 'run_shell', 'agent_isolation_create']) {
      const probe = activeToolContributions().find((c) => c.id.endsWith(suffix));
      if (!probe) throw new Error(`${suffix} 贡献未注册`);
      expect(() => probe.factory()).toThrow(/需要装配上下文/);
    }
    await disposeAll(fibers);
  });

  it('factory 收 rowCtx：工具可执行且经 rowCtx.codingExec 穿透（fs/shell 抽查）', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    const log: Array<{ name: string }> = [];
    const ctx = makeRowCtx(recordingExec(log));
    const tools = activeToolContributions().map((c) => c.factory(ctx));
    const read = tools.find((t) => t.name() === 'read_file_content');
    const runShell = tools.find((t) => t.name() === 'run_shell');
    if (!read || !runShell) throw new Error('fs/shell 工具未产出');
    await read.execute({ filePath: 'D:/proj/a.ts' });
    await runShell.execute({ command: 'ls' });
    expect(log.map((e) => e.name)).toContain('read_file_content');
    // run_shell 委托旧名 exec_command（runInBackground 缺省走前台执行）
    expect(log.map((e) => e.name)).toContain('exec_command');
    await disposeAll(fibers);
  });

  it('同族贡献共享首装配建族：族内 exec 锁存首个 rowCtx（实例缓存语义）', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    const logA: Array<{ name: string }> = [];
    const logB: Array<{ name: string }> = [];
    const gitStatus = activeToolContributions().find((c) => c.id.endsWith('git_status'));
    const gitDiff = activeToolContributions().find((c) => c.id.endsWith('git_diff'));
    if (!gitStatus || !gitDiff) throw new Error('git_status/git_diff 贡献未注册');
    // 首贡献装配用 execA——族随之锁存；次贡献即使换 execB 也复用族（execA）。
    // git_diff 委托旧名 git_diff_unstaged（staged:false 分支）
    const toolA = gitStatus.factory(makeRowCtx(recordingExec(logA)));
    const toolB = gitDiff.factory(makeRowCtx(recordingExec(logB)));
    await toolA.execute({ path: 'D:/proj' });
    await toolB.execute({ path: 'D:/proj' });
    expect(logA.map((e) => e.name)).toEqual(['git_status', 'git_diff_unstaged']);
    expect(logB).toEqual([]);
    await disposeAll(fibers);
  });

  it('生命周期：贡献注册经 ctx.effect——fiber dispose 后贡献消失（逐族）', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    expect(activeToolContributions().length).toBe(ALL_PLUGIN_TOOL_IDS.length);
    await fibers.gitFiber.dispose();
    await fibers.searchFiber.dispose();
    await fibers.fsFiber.dispose();
    // 剩 shell + agent-isolation 两族
    const remaining = activeToolContributions().map((c) => c.id);
    expect(remaining).toEqual([
      ...SHELL_TOOL_ORDER.map((n) => `hologram/shell-domain/${n}`),
      ...AGENT_ISOLATION_TOOL_ORDER.map((n) => `hologram/agent-isolation-domain/${n}`),
    ]);
    await disposeAll(fibers);
    expect(activeToolContributions()).toEqual([]);
  });

  it('折算面：pluginToolRows() 行 id = plugin/<贡献 id>，factory(rowCtx) 装配可用', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    const rows = pluginToolRows();
    expect(rows.map((r) => r.id)).toEqual(ALL_PLUGIN_TOOL_IDS.map((id) => `plugin/${id}`));
    const log: Array<{ name: string }> = [];
    const ctx = makeRowCtx(recordingExec(log));
    for (const row of rows) {
      const tools = await row.factory(ctx);
      expect(tools).toHaveLength(1);
    }
    await disposeAll(fibers);
  });

  it('端到端：真实装配后五族旧名在册、fs/shell 域工具在册（DOMAIN_SPECS 收敛不破）', async () => {
    const { buildStandardRegistry } = await import('./convergence/helpers/fixtures');
    const reg: ToolRegistry = await buildStandardRegistry();
    const names = reg.names();
    for (const n of [
      ...GIT_TOOL_ORDER,
      ...SEARCH_TOOL_ORDER,
      ...FS_TOOL_ORDER,
      ...SHELL_TOOL_ORDER,
      ...AGENT_ISOLATION_TOOL_ORDER,
    ]) {
      expect(names).toContain(n);
    }
    // 域工具存在且 action 集 = DOMAIN_SPECS 声明按注册面过滤（fs 域抽查）
    const fs = reg.get('fs');
    const shell = reg.get('shell');
    if (!fs || !shell) throw new Error('fs/shell 域工具未生成');
    expect(fs.domain?.()).toBe('fs');
    const { DOMAIN_SPECS } = await import('../src/agent/tools/domains');
    const fsSpec = DOMAIN_SPECS.find((s) => s.name === 'fs');
    if (!fsSpec) throw new Error('DOMAIN_SPECS 无 fs 域');
    const registered = new Set(FS_TOOL_ORDER);
    const expectedActions = Object.entries(fsSpec.actions)
      .filter(([, oldName]) => registered.has(oldName))
      .map(([action]) => action);
    expect(fs.actions?.()).toEqual(expectedActions);
  });
});

// ── 真源对拍：插件贡献工具集 ≡ 族工厂直出集 ──

describe('插件贡献与族工厂真源对拍', () => {
  it('五族插件产出工具集 = 族工厂直出集（无增无漏）', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    const stub: ToolExecutor = async () => '';
    const expected = [
      ...createGitTools(stub),
      ...createSearchTools(stub),
      ...createFsTools(stub),
      ...createShellTools(stub),
      ...createAgentIsolationTools(stub),
    ].map((t: Tool) => t.name());
    const ids = activeToolContributions().map((c) => c.id.split('/').slice(2).join('/'));
    expect(ids.sort()).toEqual([...expected].sort());
    await disposeAll(fibers);
  });
});
