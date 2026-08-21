// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-flip 批 5 测试 — 纸壳 preset + 主视图落点（V5b）。

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/shell-store', () => ({
  useShellStore: { getState: () => ({ setView: vi.fn() }) },
}));
vi.mock('../src/composition/patch-loader', () => ({
  loadCompositionPatch: vi.fn().mockResolvedValue(undefined),
  reloadCompositionPatch: vi.fn(),
}));
vi.mock('../src/composition/preset-assembly', () => ({
  applyDefaultPreset: vi.fn(),
  syncPresetSelectionFromSettings: vi.fn(),
}));
vi.mock('../src/composition/preset-discovery', () => ({
  discoverPresets: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/rpc-contract', () => ({
  typedListen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({ display: { language: 'zh', fontScale: 1 } })),
}));
vi.mock('../src/i18n', () => ({ setLang: vi.fn() }));
vi.mock('../src/shell/runtime', () => ({
  shellRefs: { starGraph: null },
}));

import { builtinPresetById, builtinPresets } from '../src/composition/presets';
import { bootShell } from '../src/shell/boot';
import { usePresetStore } from '../src/state/preset-store';

describe('workspace-flip 批 5：纸壳 preset（V5b）', () => {
  it('内置表含 paper 行（保守 patch：空壳域——只落视图不裁壳行）', () => {
    const paper = builtinPresetById('paper');
    expect(paper).toBeDefined();
    expect(paper?.builtin).toBe(true);
    expect(paper?.patch).toEqual({});
    expect(builtinPresets().map((p) => p.id)).toContain('paper');
  });

  it('preset 选择器往返：standard ↔ paper（设置面板选择器同款语义）', () => {
    usePresetStore.getState().select('paper');
    expect(usePresetStore.getState().selected).toBe('paper');
    usePresetStore.getState().select('standard');
    expect(usePresetStore.getState().selected).toBe('standard');
  });

  it('主视图落点：selected = paper → bootShell 后纸面板打开', async () => {
    const { useDockStore } = await import('../src/state/dock-store');
    usePresetStore.getState().select('paper');
    await bootShell();
    expect(useDockStore.getState().open.paper).toBe(true);
    // 收尾（不污染其他测试）
    useDockStore.getState().closePanel('paper');
    usePresetStore.getState().select('standard');
  });
});
