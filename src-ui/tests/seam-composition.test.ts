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
// S6 P2a（2026-09-15）追加 ⑨-⑫：**装配期值注入**——seam 裁剪面从「全局一份」
// 推进到「每 Agent 一份」（携带层 composition/seam-scope.ts，键 = Agent bus id）。
// ⑨ = 设计件 §2 序列 D 的验收（同一 fs 工具实例、两卷落不同 provider 且互不串味）；
// ⑩⑪ = subagents / loopEvents 两消费单点；⑫ = 生命周期（dispose 清行）+ 哨兵
// （无 owner 的直调仍读全局当前选择 ⇒ 旧路径零漂移）。①-⑧ 一行未改。

import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent';
import { AgentContext } from '../src/agent/context';
import { AgentEventBus } from '../src/agent/events';
import type { SubAgentSpawnHost } from '../src/agent/subagent-spawn';
import type { ToolExecutor, ToolRegistry } from '../src/agent/tool';
import { createFsTools, fsExecute } from '../src/agent/tools/coding';
import type { FsProvider } from '../src/composition/fs-service';
import { activeFsProviders, registeredFsProviders } from '../src/composition/fs-service';
import type { CompositionPatch, ResolvedComposition } from '../src/composition/roster';
import { CompositionPatchError, factoryComposition, resolveRoster } from '../src/composition/roster';
import { resetSeamDisabled } from '../src/composition/seam-resolution';
import { clearSeamScopesForTest } from '../src/composition/seam-scope';
import type { LlmAdapterContribution } from '../src/composition/services';
import { activeLlmAdapters, registeredLlmAdapters } from '../src/composition/services';
import {
  activeSessionPersistenceProviders,
  registeredSessionPersistenceProviders,
} from '../src/composition/session-persistence-service';
import { activeShellProviders } from '../src/composition/shell-service';
import type { SubagentProvider } from '../src/composition/subagent-service';
import { activeSubagentProviders, registeredSubagentProviders } from '../src/composition/subagent-service';
import { createProvider } from '../src/provider/index';
import type { Provider } from '../src/provider/types';
import { useCompositionStore } from '../src/state/composition-store';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

afterEach(() => {
  resetSeamDisabled();
  // 装配期 seam 作用域随 ctx.dispose 自清；本行兜住「断言失败提前退出」的残留。
  clearSeamScopesForTest();
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
    model: () => tag,
    stream: async function* () {
      /* 探针不产流 */
    },
  };
}

/** 经 composition-store 灌入 patch（运行时唯一灌入点）。 */
function applyPatch(patch: CompositionPatch): void {
  useCompositionStore.getState().setResolved(resolveRoster(factoryComposition(), [patch]), 'test');
}

/** 组合产物夹具（P2a）：直接给 Agent 的 ctx 挂一份解析产物——不起 runtime/壳。 */
function compositionWith(patch: CompositionPatch): ResolvedComposition {
  return resolveRoster(factoryComposition(), [patch]);
}

function stubRegistry(): ToolRegistry {
  return { get: () => undefined } as unknown as ToolRegistry;
}

/** 真实 Agent 夹具（P2a）——构造期跑**装配期登记/灌入**：seam 作用域（键 = bus id）
 *  + loop 事件总线视图。这是「值注入」的装配侧唯一入口，测试不绕开它。 */
function assembleAgent(agentId: string, composition: ResolvedComposition): { ctx: AgentContext; agent: Agent } {
  const ctx = new AgentContext(
    { agentId, parentId: null, subagentDepth: 0 },
    { provider: stubProvider('probe-provider'), tools: stubRegistry(), eventSink: () => {} },
  );
  ctx.set('composition', composition);
  return { ctx, agent: new Agent(ctx, 'test') };
}

/** 假子代理 provider（P2a 夹具；记 id 便于分辨「哪一卷走了哪一个」）。 */
function fakeSubagents(id: string): SubagentProvider {
  return {
    id,
    async spawn(_host: SubAgentSpawnHost, args: { description: string }) {
      return { text: `(${id}) ${args.description}` };
    },
  };
}

describe('seam 裁剪域（组合解析 × ctx seam 消费视图）', () => {
  it('① 工厂恒等：空层解析 ≡ factory（seams 快照 + seamDisabled 全空）', async () => {
    await ensureProductionChannelsBooted();
    const factory = factoryComposition();
    const resolved = resolveRoster(factory, []);
    expect(resolved.tools.map((r) => r.id)).toEqual(factory.tools.map((r) => r.id));
    expect(resolved.capabilities.map((c) => c.id)).toEqual(factory.capabilities.map((c) => c.id));
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

  // ── S6 P2a：装配期值注入（per-composition 裁剪面）──────────────────────────

  it('⑨ 序列 D：同一个 fs 工具实例，两卷落不同 provider（A=本地实现 / B=替换实现）', async () => {
    const root = await ensureProductionChannelsBooted();
    const calls: string[] = [];
    const disposeMem = root.fs.register(memoryFsProvider(calls));
    // A 卷裁掉替换实现 ⇒ 落 builtin/rust-fs（dispatch 腰 = 本测试的 stubExec）
    const a = assembleAgent('p2a-fs-A', compositionWith({ 'seam/fs': [{ id: 'test/late-fs', disabled: true }] }));
    // B 卷裁掉默认实现 ⇒ 落替换实现（沙箱/远端同款语义）
    const b = assembleAgent('p2a-fs-B', compositionWith({ 'seam/fs': [{ id: 'builtin/rust-fs', disabled: true }] }));

    // 同一个工具实例（装配面共享——正是「族实例跨装配复用」的现实）
    const tool = createFsTools(stubExec).find((t) => t.name() === 'read_file_content');
    expect(tool).toBeDefined();

    expect(await tool!.execute({ filePath: '/local/a.ts', _owner_id: a.agent.id })).toBe('stub');
    expect(await tool!.execute({ filePath: '/sandbox/a.ts', _owner_id: b.agent.id })).toBe('(late-fs) read');
    // 互不串味：A 卷再调仍走本地实现，替换实现的调用计数不因 A 增长
    expect(await tool!.execute({ filePath: '/local/b.ts', _owner_id: a.agent.id })).toBe('stub');
    expect(calls).toEqual(['read']);

    // 视图层同证：同一时刻两份裁剪面各自成立
    expect(activeFsProviders(a.agent.composition?.seamDisabled).map((p) => p.id)).toEqual(['builtin/rust-fs']);
    expect(activeFsProviders(b.agent.composition?.seamDisabled).map((p) => p.id)).toEqual(['test/late-fs']);

    await a.ctx.dispose();
    await b.ctx.dispose();
    disposeMem();
  });

  it('⑩ subagents 消费点按本 Agent 的组合裁剪（两卷各落各的 provider）', async () => {
    const root = await ensureProductionChannelsBooted();
    const disposeA = root.subagents.register(fakeSubagents('test/sub-a'));
    const disposeB = root.subagents.register(fakeSubagents('test/sub-b'));
    // 全局后注册胜 = test/sub-b；两卷各裁掉对方 ⇒ 视图各自只剩自己那一支
    const a = assembleAgent('p2a-sub-A', compositionWith({ 'seam/subagents': [{ id: 'test/sub-b', disabled: true }] }));
    const b = assembleAgent('p2a-sub-B', compositionWith({ 'seam/subagents': [{ id: 'test/sub-a', disabled: true }] }));

    expect((await a.agent.spawnSubAgent('t', 'p')).text).toBe('(test/sub-a) t');
    expect((await b.agent.spawnSubAgent('t', 'p')).text).toBe('(test/sub-b) t');

    await a.ctx.dispose();
    await b.ctx.dispose();
    disposeB();
    disposeA();
  });

  it('⑪ loopEvents 观测面按本 Agent 的组合裁剪（同一次 spawn，两卷观测面不同）', async () => {
    const root = await ensureProductionChannelsBooted();
    const dispose = root.subagents.register(fakeSubagents('test/sub-events'));
    const a = assembleAgent(
      'p2a-ev-A',
      compositionWith({ 'seam/loopEvents': [{ id: 'subagent/spawn', disabled: true }] }),
    );
    const b = assembleAgent('p2a-ev-B', compositionWith({}));

    const seenA: string[] = [];
    const seenB: string[] = [];
    a.agent.onLoopEvent('subagent/spawn', () => seenA.push('spawn'));
    a.agent.onLoopEvent('subagent/done', () => seenA.push('done'));
    b.agent.onLoopEvent('subagent/spawn', () => seenB.push('spawn'));
    b.agent.onLoopEvent('subagent/done', () => seenB.push('done'));

    // 同一个发射路径（Agent.spawnSubAgent 的三处 emit 调用点零改动）
    await a.agent.spawnSubAgent('t', 'p');
    await b.agent.spawnSubAgent('t', 'p');

    expect(seenA).toEqual(['done']); // A 卷裁掉 spawn，done 照常
    expect(seenB).toEqual(['spawn', 'done']);

    await a.ctx.dispose();
    await b.ctx.dispose();
    dispose();
  });

  it('⑫ 生命周期与哨兵：dispose 后回落全局；无 owner 的直调读全局当前选择', async () => {
    const root = await ensureProductionChannelsBooted();
    resetSeamDisabled(); // 前提显式化：全局当前选择 = 未裁剪
    const calls: string[] = [];
    const disposeMem = root.fs.register(memoryFsProvider(calls));
    const { ctx, agent } = assembleAgent(
      'p2a-life',
      compositionWith({ 'seam/fs': [{ id: 'test/late-fs', disabled: true }] }),
    );
    const tool = createFsTools(stubExec).find((t) => t.name() === 'read_file_content');

    // 卷级：本卷裁掉替换实现 ⇒ 本地实现
    expect(await tool!.execute({ filePath: '/x', _owner_id: agent.id })).toBe('stub');
    // 哨兵：无 owner（无组合上下文的旧路径 / UI 直调）⇒ 全局当前选择（未裁剪 ⇒ 后注册胜）
    expect(await tool!.execute({ filePath: '/x' })).toBe('(late-fs) read');
    // 拆卷：作用域随 ctx.dispose 清行 ⇒ 同一 owner 回落全局
    await ctx.dispose();
    expect(await tool!.execute({ filePath: '/x', _owner_id: agent.id })).toBe('(late-fs) read');
    expect(calls).toEqual(['read', 'read']);

    disposeMem();
  });

  it('⑬ llm seam 按组合注入：同一份 settings，两卷方言解析各归其组合', async () => {
    const root = await ensureProductionChannelsBooted();
    const settings = { kind: 'openai', name: 'p1', apiKey: 'k', baseUrl: 'http://a.test/v1', model: 'm1' };
    // 替代方言（后注册胜 ⇒ 无裁剪时全局默认就是它）
    const dispose = root.llm.register({
      id: 'test/openai-alt',
      kind: 'openai',
      create: () => stubProvider('alt-openai'),
    } satisfies LlmAdapterContribution);

    // A 卷：裁掉替代方言 ⇒ 落 builtin/openai；B 卷：不裁 ⇒ 落替代方言
    const compA = compositionWith({ 'seam/llm': [{ id: 'test/openai-alt', disabled: true }] });
    const compB = compositionWith({});

    // builtin/openai 的 name() = 提供方名（settings.name），替代方言的自报名 = 'alt-openai'
    expect(createProvider(settings as never, { seamView: compA.seamDisabled }).name()).toBe('p1');
    expect(createProvider(settings as never, { seamView: compB.seamDisabled }).name()).toBe('alt-openai');
    // 哨兵：不传 seamView（设置面板连通性测试 / 翻译压缩旁路）= 全局当前选择
    expect(createProvider(settings as never).name()).toBe('alt-openai');

    dispose();
  });
});
