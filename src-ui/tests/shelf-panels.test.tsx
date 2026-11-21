// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 架阁收编面板 + 搜索（架阁升格批，2026-11-21）。
//
// 判据：`ctx.panels` 的贡献要能从架阁「软件型」页看到并点开——这是 issue
// `lantai-plugin-panels-no-home` 的**入口面**（盒子面由 tests/dock-slot.test.tsx 钉）。
// 只收 side !== null 的：纸 / 设置这类「不上轨道」的面板不是软件，各有自己的开关。
//
// 架阁已升格为应用级浮层（ctx.rootViews 的 'overlay' 槽）——本测试按 App.tsx 的
// 同一条路取活动贡献并渲染（**测的是真实装载路，不是把组件硬 import 进来**）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeRootViews, rootViewsServicePlugin } from '../src/composition/root-views-service';
import { compositionServicesPlugin, type PanelContribution } from '../src/composition/services';
import { Context } from '../src/cordis';
import { shelfDomainPlugin } from '../src/plugins/builtin/shelf-domain';
import { useDockStore } from '../src/state/dock-store';
import { useShelfStore } from '../src/state/shelf-store';

function Bare() {
  return <div className="t-bare">内容</div>;
}

const PANELS: PanelContribution[] = [
  { id: 't-desk', side: 'right', title: '研报工作台', icon: 'agent', component: Bare },
  { id: 't-fullscreen', side: null, title: '全屏面', icon: 'settings', component: Bare },
  // 家具型（书脊 / 案卷同款）：有 side，但 frame:'self' —— 2026-11-21 实机报
  // 「软件里怎么还有书脊和案卷」，这条钉住它不再混进来。
  { id: 't-furniture', side: 'left', title: '家具面', icon: 'book', frame: 'self', component: Bare },
];

describe('架阁：panels 通道的入口（v66）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const ctx = new Context();
    // 表序同 loadBuiltinPlugins：四 service → rootViews → 产物。
    await ctx.plugin(compositionServicesPlugin);
    await ctx.plugin(rootViewsServicePlugin);
    for (const p of PANELS) ctx.panels.register(p);
    await ctx.plugin(shelfDomainPlugin);
    useShelfStore.getState().closeShelf();
    await act(async () => {
      // 与 App.tsx 同一条渲染路：按槽取活动贡献行。
      root?.render(activeRootViews('overlay').map((v) => <v.component key={v.id} />));
    });
    await act(async () => useShelfStore.getState().openShelf('app'));
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useShelfStore.getState().closeShelf();
    for (const p of PANELS) useDockStore.getState().closePanel(p.id);
  });

  it('side 非 null 的面板出现在软件页', () => {
    expect(container!.textContent ?? '', '面板没进架阁——issue 的入口面没解决').toContain('研报工作台');
  });

  it('side:null 的面板不进架阁（它不是「软件」）', () => {
    expect(container!.textContent ?? '').not.toContain('全屏面');
  });

  it('家具（frame: self）不进架阁——书脊 / 案卷不是软件', () => {
    // 为什么这条重要：家具的生命周期挂在纸上（canvas-nav 的 syncPanels：纸关 = 全关），
    // 列进架阁就能在**首页**（没有工作区）把它点开，出来一条空侧栏——是状态 bug 不是观感。
    expect(container!.textContent ?? '').not.toContain('家具面');
  });

  it('点面板行 = togglePanel + 关架阁', async () => {
    const rows = [...container!.querySelectorAll('.pp-shelf-item')] as HTMLButtonElement[];
    const row = rows.find((b) => (b.textContent ?? '').includes('研报工作台'));
    expect(row, '找不到面板行').toBeDefined();
    await act(async () => (row as HTMLButtonElement).click());
    expect(useDockStore.getState().open['t-desk']).toBe(true);
    expect(useShelfStore.getState().open).toBe(false);
  });

  it('搜索框存在，且过滤后仍能命中面板（空查询 = 全列）', async () => {
    const input = container!.querySelector('.pp-shelf-search-input') as HTMLInputElement;
    expect(input, '架阁缺搜索框').not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '研报');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container!.textContent ?? '').toContain('研报工作台');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '不存在的词');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container!.textContent ?? '').not.toContain('研报工作台');
  });
});
