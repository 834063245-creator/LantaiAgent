// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 架阁 · 器物页（2026-11-24 全量迭代）：名册三段 + 状态方点 + 开/关/聚焦。
//
// 判据（用户视角）：
// ① 在窗（开着的窗口）排在最前、状态点亮；软件（未开）与面板各成一段——三种「装进来的
//    东西」不再挤在同一种行里只靠右端小字区分；
// ② 关窗不出架阁（查着清单的人不该被踢出去）；开窗/开面板照旧关浮层（门开了就走）；
// ③ 面板口径不变：side:null 不上轨道、frame:'self' 是家具，都不进来。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 卡片库 RPC 桩：器物页不读卡，但浮层打开时会 card_list（真 RPC 在单测里没有后端）。
vi.mock('../src/agent/card-library', () => ({
  listCards: () => Promise.resolve({ cards: [], skipped: [] }),
  readCard: () => Promise.reject(new Error('no-card')),
  writeCardState: () => Promise.resolve({ bytes: 0 }),
  renameCard: () => Promise.resolve({ cardId: '', title: '' }),
  deleteCard: () => Promise.resolve({ cardId: '', trashed: null }),
}));

import { activeRootViews, rootViewsServicePlugin } from '../src/composition/root-views-service';
import { compositionServicesPlugin, type PanelContribution } from '../src/composition/services';
import { Context } from '../src/cordis';
import { shelfDomainPlugin } from '../src/plugins/builtin/shelf-domain';
import { useDockStore } from '../src/state/dock-store';
import { usePluginWindowStore } from '../src/state/plugin-window-store';
import { useShelfStore } from '../src/state/shelf-store';

function Bare() {
  return <div className="t-bare">内容</div>;
}

const PANELS: PanelContribution[] = [
  { id: 't-desk', side: 'right', title: '研报工作台', icon: 'agent', component: Bare },
  { id: 't-fullscreen', side: null, title: '全屏面', icon: 'settings', component: Bare },
  { id: 't-furniture', side: 'left', title: '家具面', icon: 'book', frame: 'self', component: Bare },
];

function registerApp(pluginName: string, title: string): void {
  usePluginWindowStore.getState().registerAppDef({
    pluginName,
    entryUrl: 'about:blank',
    kind: 'asset',
    mode: 'floating',
    title,
    documents: false,
  });
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const openShelf = async (page: 'app' | 'card'): Promise<void> => {
  await act(async () => useShelfStore.getState().openShelf(page));
  await flush();
};

const appRows = (c: HTMLElement): HTMLButtonElement[] => [...c.querySelectorAll<HTMLButtonElement>('.shf-row')];

const actButton = (c: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...c.querySelectorAll<HTMLButtonElement>('.shf-act')].find((b) => (b.textContent ?? '').trim() === label);

describe('架阁 · 器物页（v67）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    usePluginWindowStore.getState().resetPluginWindowsForTests();
    useShelfStore.getState().closeShelf();
    useDockStore.getState().closePanel('settings');
    useDockStore.getState().closePanel('paper');
    for (const p of PANELS) useDockStore.getState().closePanel(p.id);

    const ctx = new Context();
    await ctx.plugin(compositionServicesPlugin);
    await ctx.plugin(rootViewsServicePlugin);
    for (const p of PANELS) ctx.panels.register(p);
    await ctx.plugin(shelfDomainPlugin);
    await act(async () => {
      root?.render(activeRootViews('overlay').map((v) => <v.component key={v.id} />));
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useShelfStore.getState().closeShelf();
    usePluginWindowStore.getState().resetPluginWindowsForTests();
    useDockStore.getState().closePanel('settings');
    useDockStore.getState().closePanel('paper');
    for (const p of PANELS) useDockStore.getState().closePanel(p.id);
  });

  it('三段各就各位：在窗 / 软件 / 面板，且家具与全屏面不进册', async () => {
    registerApp('hologram/notes', '便签');
    registerApp('example/weather', '天气');
    act(() => {
      usePluginWindowStore.getState().openWindow('hologram/notes');
    });
    await openShelf('app');

    const text = container!.textContent ?? '';
    expect(text, '缺「在窗」段').toContain('在窗');
    expect(text, '缺「软件」段').toContain('软件');
    expect(text, '缺「面板」段').toContain('面板');
    expect(text, '开着的窗没进在窗段').toContain('便签');
    expect(text, '未开的软件没进软件段').toContain('天气');
    expect(text, '面板没进面板段').toContain('研报工作台');
    expect(text, 'side:null 的面板混进来了').not.toContain('全屏面');
    expect(text, '家具（frame:self）混进来了').not.toContain('家具面');

    // 状态方点：开着的窗口行 = 朱砂实心；未开的软件行 = 空心。
    const rows = appRows(container!);
    const noteRow = rows.find((r) => (r.textContent ?? '').includes('便签'));
    const weatherRow = rows.find((r) => (r.textContent ?? '').includes('天气'));
    expect(noteRow?.querySelector('.shf-dot')?.getAttribute('data-on'), '开着的窗口没点亮').toBe('on');
    expect(weatherRow?.querySelector('.shf-dot')?.getAttribute('data-on'), '未开的软件不该点亮').toBeNull();
  });

  it('关窗留在架阁里（查清单时不该被踢出去），窗口行消失', async () => {
    registerApp('hologram/notes', '便签');
    act(() => {
      usePluginWindowStore.getState().openWindow('hologram/notes');
    });
    await openShelf('app');

    const closeBtn = actButton(container!, '关');
    expect(closeBtn, '在窗行没有「关」').toBeDefined();
    await act(async () => closeBtn?.click());

    expect(usePluginWindowStore.getState().windows.length, '窗没关掉').toBe(0);
    expect(useShelfStore.getState().open, '关窗把架阁一起关了').toBe(true);
    expect(container!.textContent ?? '', '关掉的窗口还挂在在窗段').not.toContain('在窗');
  });

  it('开软件 = 开窗 + 关架阁（门开了就走）', async () => {
    registerApp('example/weather', '天气');
    await openShelf('app');

    const row = appRows(container!).find((r) => (r.textContent ?? '').includes('天气'));
    expect(row, '软件行没渲染').toBeDefined();
    await act(async () => row?.click());

    expect(usePluginWindowStore.getState().windows.map((w) => w.pluginName)).toContain('example/weather');
    expect(useShelfStore.getState().open, '开完窗没关架阁').toBe(false);
  });

  it('开面板 = dock 开 + 关架阁', async () => {
    await openShelf('app');
    const row = appRows(container!).find((r) => (r.textContent ?? '').includes('研报工作台'));
    expect(row, '面板行没渲染').toBeDefined();
    await act(async () => row?.click());

    expect(useDockStore.getState().open['t-desk']).toBe(true);
    expect(useShelfStore.getState().open).toBe(false);
  });

  it('页签口径 = 器物 / 卡片，且计数是本页总量', async () => {
    registerApp('example/weather', '天气');
    await openShelf('app');
    const tabs = [...container!.querySelectorAll('.shf-tab')].map((t) => (t.textContent ?? '').trim());
    expect(
      tabs.some((t) => t.startsWith('器物')),
      '页签没改口径',
    ).toBe(true);
    expect(
      tabs.some((t) => t.startsWith('卡片')),
      '页签没改口径',
    ).toBe(true);
    // 器物 1（天气）+ 面板 1（研报工作台）= 2。
    expect(
      tabs.find((t) => t.startsWith('器物')),
      '器物计数不对',
    ).toContain('2');
  });

  it('搜索过滤行，并在另一页有命中时给出口', async () => {
    registerApp('example/weather', '天气');
    await openShelf('app');
    const input = container!.querySelector('.shf-search-input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '天气');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container!.textContent ?? '').toContain('天气');
    expect(container!.textContent ?? '', '不匹配的行没被滤掉').not.toContain('研报工作台');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '不存在的词');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container!.textContent ?? '', '空结果没给一句实话').toContain('器物页没有匹配');
  });
});
