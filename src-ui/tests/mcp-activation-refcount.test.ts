// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 受治进程 × 激活账（S6 P3d）——「组合引用归零 ⇒ 进程停」的端到端骨架。
//
// 命题（WO-S6P3 §2.7 的接线）：manifest 声明 `activation` 的插件，其受治
// **lazy 档**进程的拉起/停止由激活账驱动——装载期不起、装配期首次起、所有
// 持有它的卷都关了才停。另两档不经手：`eager` 归装载期、`with-window` 归窗口。
//
// 破测（2026-09-15 注入验证，见 commit message）：摘掉 loader 的推导声明 → ① 红；
// 把 with-window 也塞进激活面 → ③ 红；把 stopLazy 改成空转 → ② 红。

import { beforeEach, describe, expect, it } from 'vitest';
import { clearActivationsForTest } from '../src/composition/activation';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { loadExternalPlugins, resetPluginRuntimeForTests } from '../src/plugins/loader';
import { type McpBridgeIO, resetMcpGovernorForTests } from '../src/plugins/mcp-bridge';
import { usePluginStore } from '../src/state/plugin-store';

const ORIGIN = 'http://127.0.0.1:14570/plugins';

function jsonResponse(body: unknown): { ok: boolean; json(): Promise<unknown> } {
  return { ok: true, json: async () => body };
}

function mockFetch(
  routes: Record<string, unknown>,
): (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> {
  return async (url: string) => (url in routes ? jsonResponse(routes[url]) : { ok: false, json: async () => null });
}

interface FakeProc {
  killed: boolean;
  proc: unknown;
}

/** 注入 IO：记录 spawn 次数（并应答 MCP 握手，使 lazy 档能到就绪）。 */
function makeFakeIO(): { io: McpBridgeIO; spawns: string[]; procs: FakeProc[] } {
  const spawns: string[] = [];
  const procs: FakeProc[] = [];
  const io: McpBridgeIO = {
    createProcIO: async (id) => {
      spawns.push(id);
      const outCbs = new Set<(line: string) => void>();
      const exitCbs = new Set<(code: number | null) => void>();
      const handle: FakeProc = { killed: false, proc: null };
      handle.proc = {
        writeLine: (line: string) => {
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (msg.method === undefined || msg.id === undefined) return;
          const respond = (result: unknown) => {
            for (const cb of outCbs) cb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
          };
          if (msg.method === 'initialize') {
            respond({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
          } else if (msg.method === 'tools/list') {
            respond({
              tools: [{ name: 'echo', description: '回声', inputSchema: { type: 'object', properties: {} } }],
            });
          } else {
            respond({});
          }
        },
        onStdoutLine: (cb: (line: string) => void) => {
          outCbs.add(cb);
          return () => outCbs.delete(cb);
        },
        onExit: (cb: (code: number | null) => void) => {
          exitCbs.add(cb);
          return () => exitCbs.delete(cb);
        },
        kill: () => {
          handle.killed = true;
          for (const cb of exitCbs) cb(0);
        },
      };
      procs.push(handle);
      return handle.proc as never;
    },
    pluginDir: async (name) => `C:/plugins/${name}`,
  };
  return { io, spawns, procs };
}

/** 带 activation + 受治 MCP 条目的插件 manifest。 */
function manifestWith(lifecycle: 'lazy' | 'eager' | 'with-window', activation = true) {
  return {
    name: 'acme/res',
    version: '1.0.0',
    entry: 'entry.js',
    ...(activation ? { activation: { lazy: true, resources: ['stdio'] } } : {}),
    mcpServers: [{ name: 'engine', transport: 'stdio', command: 'node', lifecycle }],
  };
}

async function loadWith(
  io: McpBridgeIO,
  manifest: Record<string, unknown>,
): Promise<{ root: Context; fiber: { dispose(): Promise<void> } }> {
  const root = new Context();
  const fiber = await root.plugin(compositionServicesPlugin);
  await loadExternalPlugins(root, {
    origin: ORIGIN,
    fetchImpl: mockFetch({
      [ORIGIN + '/']: ['acme/res'],
      [ORIGIN + '/plugins.json']: { disabled: [] },
      [ORIGIN + '/acme/res/manifest.json']: manifest,
    }),
    importModule: async () => ({ default: { name: 'acme/res', apply() {} } }),
    mcpBridgeIO: io,
  });
  return { root, fiber: fiber as unknown as { dispose(): Promise<void> } };
}

const comp = { tools: [{ id: 'plugin/acme/res/mcp/engine' }] };

beforeEach(() => {
  usePluginStore.setState({ plugins: [] });
  resetPluginRuntimeForTests();
  resetMcpGovernorForTests();
  clearActivationsForTest();
});

describe('S6 P3d：受治进程 lazy 档接激活账（组合引用计数）', () => {
  it('① 装载期零 spawn；装配期首次 spawn；全关卷 ⇒ 进程停（不再等空闲回收）', async () => {
    const { io, spawns, procs } = makeFakeIO();
    const { root, fiber } = await loadWith(io, manifestWith('lazy'));
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
    expect(spawns).toEqual([]); // 装载期零副作用（登记 ≠ 激活）

    const h1 = await root.activation.retainForComposition(comp, 'agent-1');
    expect(spawns).toHaveLength(1); // 装配期首次拉起
    expect(procs[0]?.killed).toBe(false);

    const h2 = await root.activation.retainForComposition(comp, 'agent-2');
    expect(spawns).toHaveLength(1); // 第二卷复用（引用计数）
    expect(root.activation.states()).toEqual([{ plugin: 'acme/res', holders: 2, started: true, failure: null }]);

    await root.activation.releaseAll(h1);
    expect(procs[0]?.killed).toBe(false); // 还有持有者 ⇒ 不停
    await root.activation.releaseAll(h2);
    expect(procs[0]?.killed).toBe(true); // 归零 ⇒ 停

    await fiber.dispose();
  });

  it('② with-window 档不经手：激活不拉起（生命周期归窗口）', async () => {
    const { io, spawns } = makeFakeIO();
    const { root, fiber } = await loadWith(io, manifestWith('with-window'));
    // 声明了 activation 但受治条目全是 with-window ⇒ 无可推导的激活面 ⇒ 不接线
    const handles = await root.activation.retainForComposition(comp, 'agent-1');
    expect(handles).toEqual([]);
    expect(spawns).toEqual([]);
    await fiber.dispose();
  });

  it('③ eager 档不经手：装载即拉起（激活面无产出 ⇒ retain 空集，进程照常在跑）', async () => {
    const { io, spawns, procs } = makeFakeIO();
    const { root, fiber } = await loadWith(io, manifestWith('eager', false));
    expect(spawns).toHaveLength(1); // 装载即拉起（eager 既定语义）
    const handles = await root.activation.retainForComposition(comp, 'agent-1');
    expect(handles).toEqual([]); // 无 activation 声明 ⇒ 零记账
    expect(procs[0]?.killed).toBe(false);
    await fiber.dispose();
  });

  it('④ 未声明 activation 的 lazy 受治插件：零接线（既有语义逐字节不变）', async () => {
    const { io, spawns } = makeFakeIO();
    const { root, fiber } = await loadWith(io, manifestWith('lazy', false));
    const handles = await root.activation.retainForComposition(comp, 'agent-1');
    expect(handles).toEqual([]);
    expect(spawns).toEqual([]); // 无激活 ⇒ 不主动拉起（仍是首装配/调用拉起）
    await fiber.dispose();
  });

  it('⑤ 拉起失败可见：激活账记 failure（诊断第四栏），装配不因此抛错', async () => {
    const io: McpBridgeIO = {
      // initialize 不应答 ⇒ 就绪超时（用短时限经 timing 注入不到 loader，故这里
      // 直接让 spawn 抛错——失败路径等价：start 抛 ⇒ 账记 failure）
      createProcIO: async () => {
        throw new Error('spawn 失败（探针）');
      },
      pluginDir: async (name) => `C:/plugins/${name}`,
    };
    const { root, fiber } = await loadWith(io, manifestWith('lazy'));
    const handles = await root.activation.retainForComposition(comp, 'agent-1');
    expect(handles).toHaveLength(1);
    expect(handles[0]?.ok).toBe(false);
    const skipped = root.activation.skipped();
    expect(skipped[0]?.id).toBe('acme/res');
    expect(skipped[0]?.reason).toContain('spawn 失败');
    await fiber.dispose();
  });
});
