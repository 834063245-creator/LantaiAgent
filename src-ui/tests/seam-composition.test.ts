// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// seam 裁剪域守护（平台化 Phase 3，2026-08-27）：
//   ① 工厂恒等：resolveRoster(factory, []) ≡ factory（含 seams 快照 + seamDisabled 空）
//   ② 寻址禁用（P3-C1）：patch `seam/fs` 禁 builtin/rust-fs → 消费视图剔除
//      （fsExecute 响亮 FS_PROVIDER）；晚注册 provider 可见并接管（替换语义）
//   ③ 重新启用：disabled:false 覆盖 → 回视图；factory 寻址行源 =
//      注册表原始清单（禁用行不消失，可再启用）
//   ④ 跨层 last-write-wins + 未知 id all-or-nothing
//   ⑤ loopEvents 事件面开关：禁用事件不广播，其余事件不受影响（P3 全栈 preset）
//   ⑥ llm seam 禁用：builtin/openai 被禁 → PROVIDER_DIALECT；后注册替代 adapter 接管
//   ⑦ 其余 seam 域消费视图裁剪（subagents/sessionPersistence）
//   ⑧ composition-store 写入口灌入裁剪面（setResolved/setError/resetToFactory）
// 2026-09-09 图谱退役：`seam/graph` 域随 graph-service 整删移除（SEAM_DOMAINS
// 六域——llm/subagents/fs/shell/sessionPersistence/loopEvents）。

import { afterEach, describe, expect, it } from 'vitest';
import { AgentEventBus } from '../src/agent/events';
import type { ToolExecutor } from '../src/agent/tool';
import { createFsTools, fsExecute } from '../src/agent/tools/coding';
import type { FsProvider } from '../src/composition/fs-service';
import { activeFsProviders, registeredFsProviders } from '../src/composition/fs-service';
import type { CompositionPatch } from '../src/composition/roster';
import { CompositionPatchError, factoryComposition, resolveRoster } from '../src/composition/roster';
import { resetSeamDisabled } from '../src/composition/seam-resolution';
import type { LlmAdapterContribution } from '../src/composition/services';
import { activeLlmAdapters, registeredLlmAdapters } from '../src/composition/services';
import {
  activeSessionPersistenceProviders,
  registeredSessionPersistenceProviders,
} from '../src/composition/session-persistence-service';
import { activeShellProviders } from '../src/composition/shell-service';
import { activeSubagentProviders, registeredSubagentProviders } from '../src/composition/subagent-service';
import { createProvider } from '../src/provider/index';
import type { Provider } from '../src/provider/types';
import { useCompositionStore } from '../src/state/composition-store';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

afterEach(() => {
  resetSeamDisabled();
});

const stubExec: ToolExecutor = async () => 'stub';

function memoryFsProvider(calls: string[]): FsProvider {
  return {
    id: 'test/late-fs',
    async execute(action) {
      calls.push(action);
      return `(late-fs) ${action}`;
    },
  };
}

function stubProvider(tag: string): Provider {
  return {
    name: () => tag,
    stream: async function* () {
      /* 探针不产流 */
    },
  };
}

/** 经 composition-store 灌入 patch（运行时唯一灌入点）。 */
function applyPatch(patch: CompositionPatch): void {
  useCompositionStore.getState().setResolved(resolveRoster(factoryComposition(), [patch]), 'test');
}

describe('seam 裁剪域（组合解析 × ctx seam 消费视图）', () => {
  it('① 工厂恒等：空层解析 ≡ factory（seams 快照 + seamDisabled 全空）', async () => {
    await ensureProductionChannelsBooted();
    const factory = factoryComposition();
    const resolved = resolveRoster(factory, []);
    expect(resolved.tools.map((r) => r.id)).toEqual(factory.tools.map((r) => r.id));
    expect(resolved.capabilities.map((c) => c.key)).toEqual(factory.capabilities.map((c) => c.key));
    expect(resolved.shell.map((r) => r.id)).toEqual(factory.shell.map((r) => r.id));
    expect(resolved.seamDisabled).toEqual({
      llm: [],
      subagents: [],
      fs: [],
      shell: [],
      sessionPersistence: [],
      loopEvents: [],
    });
    // seams 寻址域 = 注册表原始清单 + 全部 D4 emit 事件名
    expect(factory.seams.fs.map((r) => r.id)).toEqual(registeredFsProviders().map((p) => p.id));
    expect(factory.seams.llm.map((r) => r.id)).toEqual(registeredLlmAdapters().map((a) => a.id));
    expect(factory.seams.loopEvents.length).toBeGreaterThan(0);
    expect(factory.seams.loopEvents.map((r) => r.id)).toContain('subagent/spawn');
  });

  it('② 寻址禁用：禁 builtin/rust-fs → 消费视图剔除（FS_PROVIDER 响亮）；晚注册 provider 接管', async () => {
    const root = await ensureProductionChannelsBooted();
    const factory = factoryComposition();
    expect(factory.seams.fs.map((r) => r.id)).toContain('builtin/rust-fs');
    applyPatch({ 'seam/fs': [{ id: 'builtin/rust-fs', disabled: true }] });

    expect(activeFsProviders().map((p) => p.id)).not.toContain('builtin/rust-fs');

    // 消费单点：fsExecute 无可见 provider → 响亮报错（显式降级，非静默）
    const tool = createFsTools(stubExec).find((t) => t.name() === 'read_file_content');
    expect(tool).toBeDefined();
    await expect(tool!.execute({ filePath: '/x/a.ts' })).rejects.toThrow(/FS_PROVIDER/);

    // 替换语义：晚注册的替代 provider 不在禁用集 → 可见并接管（P3-C1）
    const calls: string[] = [];
    const dispose = root.fs.register(memoryFsProvider(calls));
    const out = await fsExecute('read', { filePath: '/mem/a.ts' }, stubExec);
    expect(out).toBe('(late-fs) read');
    dispose();
  });

  it('③ 重新启用：disabled:false 覆盖 → 回视图；factory 寻址行源 = 原始清单（禁用行可再启用）', async () => {
    await ensureProductionChannelsBooted();
    applyPatch({ 'seam/fs': [{ id: 'builtin/rust-fs', disabled: true }] });
    expect(activeFsProviders().map((p) => p.id)).not.toContain('builtin/rust-fs');

    // 寻址行源 = 注册表原始清单：被禁用的行仍在快照里（可再启用）
    expect(registeredFsProviders().map((p) => p.id)).toContain('builtin/rust-fs');
    expect(factoryComposition().seams.fs.map((r) => r.id)).toContain('builtin/rust-fs');

    applyPatch({ 'seam/fs': [{ id: 'builtin/rust-fs', disabled: false }] });
    expect(activeFsProviders().map((p) => p.id)).toContain('builtin/rust-fs');
  });

  it('④ 跨层 last-write-wins；未知 seam id = all-or-nothing 拒绝', () => {
    const factory = factoryComposition();
    // `seam/graph` 域已随图谱退役——SEAM_DOMAINS 无 graph，该键在解析域被
    // 忽略（消费视图无 graph 面，无产生可禁行）
    const ignored = resolveRoster(factory, [{ 'seam/graph': [{ id: 'builtin/rust-graph', disabled: true }] }]);
    expect(ignored.seamDisabled).not.toHaveProperty('graph');

    const resolved = resolveRoster(factory, [
      { 'seam/fs': [{ id: 'builtin/rust-fs', disabled: true }] },
      { 'seam/fs': [{ id: 'builtin/rust-fs', disabled: false }] },
    ]);
    expect(resolved.seamDisabled.fs).toEqual([]);

    expect(() => resolveRoster(factory, [{ 'seam/fs': [{ id: 'no/such-provider', disabled: true }] }])).toThrow(
      CompositionPatchError,
    );
  });

  it('⑤ loopEvents 事件面开关：禁用事件不广播，其余照常；裁决域不受影响', async () => {
    await ensureProductionChannelsBooted();
    applyPatch({ 'seam/loopEvents': [{ id: 'subagent/spawn', disabled: true }] });
    const bus = new AgentEventBus();
    const seen: string[] = [];
    bus.onLoopEvent('subagent/spawn', () => seen.push('subagent/spawn'));
    bus.onLoopEvent('turn/start', () => seen.push('turn/start'));
    bus.emitLoopEvent('subagent/spawn', { parentId: 'p', agentId: null, mode: 'fork', async: false });
    bus.emitLoopEvent('turn/start', { agentId: 'p', model: 'm' });
    expect(seen).toEqual(['turn/start']);
  });

  it('⑥ llm seam 禁用：builtin/openai 被禁 → PROVIDER_DIALECT；后注册同 kind adapter 接管', async () => {
    const root = await ensureProductionChannelsBooted();
    applyPatch({ 'seam/llm': [{ id: 'builtin/openai', disabled: true }] });
    expect(activeLlmAdapters().map((a) => a.id)).not.toContain('builtin/openai');
    const settings = { kind: 'openai', name: 'p1', apiKey: 'k', baseUrl: 'http://a.test/v1', model: 'm1' };
    expect(() => createProvider(settings as never)).toThrow(/PROVIDER_DIALECT/);

    // 替换：后注册 openai 方言 adapter 接管（同 kind 后注册胜）
    const dispose = root.llm.register({
      id: 'test/openai-alt',
      kind: 'openai',
      create: () => stubProvider('alt-openai'),
    } satisfies LlmAdapterContribution);
    expect(createProvider(settings as never).name()).toBe('alt-openai');
    dispose();
  });

  it('⑦ 其余 seam 域消费视图裁剪（subagents / sessionPersistence）', async () => {
    await ensureProductionChannelsBooted();
    applyPatch({
      'seam/subagents': [{ id: 'builtin/in-process', disabled: true }],
      'seam/sessionPersistence': [{ id: 'builtin/rust-sessions', disabled: true }],
    });
    expect(activeSubagentProviders()).toEqual([]);
    expect(activeSessionPersistenceProviders()).toEqual([]);
    // 原始清单不动——实现真源在注册表
    expect(registeredSubagentProviders().map((p) => p.id)).toContain('builtin/in-process');
    expect(registeredSessionPersistenceProviders().map((p) => p.id)).toContain('builtin/rust-sessions');
    // `seam/graph` 域随图谱退役不存在——寻址拒绝在 ④ 钉（消费面 graph-service 整删）
  });

  it('⑧ composition-store 写入口灌入：setError/resetToFactory 回退出厂裁剪面', async () => {
    await ensureProductionChannelsBooted();
    applyPatch({ 'seam/shell': [{ id: 'builtin/rust-shell', disabled: true }] });
    expect(activeShellProviders().map((p) => p.id)).not.toContain('builtin/rust-shell');

    useCompositionStore.getState().setError('boom', 'test');
    expect(activeShellProviders().map((p) => p.id)).toContain('builtin/rust-shell');

    useCompositionStore.getState().resetToFactory();
    expect(activeShellProviders().map((p) => p.id)).toContain('builtin/rust-shell');
  });
});
