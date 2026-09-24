// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 随包图谱引擎 · **装配面端到端**（2026-09-24 用户实机报：「勾了随包引擎 + 接线显示正常 +
// 进程也拉起来了，但 Agent 手里没有图谱工具」）。
//
// 既有回归（`bundled-engine.test.ts` / `bundled-engine-probe-shape.test.ts`）只钉到
// **通道层**：探测形状、行注册（`pluginToolRows()` 含该行）、激活声明、预热被调用。
// 通道层全绿而用户仍然没有工具 —— 断点就在「通道 → 注册表」之间，本文件补那一段：
//
//   ① **组合快照的时点**：`workspace.ts` 在接线**之前**取 `composition`（供
//      `new AgentRuntime(...)` 与 `_buildRegistryLocked(...)` 共用），而引擎的工具行
//      是接线时才注册的 ⇒ 该快照里根本没有这一行 ⇒ 装配出来的注册表不含引擎工具
//      （runtime 的激活 retain 也看不见它）。
//   ② **工具面的就绪时点**：行工厂按 `governor.toolFace()` 快照产出，而进程
//      initialize + tools/list 是异步的；接线只做 fire-and-forget 预热 ⇒ 装配时
//      工具面还是空集（空集不缓存 = 「下次装配重试」，而共享注册表路径**没有**下次装配）。
//
// 判据：真 Workspace 装配腰（组合层 service 装在内核根上——生产同构）+ 真 MCP 行协议
// （ProcIO 注入 fake，initialize 应答由测试闸门放行）⇒ **建出来的注册表里必须有
// `mcp__hologram__*`**，且接线回执如实报出工具数。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcIO } from '../src/agent/mcp';
import type { ToolRegistry } from '../src/agent/tool';

// ── settings / rpc / logger / bridge mock 面（workspace 装配腰最小面）──
vi.mock('../src/settings', () => ({
  loadSettings: () => ({ display: { language: 'zh', fontScale: 1 }, agent: {}, providers: [] }),
  loadSettingsWithSecrets: async () => ({
    display: { language: 'zh', fontScale: 1 },
    agent: {},
    providers: [{ name: 'none', kind: 'openai', apiKey: '' }],
  }),
  getActiveProvider: (s: { providers?: Array<{ name: string; kind: string; apiKey?: string }> }) =>
    s?.providers?.[0] ?? { name: 'none', kind: 'openai', apiKey: '' },
  modelContextWindow: () => 8192,
  saveSettings: () => {},
  providerId: (name: string) => name,
}));
vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(async () => '{}'),
  // 随包引擎探测面（engine_bundled_info）在产线是 `// JSON` 形态的结构化返回
  typedJsonRpc: vi.fn(async (method: string) =>
    method === 'engine_bundled_info' ? { path: 'D:/x/hologram-engine.exe', dir: 'D:/x', available: true } : {},
  ),
  typedListen: vi.fn(async () => () => {}),
  parseJson: (raw: unknown) => JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw ?? 'null')),
  kernelGlobalMemoryDir: async () => 'D:/mock/global-memory',
  kernelCreateDirectory: async () => '',
  kernelWriteFile: async () => '',
  kernelReadFile: async () => '',
}));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/bridge', () => ({ isMockMode: () => false }));

// ── 引擎子进程替身：真 MCP 行协议，initialize 应答由闸门放行 ──
// 闸门存在的理由：真实引擎经 Rust protocol_bridge spawn 要走「起进程 + 握手」数百毫秒，
// 而工作区装配只花微秒级——「预热 fire-and-forget」在这段真实时间差里必输。闸门把这段
// 时间差显式化，使本用例确定性复现（而不是靠 setTimeout 赌调度）。
const engineProc = vi.hoisted(() => {
  type Line = (line: string) => void;
  return {
    outCbs: new Set<Line>(),
    exitCbs: new Set<(code: number | null) => void>(),
    gateOpen: false,
    gateWaiters: [] as Array<() => void>,
    spawns: [] as string[],
  };
});

vi.mock('../src/agent/mcp/tauri-io', () => ({
  createTauriProcIO: async (bridgeId: string): Promise<ProcIO> => {
    engineProc.spawns.push(bridgeId);
    const emit = (msg: unknown) => {
      const line = JSON.stringify(msg);
      for (const cb of engineProc.outCbs) cb(line);
    };
    const afterGate = () =>
      engineProc.gateOpen
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            engineProc.gateWaiters.push(resolve);
          });
    return {
      writeLine: (line) => {
        const msg = JSON.parse(line) as { id?: number; method?: string };
        if (msg.id === undefined || msg.method === undefined) return; // 通知：无需应答
        if (msg.method === 'initialize') {
          void afterGate().then(() =>
            emit({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                serverInfo: { name: 'hologram', version: '0' },
              },
            }),
          );
        } else if (msg.method === 'tools/list') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'graph',
                  description: '图谱域（折叠面）',
                  inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
                },
                {
                  name: 'analysis',
                  description: '分析域（折叠面）',
                  inputSchema: { type: 'object', properties: {} },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
          });
        } else {
          emit({ jsonrpc: '2.0', id: msg.id, result: {} });
        }
      },
      onStdoutLine: (cb) => {
        engineProc.outCbs.add(cb);
        return () => engineProc.outCbs.delete(cb);
      },
      onExit: (cb) => {
        engineProc.exitCbs.add(cb);
        return () => engineProc.exitCbs.delete(cb);
      },
      kill: () => {
        for (const cb of engineProc.exitCbs) cb(0);
      },
    };
  },
}));

// ── 捕获装配产物（真 buildToolRegistry，只多看一层返回的注册表）──
const captured = vi.hoisted(() => ({ registries: [] as unknown[] }));
vi.mock('../src/agent/runtime/agent-builder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/runtime/agent-builder')>();
  return {
    ...actual,
    buildToolRegistry: async (opts: Parameters<typeof actual.buildToolRegistry>[0]) => {
      const reg = await actual.buildToolRegistry(opts);
      captured.registries.push(reg);
      return reg;
    },
  };
});

import { agentSessionState } from '../src/agent/agent-session-state';
import { capabilitiesServicePlugin } from '../src/composition/capability-service';
import { firstPartyCapabilityPlugins } from '../src/composition/first-party-capabilities';
import { firstPartyToolPlugins } from '../src/composition/first-party-tools';
import { applyDefaultPreset, clearUserPatch } from '../src/composition/preset-assembly';
import { compositionServicesPlugin } from '../src/composition/services';
import { initCordisKernel } from '../src/cordis/boot';
import type { LantaiPlugin } from '../src/plugins/types';
import { useBundledEngineStore } from '../src/state/bundled-engine-store';
import { useCompositionStore } from '../src/state/composition-store';
import { usePresetStore } from '../src/state/preset-store';
import { setAgentFactory } from '../src/ui/chat-session';
import { getChatStore } from '../src/ui/chat-store';

const PANEL = 'bundled-engine-assembly-panel';
/** 引擎工具在注册表里的模型可见名（server name = hologram）。 */
const ENGINE_TOOLS = ['mcp__hologram__graph', 'mcp__hologram__analysis'];

/** 轮询等待条件成立（真定时器——闸门放行是跨微任务的）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 组合层按**生产同构**装载：service + 贡献者全挂内核根（工作区 fiber 是它的小孩，
 *  子 fiber 的 `inject: ['tools','activation']` 才解析得到——`withFirstPartyToolChannel`
 *  用的是自己的临时根，工作区看不到它，故本文件不能用那条腰）。 */
async function withKernelComposition<T>(run: () => Promise<T>): Promise<T> {
  const root = initCordisKernel();
  const fibers: Array<Awaited<ReturnType<typeof root.plugin>>> = [];
  try {
    fibers.push(await root.plugin(compositionServicesPlugin));
    fibers.push(await root.plugin(capabilitiesServicePlugin));
    for (const plugin of [...firstPartyToolPlugins(), ...firstPartyCapabilityPlugins()] as LantaiPlugin[]) {
      fibers.push(await root.plugin(plugin));
    }
    return await run();
  } finally {
    for (let i = fibers.length - 1; i >= 0; i--) await fibers[i].dispose();
  }
}

function makePanel() {
  return {
    panelId: PANEL,
    setProjectPath: vi.fn(),
    setAgentFactory: (fn: unknown) => setAgentFactory(PANEL, fn as never),
    eventSink: { emit: vi.fn() },
    execState: { subscribe: vi.fn(() => () => {}) },
    eventSinkFor: () => ({ emit: vi.fn() }),
    getSessionExecState: () => ({ subscribe: vi.fn(() => () => {}), bumpVersion: vi.fn() }),
    saveActiveSession: async () => {},
    saveCanvasState: async () => {},
  };
}

/** 装配产物 = 最后一次 buildToolRegistry 的注册表（共享注册表；无会话覆盖时 Agent 直接吃它）。 */
function lastRegistryNames(): string[] {
  const reg = captured.registries.at(-1) as ToolRegistry | undefined;
  if (!reg) throw new Error('没有捕获到注册表装配产物');
  return reg.all().map((t) => t.name());
}

describe('随包引擎 → Agent 工具面（装配面端到端）', () => {
  beforeEach(() => {
    engineProc.gateOpen = false;
    engineProc.gateWaiters = [];
    engineProc.spawns = [];
    engineProc.outCbs.clear();
    engineProc.exitCbs.clear();
    captured.registries = [];
    agentSessionState.clearPanelState(PANEL);
    getChatStore(PANEL).sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
    usePresetStore.setState({ selected: 'standard', error: null });
    useBundledEngineStore.getState().reset();
    clearUserPatch();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('启用引擎 + 开工作区：Agent 的注册表里必须有 mcp__hologram__*，回执如实报工具数', async () => {
    localStorage.setItem('lantai.bundledEngine.enabled', 'true');
    const { resetBundledEngineForTests } = await import('../src/plugins/bundled-engine');
    resetBundledEngineForTests();

    await withKernelComposition(async () => {
      useCompositionStore.getState().resetToFactory();
      applyDefaultPreset();

      const { Workspace } = await import('../src/workspace');
      const panel = makePanel();
      const ws = await Workspace.open('D:/wsEngineAssembly', {
        onStatusChange: () => {},
        onLoadingChange: () => {},
      });
      try {
        // setupAgent 不 await：装配被「引擎就绪」挡住时我们要能从外面放行闸门
        const setup = ws.setupAgent(panel as never);
        await waitFor(() => engineProc.spawns.length > 0, 10_000, '引擎进程被拉起（预热/激活）');
        engineProc.gateOpen = true;
        for (const release of engineProc.gateWaiters.splice(0)) release();
        await setup;

        const names = lastRegistryNames();
        for (const tool of ENGINE_TOOLS) {
          expect(names, `Agent 的注册表缺 ${tool}（引擎工具行没进装配）`).toContain(tool);
        }
        // 回执必须如实：接线成功 = 工具真的在册（用户可见的判据）
        const receipt = useBundledEngineStore.getState();
        expect(receipt.status).toBe('wired');
        expect(receipt.toolCount, '回执要报出实际在册的引擎工具数').toBe(ENGINE_TOOLS.length);
      } finally {
        await ws.deactivate(panel as never);
      }
    });
  }, 60_000);

  it('开关未启用：注册表里没有引擎工具（默认关的构造性零漂移）', async () => {
    await withKernelComposition(async () => {
      useCompositionStore.getState().resetToFactory();
      applyDefaultPreset();
      const { Workspace } = await import('../src/workspace');
      const panel = makePanel();
      const ws = await Workspace.open('D:/wsEngineOff', {
        onStatusChange: () => {},
        onLoadingChange: () => {},
      });
      try {
        await ws.setupAgent(panel as never);
        expect(lastRegistryNames().filter((n) => n.startsWith('mcp__hologram__'))).toEqual([]);
        expect(engineProc.spawns).toEqual([]); // 未启用 = 零 spawn
        expect(useBundledEngineStore.getState().status).toBe('off');
      } finally {
        await ws.deactivate(panel as never);
      }
    });
  }, 60_000);
});
