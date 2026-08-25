// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// codingExec 无状态族域第一方插件（P4 B① git/search + ② fs/shell/
// agent-isolation + ①b web + ①c wait/ask/memory/skill/task/agent/hologram）
// 钉住面：
//   1. 贡献清单：一工具一贡献，id = '<插件名>/<工具名>'，注册序 = 族声明序；
//   2. factory 装配语义：需要 rowCtx.codingExec（缺则显式 throw）；工具 execute
//      经 rowCtx.codingExec 穿透执行；同族贡献共享首装配建族（族内 exec 锁存）；
//   3. 生命周期：贡献注册经 ctx.effect——fiber dispose 后贡献消失；
//   4. 折算面：pluginToolRows() 行 id = 'plugin/<贡献 id>'，装配真实可用；
//   5. 端到端：经 buildToolRegistry 真实装配后全部族旧名与域工具在册
//      （可见面零漂移由 verify:convergence 的 tool-schemas 快照守护）；
//   6. ①c 无缓存行：七族贡献声明 noCache——每装配重创实例（装配期真值
//      直收 rowCtx，无跨装配串扰）；hologram 是整组形态（一行贡献承载
//      动态 schema 面 + dataflow 对——名字面装配期才知）。
//   7. ①b browser-desktop 整组缓存行：一行贡献承载整族（动态 import，
//      53 工具名面装配期展开——per-tool 名清单会锁死名面，整族行寻址）。
// 无状态族名序钉（手写清单对拍声明序）在本文件；①c 族名序同此。

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
  createWebTools,
} from '../src/agent/tools/coding';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { activeToolContributions, compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import {
  agentDomainPlugin,
  agentIsolationDomainPlugin,
  askDomainPlugin,
  browserDesktopDomainPlugin,
  fsDomainPlugin,
  gitDomainPlugin,
  hologramDomainPlugin,
  memoryDomainPlugin,
  searchDomainPlugin,
  shellDomainPlugin,
  skillDomainPlugin,
  taskDomainPlugin,
  waitDomainPlugin,
  webDomainPlugin,
} from '../src/plugins/coding-domain-plugins';

/** web 族工具名序（①b 迁入，单工具）。 */
const WEB_TOOL_ORDER = ['web_fetch'];

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

/** 六族全部工具名（序 = 插件注册序 = firstPartyToolPlugins 清单序：
 *  web 居首（①b 前插），git/search/fs/shell/agent-isolation 随后）。 */
const ALL_PLUGIN_TOOL_IDS = [
  ...WEB_TOOL_ORDER.map((n) => `hologram/web-domain/${n}`),
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

/** 应用六域无状态插件到根 Context（四 service 先行——inject 依赖可解析）。
 *  序 = firstPartyToolPlugins 清单序（web 首位，①b 前插）。 */
async function applyPlugins(root: Context) {
  await root.plugin(compositionServicesPlugin);
  const webFiber = await root.plugin(webDomainPlugin);
  const gitFiber = await root.plugin(gitDomainPlugin);
  const searchFiber = await root.plugin(searchDomainPlugin);
  const fsFiber = await root.plugin(fsDomainPlugin);
  const shellFiber = await root.plugin(shellDomainPlugin);
  const isolationFiber = await root.plugin(agentIsolationDomainPlugin);
  return { webFiber, gitFiber, searchFiber, fsFiber, shellFiber, isolationFiber };
}

/** 应用全部十四域插件（含 ①b web/browser-desktop + ①c 七族——生产清单
 *  序同 firstPartyToolPlugins）。 */
async function applyAllPlugins(root: Context) {
  await root.plugin(compositionServicesPlugin);
  const fibers = [];
  fibers.push(await root.plugin(webDomainPlugin));
  fibers.push(await root.plugin(browserDesktopDomainPlugin));
  fibers.push(await root.plugin(hologramDomainPlugin));
  fibers.push(await root.plugin(gitDomainPlugin));
  fibers.push(await root.plugin(searchDomainPlugin));
  fibers.push(await root.plugin(fsDomainPlugin));
  fibers.push(await root.plugin(shellDomainPlugin));
  fibers.push(await root.plugin(agentIsolationDomainPlugin));
  fibers.push(await root.plugin(askDomainPlugin));
  fibers.push(await root.plugin(skillDomainPlugin));
  fibers.push(await root.plugin(memoryDomainPlugin));
  fibers.push(await root.plugin(taskDomainPlugin));
  fibers.push(await root.plugin(agentDomainPlugin));
  fibers.push(await root.plugin(waitDomainPlugin));
  return fibers;
}

/** 全部 fiber 逆序拆卸。 */
async function disposeAll(fibers: Awaited<ReturnType<typeof applyPlugins>>) {
  await fibers.isolationFiber.dispose();
  await fibers.shellFiber.dispose();
  await fibers.fsFiber.dispose();
  await fibers.searchFiber.dispose();
  await fibers.gitFiber.dispose();
  await fibers.webFiber.dispose();
}

describe('codingExec 无状态族域第一方插件（P4 B① git/search + ② fs/shell/agent-isolation + ①b web）', () => {
  it('贡献清单：一工具一贡献，注册序 = 族声明序（对拍手写清单，六族全量）', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    expect(activeToolContributions().map((c) => c.id)).toEqual(ALL_PLUGIN_TOOL_IDS);
    await disposeAll(fibers);
  });

  it('factory 需要装配上下文：缺 rowCtx 显式 throw（错误不静默，六族同语义）', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    for (const suffix of [
      'web_fetch',
      'git_status',
      'search_content',
      'read_file_content',
      'run_shell',
      'agent_isolation_create',
    ]) {
      const probe = activeToolContributions().find((c) => c.id.endsWith(suffix));
      if (!probe) throw new Error(`${suffix} 贡献未注册`);
      expect(() => probe.factory()).toThrow(/需要装配上下文/);
    }
    await disposeAll(fibers);
  });

  it('factory 收 rowCtx：工具可执行且经 rowCtx.codingExec 穿透（web/fs/shell 抽查）', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    const log: Array<{ name: string }> = [];
    const ctx = makeRowCtx(recordingExec(log));
    const tools = activeToolContributions().map((c) => c.factory(ctx));
    const fetch = tools.find((t) => t.name() === 'web_fetch');
    const read = tools.find((t) => t.name() === 'read_file_content');
    const runShell = tools.find((t) => t.name() === 'run_shell');
    if (!fetch || !read || !runShell) throw new Error('web/fs/shell 工具未产出');
    await fetch.execute({ url: 'https://example.com' });
    await read.execute({ filePath: 'D:/proj/a.ts' });
    await runShell.execute({ command: 'ls' });
    expect(log.map((e) => e.name)).toContain('web_fetch');
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
    await fibers.webFiber.dispose();
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

  it('端到端：真实装配后六族旧名在册、fs/shell/web 域工具在册（DOMAIN_SPECS 收敛不破）', async () => {
    const { buildStandardRegistry } = await import('./convergence/helpers/fixtures');
    const reg: ToolRegistry = await buildStandardRegistry();
    const names = reg.names();
    for (const n of [
      ...WEB_TOOL_ORDER,
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
  }, 15_000);
});

// ── 真源对拍：插件贡献工具集 ≡ 族工厂直出集 ──

describe('插件贡献与族工厂真源对拍', () => {
  it('六族插件产出工具集 = 族工厂直出集（无增无漏）', async () => {
    const root = new Context();
    const fibers = await applyPlugins(root);
    const stub: ToolExecutor = async () => '';
    const expected = [
      ...createWebTools(stub),
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

// ── ①c 无缓存行（装配期真值族，2026-08-23 拍板 #2 路线一）──

describe('①c 无缓存行：wait/ask + memory/skill/task/agent + hologram 七族', () => {
  it('七族贡献声明 noCache（每装配重创——pluginToolRows 缓存对其不生效）', async () => {
    const root = new Context();
    const fibers = await applyAllPlugins(root);
    const noCacheIds = activeToolContributions()
      .filter((c) => c.noCache)
      .map((c) => c.id);
    // 等价断言：noCache 贡献两装配产出不同实例（缓存族是同实例）
    const waitRow = pluginToolRows().find((r) => r.id === 'plugin/hologram/wait-domain/wait');
    if (!waitRow) throw new Error('wait 贡献行未注册');
    const ctxA = makeRowCtx(recordingExec([]));
    const ctxB = makeRowCtx(recordingExec([]));
    const toolA = await waitRow.factory(ctxA);
    const toolB = await waitRow.factory(ctxB);
    expect(toolB[0]).not.toBe(toolA[0]); // 无缓存：每装配新实例
    expect(toolB[0]!.name()).toBe('wait');
    // 对照：无状态族（缓存行）两装配同实例
    const shellRow = pluginToolRows().find((r) => r.id === 'plugin/hologram/shell-domain/run_shell');
    if (!shellRow) throw new Error('run_shell 贡献行未注册');
    const shellA = await shellRow.factory(ctxA);
    const shellB = await shellRow.factory(ctxB);
    expect(shellB[0]).toBe(shellA[0]);
    expect(noCacheIds.length).toBeGreaterThan(0);
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('装配期真值直收 rowCtx：ui 回调每次装配换新（ask 域）', async () => {
    const root = new Context();
    const fibers = await applyAllPlugins(root);
    const askRow = pluginToolRows().find((r) => r.id === 'plugin/hologram/ask-domain/ask_user');
    if (!askRow) throw new Error('ask_user 贡献行未注册');
    const callsA: string[] = [];
    const ctxA = {
      ...makeRowCtx(recordingExec([])),
      ui: {
        askUser: (req: { id: string; callback: (res: string[]) => void }) => {
          callsA.push(req.id);
          req.callback(['ok']);
        },
      },
    };
    const toolA = await askRow.factory(ctxA);
    const out = await toolA[0]!.execute({ question: 'q' });
    expect(callsA).toHaveLength(1); // 装配 A 的 ui 回调被调用
    expect(out).toContain('ok');
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('hologram 整组贡献：graphData 缺帐空集；有图时 mock schema + dataflow 对产出', async () => {
    const root = new Context();
    const fibers = await applyAllPlugins(root);
    const row = pluginToolRows().find((r) => r.id === 'plugin/hologram/engine-domain/tools');
    if (!row) throw new Error('hologram 整组贡献行未注册');
    // 缺帐 = 空集（原 if (graphData) 分支）
    const empty = await row.factory({ ...makeRowCtx(recordingExec([])), graphData: undefined });
    expect(empty).toEqual([]);
    // 有图（jsdom mock 通道：loadHologramSchemas 走 mockInvoke 返回 36 schema）
    const tools = await row.factory({ ...makeRowCtx(recordingExec([])), graphData: { nodes: [] } });
    const names = tools.map((t) => t.name());
    expect(names).toContain('dataflow_save');
    expect(names).toContain('dataflow_query');
    expect(names).toContain('search_symbols'); // mock schema 面（graph/ops/lsp 域的旧名）
    expect(names.some((n) => n === 'explore_deps' || n === 'resolve_call')).toBe(true);
    // 无缓存：两次装配重创
    const again = await row.factory({ ...makeRowCtx(recordingExec([])), graphData: { nodes: [] } });
    expect(again[0]).not.toBe(tools[0]);
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('条件族缺帐 = 空集（memory/skill/agent 域——原行 if 分支语义）', async () => {
    const root = new Context();
    const fibers = await applyAllPlugins(root);
    const rows = pluginToolRows();
    const base = makeRowCtx(recordingExec([]));
    const memoryRow = rows.find((r) => r.id === 'plugin/hologram/memory-domain/hologram_memory_list');
    const skillRow = rows.find((r) => r.id === 'plugin/hologram/skill-domain/Skill');
    const agentRow = rows.find((r) => r.id === 'plugin/hologram/agent-domain/agent_spawn');
    if (!memoryRow || !skillRow || !agentRow) throw new Error('①c 条件族贡献行未注册');
    expect(await memoryRow.factory(base)).toEqual([]); // memoryManager 缺帐
    expect(await skillRow.factory(base)).toEqual([]); // skillRegistry 缺帐
    expect(await agentRow.factory(base)).toEqual([]); // subAgentSpawner 缺帐
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });
});

// ── ①b browser-desktop 整组缓存行（2026-08-23）──

describe('①b browser-desktop 整组缓存行：动态 import 族一行贡献承载', () => {
  it('整组贡献：一行注册，产出 browser_*/desktop_* 全族（动态 import 装配期展开）', async () => {
    const root = new Context();
    const fibers = await applyAllPlugins(root);
    const row = pluginToolRows().find((r) => r.id === 'plugin/hologram/browser-desktop-domain/tools');
    if (!row) throw new Error('browser-desktop 整组贡献行未注册');
    const tools = await row.factory(makeRowCtx(recordingExec([])));
    const names = tools.map((t) => t.name());
    expect(names.some((n) => n.startsWith('browser_'))).toBe(true);
    expect(names.some((n) => n.startsWith('desktop_'))).toBe(true);
    expect(names.length).toBeGreaterThan(40); // 整族承载（非单工具行）
    // 声明不收 rowCtx 装配期真值 → 不声明 noCache（实例缓存行）
    const contribution = activeToolContributions().find((c) => c.id === 'hologram/browser-desktop-domain/tools');
    expect(contribution?.noCache).toBeUndefined();
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('实例缓存：两装配同实例（无装配期依赖，缓存语义等价——对照 noCache 族）', async () => {
    const root = new Context();
    const fibers = await applyAllPlugins(root);
    const row = pluginToolRows().find((r) => r.id === 'plugin/hologram/browser-desktop-domain/tools');
    if (!row) throw new Error('browser-desktop 整组贡献行未注册');
    const a = await row.factory(makeRowCtx(recordingExec([])));
    const b = await row.factory(makeRowCtx(recordingExec([])));
    expect(b[0]).toBe(a[0]); // 缓存行：跨装配复用（闭包只引用模块级 agentInvoke）
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('端到端：真实装配后 browser/desktop 全族旧名在册（可见面零漂移由 convergence 守护）', async () => {
    const { buildStandardRegistry } = await import('./convergence/helpers/fixtures');
    const reg: ToolRegistry = await buildStandardRegistry();
    const names = reg.names();
    expect(names).toContain('browser_launch');
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('desktop_probe');
    expect(names).toContain('desktop_uia_click');
  });
});
