// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Esc 逐层关闭：壳面板在 settings 之后被关（v66，2026-11-21）。
//
// issue `lantai-plugin-panels-no-home` 的验收标准第三条「打开后：可见、可关、Esc 可关」，
// 前两条由 tests/dock-slot.test.tsx 钉，「Esc 可关」由本文件钉。
//
// 判据走真实链路：useGlobalKeys → runAction('esc-layer') → workspace.escLayer()。
// 直接调 escLayer 会绕过键位层（那是另一件事），故这里发真实 keydown。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { compositionServicesPlugin, type PanelContribution } from '../src/composition/services';
import { Context } from '../src/cordis';
import { bootActions } from '../src/shell/rows/actions';
import { workspaceFlow } from '../src/shell/rows/workspace';
import { useDockStore } from '../src/state/dock-store';

function Bare() {
  return <div className="t-bare">内容</div>;
}

const PANEL: PanelContribution = { id: 't-esc', side: 'right', title: '试试 Esc', icon: 'agent', component: Bare };

describe('Esc 逐层关闭（v66 壳面板）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const ctx = new Context();
    await ctx.plugin(compositionServicesPlugin);
    ctx.panels.register(PANEL);
    useDockStore.getState().closePanel('t-esc');
    // esc-layer 动作在壳行注册（boot 期），此处只接 flowDeps 的那一件。
    bootActions({} as never, {
      switchWorkspace: async () => {},
      escLayer: workspaceFlow.escLayer,
    });
    await act(async () => {
      root?.render(<App />);
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useDockStore.getState().closePanel('t-esc');
  });

  it('Esc 关掉开着的壳面板', async () => {
    await act(async () => useDockStore.getState().openPanel('t-esc'));
    expect(useDockStore.getState().open['t-esc']).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useDockStore.getState().open['t-esc']).toBe(false);
  });

  it('面板关着时 Esc 是 no-op（不误开、不误关别的）', async () => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useDockStore.getState().open['t-esc']).toBeFalsy();
  });
});
