// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 快捷键总览（2026-11-28）——「案」抽屉退役后律册的新家。
//
// 行为面钉三条（用户序列）：
//   ① 触发：壳行动作 `shortcuts`（= 全局搜索里能搜到的「快捷键总览」）把浮层叫出来；
//   ② 内容：分组在册（全局 / 输入 / 附卷 / 画布 / 纸面），键位与释义都读同一张表
//      （`app/help/shortcut-groups.ts`——单一真源，改键位只改那一处）；
//   ③ 退出：Esc 关、关闭钮关（两扇门都要通，帮助页最容易只剩其中一扇）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listActions } from '../src/app/actions';
import { HelpSheet } from '../src/app/HelpSheet';
import { useShellStore } from '../src/app/shell-store';
import { bootActions } from '../src/shell/rows/actions';
import type { ShellRefs } from '../src/shell/runtime';

describe('快捷键总览（律册新家）', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(async () => {
    useShellStore.setState({ helpOpen: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(HelpSheet));
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useShellStore.setState({ helpOpen: false });
  });

  it('壳行动作「快捷键总览」在册，且叫得出来浮层（全局搜索也搜得到它）', async () => {
    bootActions({} as ShellRefs, {
      switchWorkspace: async () => {},
      escLayer: () => {},
    });
    const action = listActions().find((a) => a.id === 'shortcuts');
    expect(action, '快捷键总览应是壳层级动作（应用级帮助，不属于某一卷）').toBeDefined();
    expect(action?.label).toBe('快捷键总览');

    expect(container?.querySelector('.help-box'), '默认不渲染').toBeNull();
    await act(async () => {
      action?.run();
    });
    expect(container?.querySelector('.help-box')).not.toBeNull();
  });

  it('分组与键位在册：全局 / 输入 / 附卷 / 画布 / 纸面', async () => {
    await act(async () => {
      useShellStore.getState().setHelpOpen(true);
    });
    const titles = [...(container as HTMLElement).querySelectorAll('.help-group-title')].map((el) => el.textContent);
    expect(titles).toEqual(['全局', '输入', '附卷', '画布', '纸面']);
    const text = container?.textContent ?? '';
    expect(text).toContain('Ctrl+K'); // 全局搜索
    expect(text).toContain('发送'); // Enter
    expect(text).toContain('附文件入卷'); // 引 · 夹
    expect(text).toContain('卷间移动'); // Alt+←→
    expect(text).toContain('抽纸条'); // 拖选区
  });

  it('Esc 关、关闭钮关——两扇门都通', async () => {
    await act(async () => {
      useShellStore.getState().setHelpOpen(true);
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useShellStore.getState().helpOpen).toBe(false);
    expect(container?.querySelector('.help-box')).toBeNull();

    await act(async () => {
      useShellStore.getState().setHelpOpen(true);
    });
    const close = container?.querySelector('.help-close') as HTMLButtonElement | null;
    expect(close).not.toBeNull();
    await act(async () => {
      close?.click();
    });
    expect(useShellStore.getState().helpOpen).toBe(false);
  });
});
