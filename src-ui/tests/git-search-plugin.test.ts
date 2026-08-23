// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// git/search 域第一方插件（P4 B①）钉住面：
//   1. 贡献清单：一工具一贡献，id = '<插件名>/<工具名>'，注册序 = 族声明序；
//   2. factory 装配语义：需要 rowCtx.codingExec（缺则显式 throw）；工具 execute
//      经 rowCtx.codingExec 穿透执行；同族贡献共享首装配建族（族内 exec 锁存）；
//   3. 生命周期：贡献注册经 ctx.effect——fiber dispose 后贡献消失；
//   4. 折算面：pluginToolRows() 行 id = 'plugin/<贡献 id>'，装配真实可用；
//   5. 端到端：经 buildToolRegistry 真实装配后 git/search 旧名与域工具在册
//      （可见面零漂移由 verify:convergence 的 tool-schemas 快照守护）。
// git/search 名序钉（手写清单对拍声明序）在本文件 GIT/SEARCH_TOOL_ORDER——
// 搬自 composition-tool-rows.test.ts（行表已无这两族）。

import { describe, expect, it } from 'vitest';
import { SubAgentPool } from '../src/agent/coordinator';
import { TaskManager } from '../src/agent/task';
import type { Tool, ToolExecutor, ToolRegistry, ToolRowContext } from '../src/agent/tool';
import { createGitTools, createSearchTools } from '../src/agent/tools/coding';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { activeToolContributions, compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { gitDomainPlugin, searchDomainPlugin } from '../src/plugins/git-search-plugin';

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

/** 应用两域插件到根 Context（四 service 先行——inject 依赖可解析）。 */
async function applyPlugins(root: Context) {
  await root.plugin(compositionServicesPlugin);
  const gitFiber = await root.plugin(gitDomainPlugin);
  const searchFiber = await root.plugin(searchDomainPlugin);
  return { gitFiber, searchFiber };
}

describe('git/search 域第一方插件（P4 B①）', () => {
  it('贡献清单：一工具一贡献，注册序 = 族声明序（对拍手写清单）', async () => {
    const root = new Context();
    const { gitFiber, searchFiber } = await applyPlugins(root);
    const ids = activeToolContributions().map((c) => c.id);
    expect(ids).toEqual([
      ...GIT_TOOL_ORDER.map((n) => `hologram/git-domain/${n}`),
      ...SEARCH_TOOL_ORDER.map((n) => `hologram/search-domain/${n}`),
    ]);
    await gitFiber.dispose();
    await searchFiber.dispose();
  });

  it('factory 需要装配上下文：缺 rowCtx 显式 throw（错误不静默）', async () => {
    const root = new Context();
    const { gitFiber, searchFiber } = await applyPlugins(root);
    const probe = activeToolContributions().find((c) => c.id.endsWith('git_status'));
    if (!probe) throw new Error('git_status 贡献未注册');
    expect(() => probe.factory()).toThrow(/需要装配上下文/);
    await gitFiber.dispose();
    await searchFiber.dispose();
  });

  it('factory 收 rowCtx：工具可执行且经 rowCtx.codingExec 穿透', async () => {
    const root = new Context();
    const { gitFiber, searchFiber } = await applyPlugins(root);
    const log: Array<{ name: string }> = [];
    const ctx = makeRowCtx(recordingExec(log));
    const tools = activeToolContributions().map((c) => c.factory(ctx));
    const gitStatus = tools.find((t) => t.name() === 'git_status');
    if (!gitStatus) throw new Error('git_status 工具未产出');
    await gitStatus.execute({ path: 'D:/proj' });
    expect(log.map((e) => e.name)).toContain('git_status');
    await gitFiber.dispose();
    await searchFiber.dispose();
  });

  it('同族贡献共享首装配建族：族内 exec 锁存首个 rowCtx（实例缓存语义）', async () => {
    const root = new Context();
    const { gitFiber, searchFiber } = await applyPlugins(root);
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
    await gitFiber.dispose();
    await searchFiber.dispose();
  });

  it('生命周期：贡献注册经 ctx.effect——fiber dispose 后贡献消失', async () => {
    const root = new Context();
    const { gitFiber, searchFiber } = await applyPlugins(root);
    expect(activeToolContributions().length).toBe(GIT_TOOL_ORDER.length + SEARCH_TOOL_ORDER.length);
    await gitFiber.dispose();
    const remaining = activeToolContributions().map((c) => c.id);
    expect(remaining).toEqual(SEARCH_TOOL_ORDER.map((n) => `hologram/search-domain/${n}`));
    await searchFiber.dispose();
    expect(activeToolContributions()).toEqual([]);
  });

  it('折算面：pluginToolRows() 行 id = plugin/<贡献 id>，factory(rowCtx) 装配可用', async () => {
    const root = new Context();
    const { gitFiber, searchFiber } = await applyPlugins(root);
    const rows = pluginToolRows();
    expect(rows.map((r) => r.id)).toEqual([
      ...GIT_TOOL_ORDER.map((n) => `plugin/hologram/git-domain/${n}`),
      ...SEARCH_TOOL_ORDER.map((n) => `plugin/hologram/search-domain/${n}`),
    ]);
    const log: Array<{ name: string }> = [];
    const ctx = makeRowCtx(recordingExec(log));
    for (const row of rows) {
      const tools = await row.factory(ctx);
      expect(tools).toHaveLength(1);
    }
    expect(rows.length).toBe(GIT_TOOL_ORDER.length + SEARCH_TOOL_ORDER.length);
    await gitFiber.dispose();
    await searchFiber.dispose();
  });

  it('端到端：真实装配后 git/search 旧名在册、域工具在册（DOMAIN_SPECS 收敛不破）', async () => {
    const { buildStandardRegistry } = await import('./convergence/helpers/fixtures');
    const reg: ToolRegistry = await buildStandardRegistry();
    const names = reg.names();
    for (const n of [...GIT_TOOL_ORDER, ...SEARCH_TOOL_ORDER]) {
      expect(names).toContain(n);
    }
    // 域工具存在且 action 集 = DOMAIN_SPECS 声明按注册面过滤（blame→git_blame
    // 不在 13 工具集，恒被过滤——搬运前行表装配同款，非本批引入）
    const git = reg.get('git');
    const search = reg.get('search');
    if (!git || !search) throw new Error('git/search 域工具未生成');
    expect(git.domain?.()).toBe('git');
    const { DOMAIN_SPECS } = await import('../src/agent/tools/domains');
    const gitSpec = DOMAIN_SPECS.find((s) => s.name === 'git');
    if (!gitSpec) throw new Error('DOMAIN_SPECS 无 git 域');
    const registered = new Set(GIT_TOOL_ORDER);
    const expectedActions = Object.entries(gitSpec.actions)
      .filter(([, oldName]) => registered.has(oldName))
      .map(([action]) => action);
    expect(git.actions?.()).toEqual(expectedActions);
  });
});

// ── 真源对拍：插件贡献工具集 ≡ createGitTools/createSearchTools 直出集 ──

describe('插件贡献与族工厂真源对拍', () => {
  it('git/search 插件产出工具集 = 族工厂直出集（无增无漏）', async () => {
    const root = new Context();
    const { gitFiber, searchFiber } = await applyPlugins(root);
    const stub: ToolExecutor = async () => '';
    const expected = [...createGitTools(stub), ...createSearchTools(stub)].map((t: Tool) => t.name());
    const ids = activeToolContributions().map((c) => c.id.split('/').slice(2).join('/'));
    expect(ids.sort()).toEqual([...expected].sort());
    await gitFiber.dispose();
    await searchFiber.dispose();
  });
});
