// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-flip 批 4 测试 — bootShell 组合接线（V5a）：行表真源 = composition-store。
// mock 全部 boot 依赖（DOM/patch/preset/refs），只验行选择语义。

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

// 壳行 boot 依赖重——mock 两个探测行（真实行表不打）：经 composition 参数注入。

import type { ShellRow } from '../src/composition/shell-rows';
import { bootShell } from '../src/shell/boot';
import { useCompositionStore } from '../src/state/composition-store';

function probeRow(id: string, ran: string[]): ShellRow {
  return {
    id,
    boot: () => {
      ran.push(id);
    },
  };
}

describe('workspace-flip 批 4：bootShell 行表真源 = composition-store（V5a）', () => {
  it('composition 参数禁行 → boot 跳过该行（涟漪生效）', async () => {
    const ran: string[] = [];
    const rows = [probeRow('probe/a', ran), probeRow('probe/b', ran)];
    const disabled = {
      ...useCompositionStore.getState().resolved,
      shell: [rows[0]], // 模拟 roster 禁用 probe/b
    };
    await bootShell(undefined, disabled);
    expect(ran).toEqual(['probe/a']); // b 被禁——boot 未发生
  });

  it('无参数注入 → 读 composition-store（factory 态 = 出厂行表）', async () => {
    // factory 态 resolved.shell 就是 builtinShellRows()（roster factory 含壳行）
    const resolved = useCompositionStore.getState().resolved;
    expect(resolved.shell.length).toBeGreaterThan(0);
    expect(resolved.shell.some((r) => r.id === 'hologram/shell-platform')).toBe(true);
    // bootShell() 无参跑通 = 读 store 路径不炸（行 boot 本体是真实接线——
    // jsdom 下部分行依赖 DOM，失败隔离保证不炸引导）
    await expect(bootShell()).resolves.toBeUndefined();
  });
});
