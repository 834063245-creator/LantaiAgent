// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件医生（2026-11-23 批 3）：只读聚合的读数来源钉死。
//   a) 内置内核插件（builtin + 无 manifest）没有磁盘目录 ⇒ null，且**不追问 RPC**
//      ——诊断不许把「本来就没有」渲染成「坏了」；
//   b) 外部 app 插件：路径 / 窗口 / 声明工具 / 激活声明都取到真读数；
//   c) 受治进程一栏接治理器真状态：就绪 → 空闲回收后 lastStopReason 可见。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcIO } from '../src/agent/mcp';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { collectPluginDiagnostics, type DiagnosticsPaths } from '../src/plugins/diagnostics';
import { type McpBridgeIO, registerMcpServerTools, resetMcpGovernorForTests } from '../src/plugins/mcp-bridge';
import { usePluginWindowStore } from '../src/state/plugin-window-store';

const PATHS: DiagnosticsPaths = {
  pluginDir: async (name) => `C:/plugins/${name}`,
  dataDir: async (name) => `C:/plugins-data/${name}`,
};

beforeEach(() => {
  resetMcpGovernorForTests();
  usePluginWindowStore.getState().resetPluginWindowsForTests();
});

describe('插件医生：只读聚合读数', () => {
  it('内置内核插件：无磁盘目录 = null，不追问 RPC，不当错误', async () => {
    const pluginDir = vi.fn(async () => 'C:/should-not-be-asked');
    const diag = await collectPluginDiagnostics(
      { name: 'hologram/settings', manifest: null, status: 'active', builtin: true },
      { ...PATHS, pluginDir },
    );
    expect(diag.pluginDir).toBeNull();
    expect(pluginDir).not.toHaveBeenCalled();
    expect(diag.builtin).toBe(true);
    expect(diag.error).toBeNull();
    expect(diag.manifest).toBeNull();
    expect(diag.tools).toEqual({ declared: [], mcp: [] });
    expect(diag.windows).toEqual({ declared: false, mode: null, open: 0 });
    expect(diag.activation.declared).toBe(false);
  });

  it('外部 app 插件：路径 / 窗口 / 工具声明 / 激活声明 / 警告全部透传', async () => {
    usePluginWindowStore.getState().registerAppDef({
      pluginName: 'acme/notes',
      entryUrl: 'http://127.0.0.1:1/plugins/acme/notes/app/index.html',
      kind: 'asset',
      mode: 'floating',
      title: '便签',
      documents: false,
    });
    usePluginWindowStore.getState().openWindow('acme/notes');
    const diag = await collectPluginDiagnostics(
      {
        name: 'acme/notes',
        status: 'active',
        warnings: ['未知顶层字段：bogus'],
        manifest: {
          name: 'acme/notes',
          version: '1.2.3',
          entry: 'entry.js',
          dataDir: true,
          app: { entry: './app/index.html', title: '便签' },
          tools: [{ name: 'notes_open', description: 'd', parameters: { type: 'object' } }],
          activation: { lazy: true, resources: ['stdio'], exclusive: ['port:9310'] },
        },
      },
      PATHS,
    );
    expect(diag.pluginDir).toBe('C:/plugins/acme/notes');
    expect(diag.dataDir).toBe('C:/plugins-data/acme/notes');
    expect(diag.manifest).toEqual({ version: '1.2.3', entry: 'entry.js' });
    expect(diag.tools.declared).toEqual(['notes_open']);
    expect(diag.windows).toEqual({ declared: true, mode: 'floating', open: 1 });
    expect(diag.warnings).toEqual(['未知顶层字段：bogus']);
    expect(diag.activation).toMatchObject({
      declared: true,
      lazy: true,
      resources: ['stdio'],
      exclusive: ['port:9310'],
    });
    expect(diag.contractVersion).toBeGreaterThan(0);
  });

  it('未声明 dataDir ⇒ 不问数据目录（不侵入插件地盘）', async () => {
    const dataDir = vi.fn(async () => 'C:/should-not-be-asked');
    const diag = await collectPluginDiagnostics(
      { name: 'acme/plain', manifest: { name: 'acme/plain', version: '1.0.0', entry: 'entry.js' }, status: 'active' },
      { ...PATHS, dataDir },
    );
    expect(dataDir).not.toHaveBeenCalled();
    expect(diag.dataDir).toBeNull();
  });
});

// ── 受治进程一栏：接治理器真状态 ──

/** 最小 fake ProcIO：握手就绪 + 一个 echo 工具（同 mcp-bridge-governance 的形状）。 */
function makeFakeIO(): McpBridgeIO {
  return {
    createProcIO: async () => {
      const outCbs = new Set<(line: string) => void>();
      const proc: ProcIO = {
        writeLine: (line) => {
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (msg.id === undefined || msg.method === undefined) return;
          const reply = (result: unknown) => {
            for (const cb of outCbs) cb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
          };
          if (msg.method === 'initialize') {
            reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
          } else if (msg.method === 'tools/list') {
            reply({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] });
          } else {
            reply({ content: [{ type: 'text', text: 'ok' }] });
          }
        },
        onStdoutLine: (cb) => {
          outCbs.add(cb);
          return () => outCbs.delete(cb);
        },
        onExit: () => () => {},
        kill: () => {},
      };
      return proc;
    },
    pluginDir: async (name) => `C:/plugins/${name}`,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('插件医生：受治进程一栏（governorStatesFor）', () => {
  it('就绪时 state=ready + 工具数；空闲回收后 lastStopReason=idle-timeout 可见', async () => {
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    const fiber = await root.plugin({
      name: 'acme/notes',
      inject: ['tools'],
      async apply(ctx) {
        await registerMcpServerTools(
          ctx,
          'acme/notes',
          [{ name: 'engine', transport: 'stdio', command: './bin/engine', governed: true }],
          makeFakeIO(),
          { timing: { startupDeadlineMs: 2000, idleTimeoutMs: 60, restartBackoffMs: 40 } },
        );
      },
    });
    const record = {
      name: 'acme/notes',
      manifest: { name: 'acme/notes', version: '1.0.0', entry: 'entry.js' },
      status: 'active' as const,
    };
    // 装配期拉起受治进程（工具面就绪）
    const { pluginToolRows } = await import('../src/composition/plugin-tool-rows');
    const row = pluginToolRows().find((r) => r.id === 'plugin/acme/notes/mcp/engine');
    await row?.factory({} as never);
    const ready = await collectPluginDiagnostics(record, PATHS);
    expect(ready.tools.mcp).toEqual([{ server: 'engine', state: 'ready', toolCount: 1, lastStopReason: null }]);
    // 空闲回收（60ms）后：仍在注册表里（未卸载），但状态与停止原因可见
    let after = await collectPluginDiagnostics(record, PATHS);
    for (let i = 0; i < 100 && after.tools.mcp[0]?.state !== 'not-running'; i++) {
      await sleep(20);
      after = await collectPluginDiagnostics(record, PATHS);
    }
    expect(after.tools.mcp[0]).toMatchObject({
      server: 'engine',
      state: 'not-running',
      lastStopReason: 'idle-timeout',
    });
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });
});
