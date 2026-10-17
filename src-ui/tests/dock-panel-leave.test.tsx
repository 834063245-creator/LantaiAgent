// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 面板退场窗行为面（§15 退场对称 · 2026-10-16 真机报「侧栏收藏时跳变」）。
//
// 病灶（本文件就是它的钉子）：`PanelSlot` 的相位机原来只在 `useEffect` 里推进，
// 而 `mounted = open || phase === 'leaving'` 在**渲染期**读相位 ⇒ 收面那一趟
// `open` 已 false 而相位还是 'open'，于是 `return null` **把面拆掉**；effect 随后
// 把相位推到 'leaving'，面被当**新元素**挂回来——入场动效（`@starting-style`
// 起手式 / keyframes）在退场窗里重播，窗满时又按退场目标值一帧到位。用户读数 =
// 「点收藏，面先闪掉、再滑回来、然后啪一下没了」。
//
// 判据走 **DOM 节点身份 + 组件挂载次数**（与 CSS/绘制时机无关：节点被拆掉重挂
// 是 React 层的事实，真机上是否看得见闪帧取决于 effect 与绘制的先后）。

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockPanel } from '../src/app/panels/DockPanel';
import { compositionServicesPlugin, type PanelContribution } from '../src/composition/services';
import { Context } from '../src/cordis';
import { useDockStore } from '../src/state/dock-store';

/** 挂载计数（判据：退场窗里**不许**再挂一次）——只有 effect 计数 = 真挂载，
 *  渲染次数不算（渲染期修正 state 会多渲一趟，属正常）。 */
let mounts = 0;

function Stub() {
  useEffect(() => {
    mounts++;
  }, []);
  return <div className="t-stub" />;
}

/** 两个探针面：声明了 animateExit 的（退场窗）与没声明的（即时卸载）。 */
const PROBES: PanelContribution[] = [
  {
    id: 't-leave',
    side: null,
    title: '退场面',
    icon: 'x',
    unmountOnClose: true,
    animateExit: true,
    component: Stub,
  },
  {
    id: 't-instant',
    side: null,
    title: '即时面',
    icon: 'x',
    unmountOnClose: true,
    component: Stub,
  },
];

const M = Math.round(0.26 * 1000); // = --m-sheet ↔ PANEL_LEAVE_MS

describe('DockPanel 退场窗（animateExit）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    mounts = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const ctx = new Context();
    await ctx.plugin(compositionServicesPlugin);
    for (const p of PROBES) ctx.panels.register(p);
    for (const p of PROBES) useDockStore.getState().closePanel(p.id); // 上一用例可能留了开态
    await act(async () => {
      root?.render(<DockPanel />);
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
  });

  /** 开面并等一拍（让现场是「面已开稳」的常态）。 */
  async function openProbe(id: string): Promise<void> {
    act(() => useDockStore.getState().openPanel(id));
    await act(async () => {});
  }

  const stub = () => container!.querySelector('.t-stub');
  const leavingWrap = () => container!.querySelector('[data-panel-leaving]');

  it('收面（animateExit）：写 store 的**同一趟**就进退场窗——面不拆、不重挂', async () => {
    await openProbe('t-leave');
    const first = stub();
    expect(first, '开局面没挂上').not.toBeNull();
    mounts = 0; // 只看「收」这一拍

    act(() => useDockStore.getState().closePanel('t-leave'));

    // ① 同一棵 DOM 节点还在场（被拆掉重挂 ⇒ 入场动画在退场窗里重播）
    expect(stub(), '收面时面被拆掉又挂回来了——真机上读作「闪掉→滑回来」').toBe(first);
    expect(mounts, '退场窗里发生了重挂（入场动画重播）').toBe(0);

    // ② 这一趟就带退场标记（否则 260ms 是个「面还在、没在动」的空窗）
    expect(leavingWrap(), '收面那一趟没有进退场窗（相位晚了一趟）').not.toBeNull();
    expect(leavingWrap()?.contains(stub() as Node)).toBe(true);

    // ③ 窗满才真卸载
    await act(async () => {
      vi.advanceTimersByTime(M);
    });
    expect(stub(), '退场窗满了面还在（该卸载了）').toBeNull();
    expect(leavingWrap(), '退场标记该随面一起消失').toBeNull();
  });

  it('未声明 animateExit 的面：同一趟即时卸载（不留「冻住一帧」的空窗）', async () => {
    await openProbe('t-instant');
    expect(stub()).not.toBeNull();
    act(() => useDockStore.getState().closePanel('t-instant'));
    expect(stub(), '未声明 animateExit ⇒ 关即卸载（默认关不可回退）').toBeNull();
    expect(leavingWrap()).toBeNull();
  });

  it('退场窗内重开：面一直在场（标记摘掉 + 收尾定时器被清，不会「重开又自己消失」）', async () => {
    await openProbe('t-leave');
    const first = stub();
    mounts = 0;
    act(() => useDockStore.getState().closePanel('t-leave'));
    expect(leavingWrap()).not.toBeNull();

    // 窗内重开（书脊函套扣 / `/sidebar` 快开）
    act(() => useDockStore.getState().openPanel('t-leave'));
    expect(stub(), '重开时面被重挂（等于又播一次入场）').toBe(first);
    expect(mounts).toBe(0);
    expect(leavingWrap(), '重开后退场标记该摘掉').toBeNull();

    // 旧案：在途的收尾定时器没被清 ⇒ 260ms 后面自己消失
    await act(async () => {
      vi.advanceTimersByTime(M);
    });
    expect(stub(), '重开后被上一轮的收尾定时器删掉了').not.toBeNull();
  });
});
