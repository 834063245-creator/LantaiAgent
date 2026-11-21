// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 面板宿主壳（DockSlot，v66，2026-11-21）——本文件是 issue
// `lantai-plugin-panels-no-home` 的钉子。
//
// 病灶：`ctx.panels` 只有注册端没有出口。面板进得了 panelDefs()、openPanel() 也
// 成功，但壳里既没有入口也没有盒子——第三方插件面板裸挂文档流，被纸壳根
// （z 280）与首页底版（z 30）整片盖住，**任何应用状态下都不可见**。
//
// 判据刻意走**纯 DOM 结构**（不读 CSS 值）：一个不声明 frame、不写任何样式的插件面板
// 必须被 `.dock-slot[data-side]` 包起来，并且点关闭能消失。CSS 数值另有门禁
// （press-states / motion-contract），此处只钉「有没有落点」。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockPanel } from '../src/app/panels/DockPanel';
import { compositionServicesPlugin, type PanelContribution } from '../src/composition/services';
import { Context } from '../src/cordis';
import { useDockStore } from '../src/state/dock-store';

/** 一个**没有任何 CSS** 的面板——正是第三方作者的默认写法。 */
function Bare() {
  return <div className="t-bare">research-desk 内容</div>;
}

function SelfFramed() {
  return <div className="t-self">家具</div>;
}

const PROBES: PanelContribution[] = [
  { id: 't-shell-right', side: 'right', title: '研报工作台', icon: 'agent', component: Bare },
  { id: 't-shell-left', side: 'left', title: '左侧面', icon: 'list', component: Bare },
  { id: 't-self', side: 'left', title: '家具面', icon: 'book', frame: 'self', component: SelfFramed },
  { id: 't-overlay', side: null, title: '覆盖面', icon: 'settings', component: SelfFramed },
];

describe('DockSlot 宿主壳（v66）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const ctx = new Context();
    await ctx.plugin(compositionServicesPlugin);
    for (const p of PROBES) ctx.panels.register(p);
    for (const p of PROBES) useDockStore.getState().closePanel(p.id);
    await act(async () => {
      root?.render(<DockPanel />);
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    for (const p of PROBES) useDockStore.getState().closePanel(p.id);
  });

  it('不写任何 CSS 的面板被壳包进 .dock-slot[data-side]（本 issue 的正面解决）', async () => {
    await act(async () => useDockStore.getState().openPanel('t-shell-right'));
    const slot = container!.querySelector('.dock-slot');
    expect(slot, '面板没有落点——这就是 issue 报的症状').not.toBeNull();
    expect(slot!.getAttribute('data-side')).toBe('right');
    expect(container!.querySelector('.t-bare')?.textContent).toBe('research-desk 内容');
  });

  it('书眉由壳出：标题 + 关闭钮在盒子里', async () => {
    await act(async () => useDockStore.getState().openPanel('t-shell-right'));
    expect(container!.querySelector('.dock-slot-title')?.textContent).toBe('研报工作台');
    expect(container!.querySelector('.dock-slot-close')).not.toBeNull();
  });

  it('点关闭钮 = closePanel（走 dock-store 的关闭路径，含关闭守卫）', async () => {
    await act(async () => useDockStore.getState().openPanel('t-shell-right'));
    const btn = container!.querySelector('.dock-slot-close') as HTMLButtonElement;
    await act(async () => btn.click());
    expect(useDockStore.getState().open['t-shell-right']).toBe(false);
    expect(container!.querySelector('.dock-slot')).toBeNull();
  });

  it('side:left 贴左缘（data-side 单一真源来自 PanelDef.side）', async () => {
    await act(async () => useDockStore.getState().openPanel('t-shell-left'));
    expect(container!.querySelector('.dock-slot')?.getAttribute('data-side')).toBe('left');
  });

  it('frame:self 的家具不被壳包裹（自带定位与 chrome）', async () => {
    await act(async () => useDockStore.getState().openPanel('t-self'));
    expect(container!.querySelector('.t-self')).not.toBeNull();
    expect(container!.querySelector('.dock-slot')).toBeNull();
  });

  it('side:null 的全屏覆盖槽不被壳包裹', async () => {
    await act(async () => useDockStore.getState().openPanel('t-overlay'));
    expect(container!.querySelector('.t-self')).not.toBeNull();
    expect(container!.querySelector('.dock-slot')).toBeNull();
  });

  it('未开 = 零渲染', () => {
    expect(container!.querySelector('.dock-slot')).toBeNull();
    expect(container!.querySelector('.t-bare')).toBeNull();
  });
});
