// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 跨工作区串卷·根因二/三（2026-09-02 用户实机）：
//  H2（setupAgent 装配失败面）：switchWorkspace 对 setupAgent 的 catch 只
//  pushStatus 后继续走恢复链（setProjectPath → restoreCanvasSpread）。旧区
//  会话面清理 resetSessionState 原挂在 _setupAgentInner **尾部**——装配链任何
//  一步抛错即跳过 → sess store 残留旧区在内存卷 → restoreCanvasSpread 的
//  openIds 把撞号卷判「已在案头」直接渲染旧区内容到新工作区画布。
//  契约：resetSessionState 必须先于一切可抛错的装配步骤。
//  H3（deactivate 超时竞态面）：deactivate 被 withTimeout(5000) 放弃后仍在
//  后台跑；switchWorkspace 的 catch 调 forceClearState（推进代际）并继续开新
//  工作区。迟到的 saveCanvasState 会用「已被新工作区覆盖的画布 store」快照写
//  进旧工作区 canvas.json（跨工作区持久污染）；迟到的 workspace_deactivate
//  RPC 还会误关新工作区的后端态。
//  契约：deactivate 每步落盘前校验代际，过期即跳。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── settings mock 面（可翻面注入装配失败）──
const settingsState: { graphEngine?: { enabled: boolean }; secretsThrow?: boolean } = {};
vi.mock('../src/settings', () => ({
  loadSettings: () => ({ ...settingsState, display: { language: 'zh', fontScale: 1 }, agent: {} }),
  graphEngineEnabled: (s: { graphEngine?: { enabled: boolean } }) => s.graphEngine?.enabled !== false,
  loadSettingsWithSecrets: async () => {
    if (settingsState.secretsThrow) throw new Error('装配中途失败（注入）');
    return {
      ...settingsState,
      display: { language: 'zh', fontScale: 1 },
      agent: {},
      providers: [{ name: 'none', kind: 'openai', apiKey: '' }],
    };
  },
  getActiveProvider: (s: { providers?: Array<{ name: string; kind: string; apiKey?: string }> }) =>
    s?.providers?.[0] ?? { name: 'none', kind: 'openai', apiKey: '' },
  defaultPricing: () => ({}),
  modelContextWindow: () => 8192,
}));

// ── RPC mock 面：记录全部 typedRpc 调用（含参数）──
const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    rpcCalls.push({ method, params });
    return '{}';
  }),
  typedJsonRpc: vi.fn(async (method: string) => {
    rpcCalls.push({ method, params: {} });
    if (method === 'load_graph_json') {
      return { paged: true, meta: { source_root: 'D:/wsA', node_count: 10 } };
    }
    return {};
  }),
  typedListen: vi.fn(async () => () => {}),
  parseJson: (raw: unknown) => JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw ?? 'null')),
  // fs 域收口：workspace 装配链经 kernelGlobalMemoryDir（内部直呼 typedRpc
  //   fs_cap）——模块桩必须带上，否则装配期 "No kernelGlobalMemoryDir"
  //   假错顶替注入错误。
  kernelGlobalMemoryDir: async () => {
    rpcCalls.push({
      method: 'fs_cap',
      params: { action: 'global_memory_dir', is_agent: false },
    });
    return 'D:/mock/global-memory';
  },
  workspaceListCached: vi.fn(async () => {
    rpcCalls.push({ method: 'workspace_list', params: {} });
    return [];
  }),
  clearWorkspaceListCache: vi.fn(),
}));

vi.mock('../src/agent/logger', () => ({ initLogger: vi.fn() }));
vi.mock('../src/bridge', () => ({ isMockMode: () => false }));

import type { ChatCore } from '../src/app/chat/chat-core';
import { saveCanvasToDisk } from '../src/state/canvas-store';
import { getChatStore } from '../src/ui/chat-store';

/** 测试用面板（graph-engine-toggle 同款最小面 + deactivate 所需两保存方法）。 */
function makePanel(panelId: string, hangSaveActive?: Promise<void>): ChatCore {
  return {
    panelId,
    setProjectPath: vi.fn(),
    eventSink: { emit: vi.fn() },
    execState: { subscribe: vi.fn(() => () => {}) },
    saveActiveSession: async () => {
      if (hangSaveActive) await hangSaveActive;
    },
    saveCanvasState: async (p: string) => {
      await saveCanvasToDisk(panelId, p);
    },
  } as unknown as ChatCore;
}

// 超时预算 20s：测试内冷导入 ../src/workspace 巨型模块图（agent 装配链）。
// 逻辑面全 mock，亚秒完成；预算只吸收导入成本（graph-engine-toggle 同规）。
describe('跨工作区串卷：装配失败不得遗留旧区会话（H2）', () => {
  beforeEach(() => {
    settingsState.graphEngine = { enabled: false };
    settingsState.secretsThrow = false;
    rpcCalls.length = 0;
  });

  it('setupAgent 中途抛错 → 旧区会话面仍必须被清空', async () => {
    const { Workspace } = await import('../src/workspace');
    const panel = makePanel('xws-h2');
    const ws = await Workspace.open('D:/wsA', null, panel, {
      onStatusChange: () => {},
      onLoadingChange: () => {},
    });

    // 模拟上一工作区残留：sess store 里还有旧区的在内存卷（id 3）
    getChatStore('xws-h2').sess.setState({ sessions: [{ id: 3, label: '旧区卷' }], activeIdx: 0, nextSessionId: 4 });

    // 装配链中途失败（settings 解密抛错——_setupAgentInner 早期可抛点）
    settingsState.secretsThrow = true;
    try {
      // 断言：装配失败也必须先清空旧区会话面（今天 = 红：sessions 仍残留）
      await expect(ws.setupAgent(panel)).rejects.toThrow('装配中途失败（注入）');
      expect(getChatStore('xws-h2').sess.getState().sessions).toEqual([]);
    } finally {
      await ws.deactivate(panel); // 释放 fiber（防 LspService 注册泄漏到下用例——红态也要清）
    }
  }, 20_000);
});

describe('跨工作区串卷：deactivate 超时被抢清后不得串写旧工作区（H3）', () => {
  beforeEach(() => {
    settingsState.graphEngine = { enabled: false };
    settingsState.secretsThrow = false;
    rpcCalls.length = 0;
  });

  it('forceClearState 抢救（超时路径）→ 迟到的画布落盘不得写旧工作区 canvas.json', async () => {
    const { Workspace } = await import('../src/workspace');
    const panel = makePanel('xws-h3', new Promise<void>(() => {})); // saveActiveSession 永不落定（挂起）
    const ws = await Workspace.open('D:/wsA', null, panel, {
      onStatusChange: () => {},
      onLoadingChange: () => {},
    });

    // A 区画布：摊开卷 3
    const { getCanvasStore } = await import('../src/state/canvas-store');
    getCanvasStore('xws-h3').getState().setRegion('3', { anchorX: 0, anchorY: 0, width: 720 });

    // deactivate 挂起在第一步（saveActiveSession 不落定）——不 await
    let releaseSave!: () => void;
    const gate = new Promise<void>((r) => {
      releaseSave = r;
    });
    const hangingPanel = makePanel('xws-h3', gate);
    const pending = ws.deactivate(hangingPanel);

    // 超时路径：switchWorkspace 的 catch 调 forceClearState（推进代际）
    await ws.forceClearState();

    // 期间新工作区已恢复了自己的画布（摊开卷 9——B 区的）
    getCanvasStore('xws-h3').getState().setRegion('9', { anchorX: 800, anchorY: 0, width: 720 });

    // 迟到的 deactivate 恢复执行
    releaseSave();
    await pending;

    // 断言：旧工作区 canvas.json（含 pins/strips 分片）不得被新工作区数据串写
    const canvasWrites = rpcCalls.filter(
      (c) => c.method === 'write_file_content' && String(c.params.file_path ?? '').startsWith('D:/wsA/.lantai/canvas'),
    );
    expect(canvasWrites).toEqual([]);
  }, 20_000);
});
