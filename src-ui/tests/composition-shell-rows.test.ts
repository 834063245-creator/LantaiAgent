// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S2-3/S2-4 壳行表 + bootShell 编排器专门测试（S4 文档收尾审计的补欠账：
// 竣工时只有行实现各自的功能测试，表序/失败隔离/编排语义从未有专门钉面）。
//
// 覆盖（S2 设计件 §2.6 验收）：
//   1. 表序 = 引导序（12 行硬序——字节契约）；
//   2. 行 id 唯一（roster shell 域寻址面）；
//   3. workspace 流 deps：actions 行的涟漪语义（deps 缺席 → 跳过注册，warn 可见）；
//   4. bootShell 失败隔离：单行 boot 抛错 → 后续行照常执行；
//   5. bootShell 组合链顺序（S4-1a 后）：patch 装载 → preset 发现 → preset 应用
//      的调用序——顺序错了会导致「preset 应用在发现前跑」（空 roster）；
//   6. shell 域禁用涟漪：resolved.shell 少一行 → bootShell 只执行存活行。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinShellRows, type ShellRow, type WorkspaceFlowDeps } from '../src/composition/shell-rows';

const EXPECTED_ROW_IDS = [
  'hologram/shell-platform',
  'hologram/shell-graph',
  'hologram/shell-chat',
  'hologram/shell-bridges',
  'hologram/shell-keyguard',
  'hologram/shell-sandbox-probe',
  'hologram/shell-dataflow-parser',
  'hologram/shell-nav',
  'hologram/shell-persistence',
  'hologram/shell-actions',
  'hologram/shell-workspace',
  'hologram/shell-cold-start',
];

/** 无副作用的 flow deps 桩（boot 调用签名兼容即可）。 */
function stubFlowDeps(): WorkspaceFlowDeps {
  return {
    switchWorkspace: async () => {},
    reanalyze: async () => {},
    toggleDiff: async () => {},
    doSearch: () => {},
    escLayer: () => {},
    runCheck: async () => {},
  };
}

describe('S2-3/S2-4 壳行表（composition/shell-rows.ts）', () => {
  it('表序 = 引导序（12 行硬序——字节契约，错位即返工）', () => {
    expect(builtinShellRows().map((r) => r.id)).toEqual(EXPECTED_ROW_IDS);
  });

  it('行 id 全局唯一（roster shell 域寻址面）', () => {
    const ids = builtinShellRows().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每行有 boot 函数（行接口完备——哑行也显式空实现）', () => {
    for (const row of builtinShellRows()) {
      expect(typeof row.boot).toBe('function');
    }
  });
});

describe('S2-3/S2-4 bootShell 编排器（shell/boot.ts）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('失败隔离：单行 boot 抛错 → 后续行照常执行（设计件 §2.6 铁律）', async () => {
    const calls: string[] = [];
    // 重组模块图：mock 掉引导三件套依赖（i18n/settings/runtime 无 DOM 依赖面）
    vi.doMock('../src/i18n', () => ({ setLang: () => {} }));
    vi.doMock('../src/settings', () => ({
      loadSettings: () => ({ display: { language: 'zh', fontScale: 1.2 }, providers: [], agent: {} }),
      loadSettingsWithSecrets: async () => ({}),
    }));
    vi.doMock('../src/shell/runtime', () => ({
      shellRefs: { starGraph: null, chatPanel: null, workspace: null, agentViz: null, wsMachine: {} },
      pushStatus: () => {},
      setLoading: () => {},
    }));
    vi.doMock('../src/composition/patch-loader', () => ({
      loadCompositionPatch: vi.fn(async () => {}),
      reloadCompositionPatch: vi.fn(async () => {}),
    }));
    vi.doMock('../src/composition/preset-discovery', () => ({ discoverPresets: vi.fn(async () => {}) }));
    vi.doMock('../src/composition/preset-assembly', () => ({
      syncPresetSelectionFromSettings: vi.fn(),
      applyDefaultPreset: vi.fn(),
    }));
    // 12 行全换探针（第 3 行抛错——验证第 4+ 行仍执行）
    const rows: ShellRow[] = EXPECTED_ROW_IDS.map((id, i) => ({
      id,
      boot: () => {
        calls.push(id);
        if (i === 2) throw new Error('行 3 故障注入');
      },
    }));
    const probeRows = vi.fn(() => rows);
    vi.doMock('../src/composition/shell-rows', () => ({
      builtinShellRows: probeRows,
      workspaceFlow: stubFlowDeps(),
    }));
    vi.doMock('../src/rpc-contract', () => ({ typedListen: vi.fn(async () => () => {}) }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bootShell } = await import('../src/shell/boot');
    await bootShell(stubFlowDeps());
    // 12 行全部被调用（含抛错的第 3 行）
    expect(calls).toEqual(EXPECTED_ROW_IDS);
    expect(errSpy).toHaveBeenCalledWith('[shell] 壳行 boot 失败:', 'hologram/shell-chat', expect.any(Error));
    errSpy.mockRestore();
  });

  it('组合链顺序（S4-1a）：preset 选择同步 → patch 装载 → preset 发现 → preset 应用', async () => {
    const order: string[] = [];
    vi.doMock('../src/i18n', () => ({ setLang: () => {} }));
    vi.doMock('../src/settings', () => ({
      loadSettings: () => ({ display: { language: 'zh', fontScale: 1.2 }, providers: [], agent: {} }),
      loadSettingsWithSecrets: async () => ({}),
    }));
    vi.doMock('../src/shell/runtime', () => ({
      shellRefs: { starGraph: null, chatPanel: null, workspace: null, agentViz: null, wsMachine: {} },
      pushStatus: () => {},
      setLoading: () => {},
    }));
    vi.doMock('../src/composition/patch-loader', () => ({
      loadCompositionPatch: vi.fn(async () => {
        order.push('patch-load');
      }),
      reloadCompositionPatch: vi.fn(async () => {}),
    }));
    vi.doMock('../src/composition/preset-discovery', () => ({
      discoverPresets: vi.fn(async () => {
        order.push('preset-discover');
      }),
    }));
    vi.doMock('../src/composition/preset-assembly', () => ({
      syncPresetSelectionFromSettings: vi.fn(() => {
        order.push('preset-sync');
      }),
      applyDefaultPreset: vi.fn(() => {
        order.push('preset-apply');
      }),
    }));
    vi.doMock('../src/composition/shell-rows', () => ({
      builtinShellRows: () => [],
      workspaceFlow: stubFlowDeps(),
    }));
    vi.doMock('../src/rpc-contract', () => ({ typedListen: vi.fn(async () => () => {}) }));
    const { bootShell } = await import('../src/shell/boot');
    await bootShell(stubFlowDeps());
    // 顺序错会导致 preset 应用在发现前跑（空 roster）或装载晚于选择同步
    expect(order).toEqual(['preset-sync', 'patch-load', 'preset-discover', 'preset-apply']);
  });

  it('shell 域禁用涟漪：resolved.shell 少一行 → bootShell 只执行存活行', async () => {
    const executed: string[] = [];
    vi.doMock('../src/i18n', () => ({ setLang: () => {} }));
    vi.doMock('../src/settings', () => ({
      loadSettings: () => ({ display: { language: 'zh', fontScale: 1.2 }, providers: [], agent: {} }),
      loadSettingsWithSecrets: async () => ({}),
    }));
    vi.doMock('../src/shell/runtime', () => ({
      shellRefs: { starGraph: null, chatPanel: null, workspace: null, agentViz: null, wsMachine: {} },
      pushStatus: () => {},
      setLoading: () => {},
    }));
    vi.doMock('../src/composition/patch-loader', () => ({
      loadCompositionPatch: vi.fn(async () => {}),
      reloadCompositionPatch: vi.fn(async () => {}),
    }));
    vi.doMock('../src/composition/preset-discovery', () => ({ discoverPresets: vi.fn(async () => {}) }));
    vi.doMock('../src/composition/preset-assembly', () => ({
      syncPresetSelectionFromSettings: vi.fn(),
      applyDefaultPreset: vi.fn(),
    }));
    vi.doMock('../src/composition/shell-rows', () => ({
      builtinShellRows: () => [],
      workspaceFlow: stubFlowDeps(),
    }));
    vi.doMock('../src/rpc-contract', () => ({ typedListen: vi.fn(async () => () => {}) }));
    const { bootShell } = await import('../src/shell/boot');
    // 直接传组合后的壳行（禁用 keyguard + sandbox-probe——禁用 = 接线不发生）
    const rows: ShellRow[] = EXPECTED_ROW_IDS.filter(
      (id) => id !== 'hologram/shell-keyguard' && id !== 'hologram/shell-sandbox-probe',
    ).map((id) => ({ id, boot: () => executed.push(id) }));
    await bootShell(stubFlowDeps(), {
      tools: [],
      prompt: [],
      capabilities: [],
      shell: rows,
      diagnostics: { disabled: [], overridden: [], inserted: [] },
    });
    expect(executed).not.toContain('hologram/shell-keyguard');
    expect(executed).not.toContain('hologram/shell-sandbox-probe');
    expect(executed).toHaveLength(10);
  });

  it('actions 行涟漪：workspace 流 deps 缺席 → 跳过注册 + warn（不炸）', () => {
    const rows = builtinShellRows();
    const actionsRow = rows.find((r) => r.id === 'hologram/shell-actions');
    expect(actionsRow).toBeDefined();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // deps 缺席（shell 域禁用 workspace 行的涟漪形态）
    expect(() => actionsRow?.boot({} as never, undefined)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith('[shell] workspace 流 deps 缺席，跳过动作注册');
    warnSpy.mockRestore();
  });
});
