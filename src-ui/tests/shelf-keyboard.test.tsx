// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 架阁 · 键盘与焦点（2026-11-24 全量迭代）。
//
// 旧架阁的 ↑↓ 只改游标、不滚视野；没有焦点圈定、没有初始焦点、Esc 也不分层。
// 本文件钉四件事：
// ① 打开即聚焦搜索框，关闭把焦点还给打开者；
// ② ↑↓ 移动游标（同一时刻只有一行被标记）；
// ③ 焦点在搜索框时 ↵ = 行的主动作；
// ④ Esc 逐层：先清查询、再关浮层。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent/card-library', () => ({
  listCards: () => Promise.resolve({ cards: [], skipped: [] }),
  readCard: () => Promise.reject(new Error('no-card')),
  writeCardState: () => Promise.resolve({ bytes: 0 }),
  renameCard: () => Promise.resolve({ cardId: '', title: '' }),
  deleteCard: () => Promise.resolve({ cardId: '', trashed: null }),
}));

const { activeRootViews, rootViewsServicePlugin } = await import('../src/composition/root-views-service');
const { compositionServicesPlugin } = await import('../src/composition/services');
const { Context } = await import('../src/cordis');
const { shelfDomainPlugin } = await import('../src/plugins/builtin/shelf-domain');
const { useDockStore } = await import('../src/state/dock-store');
const { usePluginWindowStore } = await import('../src/state/plugin-window-store');
const { useShelfStore } = await import('../src/state/shelf-store');

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const key = (el: EventTarget, k: string): void => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
};

describe('架阁 · 键盘与焦点（v67）', () => {
  let container: HTMLDivElement | null = null;
  let opener: HTMLButtonElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = '打开架阁';
    document.body.appendChild(opener);
    root = createRoot(container);
    usePluginWindowStore.getState().resetPluginWindowsForTests();
    useShelfStore.getState().closeShelf();
    useDockStore.getState().closePanel('paper');
    useDockStore.getState().closePanel('settings');

    for (const [name, title] of [
      ['example/alpha', '甲软件'],
      ['example/beta', '乙软件'],
    ] as const) {
      usePluginWindowStore.getState().registerAppDef({
        pluginName: name,
        entryUrl: 'about:blank',
        kind: 'asset',
        mode: 'floating',
        title,
        documents: false,
      });
    }

    const ctx = new Context();
    await ctx.plugin(compositionServicesPlugin);
    await ctx.plugin(rootViewsServicePlugin);
    await ctx.plugin(shelfDomainPlugin);
    await act(async () => {
      root?.render(activeRootViews('overlay').map((v) => <v.component key={v.id} />));
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    opener?.remove();
    root = null;
    container = null;
    opener = null;
    useShelfStore.getState().closeShelf();
    usePluginWindowStore.getState().resetPluginWindowsForTests();
    useDockStore.getState().closePanel('paper');
    useDockStore.getState().closePanel('settings');
  });

  it('打开即聚焦搜索框；关闭把焦点还给打开者', async () => {
    opener!.focus();
    await act(async () => useShelfStore.getState().openShelf('app'));
    await flush();

    const input = container!.querySelector('.shf-search-input');
    expect(document.activeElement, '打开后焦点没进浮层').toBe(input);

    await act(async () => useShelfStore.getState().closeShelf());
    expect(document.activeElement, '关闭后焦点没归还').toBe(opener);
  });

  it('↑↓ 移动游标（同一时刻只有一行被标记）', async () => {
    await act(async () => useShelfStore.getState().openShelf('app'));
    await flush();
    const input = container!.querySelector('.shf-search-input') as HTMLInputElement;

    const marked = (): string =>
      [...container!.querySelectorAll<HTMLButtonElement>('.shf-row')].find(
        (r) => r.getAttribute('data-cursor') === 'on',
      )?.textContent ?? '';

    await act(async () => key(input, 'ArrowDown'));
    expect(marked(), '↓ 没选到第一行').toContain('甲软件');
    expect(container!.querySelectorAll('.shf-row[data-cursor="on"]').length, '同时标了两行').toBe(1);

    await act(async () => key(input, 'ArrowDown'));
    expect(marked(), '↓ 没移到第二行').toContain('乙软件');

    await act(async () => key(input, 'ArrowUp'));
    expect(marked(), '↑ 没回到第一行').toContain('甲软件');
  });

  it('焦点在搜索框时 ↵ = 行的主动作', async () => {
    await act(async () => useShelfStore.getState().openShelf('app'));
    await flush();
    const input = container!.querySelector('.shf-search-input') as HTMLInputElement;

    await act(async () => key(input, 'ArrowDown'));
    await act(async () => key(input, 'Enter'));
    await flush();

    expect(usePluginWindowStore.getState().windows.map((w) => w.pluginName)).toContain('example/alpha');
    expect(useShelfStore.getState().open, '按 ↵ 打开后没关架阁').toBe(false);
  });

  it('Esc 逐层：先清查询，再关浮层', async () => {
    await act(async () => useShelfStore.getState().openShelf('app'));
    await flush();
    const input = container!.querySelector('.shf-search-input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '甲');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('甲');

    await act(async () => key(document, 'Escape'));
    expect(useShelfStore.getState().open, '第一次 Esc 就把浮层关了').toBe(true);
    expect((container!.querySelector('.shf-search-input') as HTMLInputElement).value, 'Esc 没清查询').toBe('');

    await act(async () => key(document, 'Escape'));
    expect(useShelfStore.getState().open, '第二次 Esc 没关浮层').toBe(false);
  });
});
