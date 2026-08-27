// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 图谱引擎开关（2026-08-22）——「绑目录 ≠ 开图谱」的守护测试。
// 覆盖三个面：
//   1. settings：graphEngineEnabled 缺省容错（旧存储无节 = 开）+ 节读写往返；
//   2. Workspace 门禁：关态 open() 不触 analyze_and_load/load_graph_page/
//      hologram_run_check/workspace_start_watcher（防强分析回退击穿开关），
//      graphData 留 null；
//   3. merge-gate：注入真值语义（2026-08-24 真值源改注入）——graphEngineOn
//      未声明即跳过（不轮询 run_check）；注入 true 时与实时 settings 解耦照跑。
//   4. cold-start：关态走 get_last_project 信号（不碰 load_graph_json）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── settings mock 面（各用例按需覆写 DEFAULTS）──
const settingsState: { graphEngine?: { enabled: boolean } } = {};
vi.mock('../src/settings', () => ({
  loadSettings: () => ({ ...settingsState, display: { language: 'zh', fontScale: 1 }, agent: {} }),
  graphEngineEnabled: (s: { graphEngine?: { enabled: boolean } }) => s.graphEngine?.enabled !== false,
}));

// ── RPC mock 面：记录全部调用 ──
const rpcCalls: string[] = [];
vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(async (method: string) => {
    rpcCalls.push(method);
    return '{}';
  }),
  typedJsonRpc: vi.fn(async (method: string) => {
    rpcCalls.push(method);
    if (method === 'get_last_project') return 'D:/proj/demo';
    if (method === 'load_graph_json') {
      return { paged: true, meta: { source_root: 'D:/proj/demo', node_count: 10 } };
    }
    return {};
  }),
  typedListen: vi.fn(async () => () => {}),
  parseJson: (raw: unknown) => JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)),
}));

vi.mock('../src/agent/logger', () => ({ initLogger: vi.fn() }));
vi.mock('../src/bridge', () => ({ isMockMode: () => false }));

import { graphEngineEnabled, loadSettings } from '../src/settings';

describe('图谱引擎开关：settings 容错面', () => {
  it('旧存储无 graphEngine 节 = 开（零漂移缺省）', () => {
    settingsState.graphEngine = undefined;
    expect(graphEngineEnabled(loadSettings())).toBe(true);
  });

  it('enabled:false 读出关；显式 true 读出开', () => {
    settingsState.graphEngine = { enabled: false };
    expect(graphEngineEnabled(loadSettings())).toBe(false);
    settingsState.graphEngine = { enabled: true };
    expect(graphEngineEnabled(loadSettings())).toBe(true);
  });
});

describe('图谱引擎开关：Workspace.open 门禁', () => {
  // 超时预算 20s：测试内冷导入 ../src/workspace 巨型模块图（agent 装配链）
  // ——全量套件下 worker 冷启动时导入本身可超 5s（2026-08-24 实测击穿，
  // 超时泄漏 fiber → 下用例 lsp 服务双注册连锁假红）。逻辑面全 mock，
  // 亚秒完成；预算只吸收导入成本。
  it('关态：不触分析/拉页/简报/watcher，graphData 留 null', async () => {
    rpcCalls.length = 0;
    settingsState.graphEngine = { enabled: false };
    const { Workspace } = await import('../src/workspace');
    const chatPanel = {
      panelId: 'test-panel',
      setProjectPath: vi.fn(),
      eventSink: { emit: vi.fn() },
      execState: { subscribe: vi.fn(() => () => {}) },
    } as unknown as never;
    const ws = await Workspace.open('D:/proj/demo', null, chatPanel, undefined, {
      onStatusChange: () => {},
      onLoadingChange: () => {},
    });
    expect(ws._graphEngineOn).toBe(false);
    expect(ws.graphData).toBeNull();
    // 引擎入口全部缺席（workspace_activate 是权限绑定，允许出现）
    expect(rpcCalls).toContain('workspace_activate');
    expect(rpcCalls).not.toContain('analyze_and_load');
    expect(rpcCalls).not.toContain('get_graph_page');
    expect(rpcCalls).not.toContain('hologram_run_check');
    expect(rpcCalls).not.toContain('workspace_start_watcher');
    expect(rpcCalls).not.toContain('read_file_content');
    await ws.deactivate(chatPanel); // 释放 fiber（LspService 注册不泄漏到下一个用例）
  }, 20_000);

  it('开态（缺省）：照旧触发分析链（零漂移）', async () => {
    rpcCalls.length = 0;
    settingsState.graphEngine = undefined;
    const { Workspace } = await import('../src/workspace');
    const chatPanel = {
      panelId: 'test-panel',
      setProjectPath: vi.fn(),
      eventSink: { emit: vi.fn() },
      execState: { subscribe: vi.fn(() => () => {}) },
    } as unknown as never;
    const ws = await Workspace.open('D:/proj/demo', null, chatPanel, undefined, {
      onStatusChange: () => {},
      onLoadingChange: () => {},
    });
    expect(ws._graphEngineOn).toBe(true);
    expect(rpcCalls).toContain('analyze_and_load');
    await ws.deactivate(chatPanel);
  }, 20_000);
});

describe('图谱引擎开关：merge-gate 注入真值', () => {
  it('未注入 graphEngineOn：跳过图检查门禁，不轮询 hologram_run_check（settings 开态也拦不住——真值只在注入）', async () => {
    rpcCalls.length = 0;
    settingsState.graphEngine = { enabled: true };
    const { runGraphGate } = await import('../src/agent/tools/merge-gate');
    const entry = { agentId: 'sub-1' } as never;
    const exec = vi.fn(async () => '{}');
    const r = await runGraphGate(entry, { projectPath: 'D:/proj/demo', exec });
    expect(r.passed).toBe(true);
    expect(r.quiet).toBe(true);
    expect(r.report).toContain('跳过图检查门禁');
    expect(exec).not.toHaveBeenCalled();
  });

  it('注入真值与实时 settings 解耦：settings 关态但 graphEngineOn: true → 照跑轮询', async () => {
    rpcCalls.length = 0;
    settingsState.graphEngine = { enabled: false };
    const { runGraphGate } = await import('../src/agent/tools/merge-gate');
    const entry = { agentId: 'sub-1' } as never;
    const exec = vi.fn(async () => '{"quiet":true}');
    const r = await runGraphGate(entry, {
      projectPath: 'D:/proj/demo',
      exec,
      graphEngineOn: true,
      maxCheckWaitMs: 80,
      pollIntervalMs: 20,
    });
    // 真值来自注入：settings 关态不再拦得住轮询（旧实现在此直接跳过）
    expect(exec.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(exec.mock.calls[0]?.[0]).toBe('hologram_run_check');
    expect(r.quiet).toBe(true);
  });
});

describe('图谱引擎开关：冷启动信号', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
  });

  it('关态：走 get_last_project（不碰 load_graph_json），恢复工作区', async () => {
    settingsState.graphEngine = { enabled: false };
    vi.doMock('../src/shell/rows/workspace', () => ({
      workspaceFlow: { switchWorkspace: vi.fn(async () => {}) },
    }));
    const { bootColdStart } = await import('../src/shell/rows/cold-start');
    await bootColdStart({} as never);
    expect(rpcCalls).toContain('get_last_project');
    expect(rpcCalls).not.toContain('load_graph_json');
  });
});
