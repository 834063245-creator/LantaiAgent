// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 第三方 MCP server → Agent 工具面（**装配面端到端**，2026-09-24 立）。
//
// 缘起：用户问「随包引擎这条链路都能连炸四处，那我自己配第三方 MCP 到底能不能用？」
// ——问得对，因为**受治档（声明 restart/lifecycle）当时是坏的**，而且坏法与引擎那次
// 一模一样、动静一样安静：
//
//   行工厂按 `governor.toolFace()` 快照产出，而工具面在**装配时点冻结**；旧语义
//   「未就绪 ⇒ 立即返回空集（不缓存，下次装配重试）」在**工作区共享注册表**路径上
//   等于永久失效——那张注册表建一次就被所有同组合的卷复用，**没有「下次装配」**。
//   于是任何声明了治理字段的第三方 server（`lifecycle` / `restart` 任一声明即入受治档）
//   工具一件都到不了模型手里，用户侧只有 console 里一行 warn。
//
// 两条路的差别（本文件各钉一条）：
//   · **旧形态**（两字段皆缺席——用户 `~/.lantai/mcp.json` 与插件 manifest 的
//     典型写法）：行工厂在装配期**自己连接**并 await，故工具面当场就有 ✔
//   · **受治形态**（声明 restart/lifecycle——引擎与「要崩溃自愈」的 server 走这条）：
//     修法 = 装配期有界等待就绪（mcp-bridge 的 `ASSEMBLY_READY_WAIT_MS`），
//     失败仍留空集 + 可见 warn（真因照抄治理器原文）。
//
// 判据落在**消费端真值**：Agent 的注册表（`ToolRegistry`）里必须有 `mcp__<server>__*`。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcIO } from '../src/agent/mcp';
import type { ToolRegistry } from '../src/agent/tool';

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
  typedJsonRpc: vi.fn(async () => ({})),
  typedListen: vi.fn(async () => () => {}),
  parseJson: (raw: unknown) => JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw ?? 'null')),
  kernelGlobalMemoryDir: async () => 'D:/mock/.lantai/global_memory',
  kernelCreateDirectory: async () => '',
  kernelWriteFile: async () => '',
  kernelReadFile: async () => '',
}));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/bridge', () => ({ isMockMode: () => false }));

/** 捕获装配产物（真 buildToolRegistry，只多看一层返回的注册表）。 */
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
import { applyDefaultPreset, clearUserPatch, reapplyComposition } from '../src/composition/preset-assembly';
import { compositionServicesPlugin, onToolContributionsChanged } from '../src/composition/services';
import { initCordisKernel } from '../src/cordis/boot';
import { type McpBridgeIO, registerMcpServerTools } from '../src/plugins/mcp-bridge';
import type { LantaiPlugin, McpServerDecl } from '../src/plugins/types';
import { useCompositionStore } from '../src/state/composition-store';
import { usePresetStore } from '../src/state/preset-store';
import { setAgentFactory } from '../src/ui/chat-session';
import { getChatStore } from '../src/ui/chat-store';

const PANEL = 'third-party-mcp-panel';

/** 立刻应答的 MCP 行协议替身（真 initialize + tools/list 往返）。 */
function instantMcpIO(spawns: string[]): McpBridgeIO {
  return {
    createProcIO: async (bridgeId): Promise<ProcIO> => {
      spawns.push(bridgeId);
      const outCbs = new Set<(line: string) => void>();
      const exitCbs = new Set<(code: number | null) => void>();
      const emit = (m: unknown) => {
        const line = JSON.stringify(m);
        for (const cb of outCbs) cb(line);
      };
      return {
        writeLine: (line) => {
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (msg.id === undefined || msg.method === undefined) return; // 通知：无需应答
          if (msg.method === 'initialize') {
            emit({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'probe', version: '0' } },
            });
          } else if (msg.method === 'tools/list') {
            emit({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  { name: 'echo', description: '回声', inputSchema: { type: 'object', properties: {} } },
                  { name: 'ping', description: '探活', inputSchema: { type: 'object', properties: {} } },
                ],
              },
            });
          } else {
            emit({ jsonrpc: '2.0', id: msg.id, result: {} });
          }
        },
        onStdoutLine: (cb) => {
          outCbs.add(cb);
          return () => outCbs.delete(cb);
        },
        onExit: (cb) => {
          exitCbs.add(cb);
          return () => exitCbs.delete(cb);
        },
        kill: () => {
          for (const cb of exitCbs) cb(0);
        },
      };
    },
    pluginDir: async () => 'D:/mock/.lantai',
  };
}

/** 组合层按生产同构装在内核根上（工作区 fiber 是它的小孩——服务可见性同生产）。 */
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

function mcpToolNames(): string[] {
  const reg = captured.registries.at(-1) as ToolRegistry | undefined;
  if (!reg) throw new Error('没有捕获到注册表装配产物');
  return reg
    .all()
    .map((t) => t.name())
    .filter((n) => n.startsWith('mcp__'));
}

/** 走完整装配：boot 期装 server（main.ts 用户级 / loader 插件级的同一调用点）
 *  → 开工作区 → 建共享注册表 → 看 Agent 手里有什么。 */
async function assembleWith(decl: McpServerDecl, label: string): Promise<string[]> {
  const spawns: string[] = [];
  const io = instantMcpIO(spawns);
  return await withKernelComposition(async () => {
    const root = initCordisKernel();
    // boot 期贡献监听（生产 = shell/boot.ts 的 armContributionsWatcher）
    onToolContributionsChanged(reapplyComposition);
    await registerMcpServerTools(root, 'user', [decl], io);
    reapplyComposition();
    useCompositionStore.getState().resetToFactory();
    applyDefaultPreset();

    const { Workspace } = await import('../src/workspace');
    const panel = makePanel();
    const ws = await Workspace.open(`D:/ws-${label}`, { onStatusChange: () => {}, onLoadingChange: () => {} });
    try {
      await ws.setupAgent(panel as never);
      expect(spawns.length, '该 server 应被拉起一次').toBeGreaterThan(0);
      return mcpToolNames();
    } finally {
      await ws.deactivate(panel as never);
    }
  });
}

describe('第三方 MCP → Agent 工具面（两条装载路都要到手）', () => {
  beforeEach(() => {
    captured.registries = [];
    agentSessionState.clearPanelState(PANEL);
    getChatStore(PANEL).sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
    usePresetStore.setState({ selected: 'standard', error: null });
    clearUserPatch();
  });

  it('旧形态（无治理字段——mcp.json / manifest 的典型写法）：工具在册', async () => {
    const names = await assembleWith({ name: 'probe', transport: 'stdio', command: 'x' }, 'legacy');
    expect(names).toEqual(['mcp__probe__echo', 'mcp__probe__ping']);
    // 破测：把旧形态的装配期连接改成「不 await」→ 本用例红（这条本来就对，
    // 立此存照：它是「第三方默认可用的那条路」的判据）。
  }, 60_000);

  it('受治形态（声明 restart: on-crash）：工具同样必须在册', async () => {
    // 破测：把 registerGovernedServer 的行工厂改回「未就绪立即返回空集」→ 本用例红
    // （2026-09-24 实测缺陷：受治档第三方 server 工具**永久**进不了模型工具面——
    //  工具面在装配时点冻结，而共享注册表路径没有「下次装配」）。
    const names = await assembleWith(
      { name: 'probe', transport: 'stdio', command: 'x', restart: 'on-crash' },
      'governed',
    );
    expect(names).toEqual(['mcp__probe__echo', 'mcp__probe__ping']);
  }, 60_000);

  it('受治形态 × lifecycle: lazy（引擎同档）：工具同样必须在册', async () => {
    const names = await assembleWith({ name: 'probe', transport: 'stdio', command: 'x', lifecycle: 'lazy' }, 'lazy');
    expect(names).toEqual(['mcp__probe__echo', 'mcp__probe__ping']);
  }, 60_000);
});
