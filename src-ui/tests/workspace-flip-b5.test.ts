// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// workspace-flip 批 5 测试 — 主视图落点。
// V5 拆除（2026-08-22，用户深夜拍板「摘除旧观测台前端」）：paper preset
// 行退役——纸壳是唯一主界面，bootShell 收尾无条件开纸面板（原「selected
// = paper 才直落」的共居期分叉作废）。本文件改钉新语义。

import { describe, expect, it, vi } from 'vitest';

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
  shellRefs: { starGraph: null, chatPanel: null, workspace: null, wsMachine: {} },
}));

import { builtinPresetById } from '../src/composition/presets';
import { bootShell } from '../src/shell/boot';
import { usePresetStore } from '../src/state/preset-store';

describe('V5 拆除：主视图落点（纸壳唯一主界面）', () => {
  it('paper preset 行已退役（内置表只剩 standard/minimal）', () => {
    expect(builtinPresetById('paper')).toBeUndefined();
  });

  it('主视图落点不再看 preset：selected = standard → bootShell 后纸面板仍打开', async () => {
    const { useDockStore } = await import('../src/state/dock-store');
    usePresetStore.getState().select('standard');
    await bootShell();
    expect(useDockStore.getState().open.paper).toBe(true);
    // 收尾（不污染其他测试）
    useDockStore.getState().closePanel('paper');
  });
});
