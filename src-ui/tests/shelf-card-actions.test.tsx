// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 架阁卡片行的动作可见性（2026-11-21 实机报「首页点架阁，摊是无效的」）。
//
// 判据：不能落在任何卷/纸上的操作**不出现**，而不是点了再弹「画布还没准备好」。
// 「引」「摊」都要有画布（`open.paper` = 纸在）；「改」「删」是卡片库自己的操作，恒在。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* 卡片库 RPC 桩（只喂一行卡，避免真读盘）。必须在 import 产物之前声明。 */
vi.mock('../src/agent/card-library', () => ({
  listCards: () => Promise.resolve({ cards: [{ cardId: 'c1', kind: 'markdown', title: '测试卡', shelvedAt: '' }] }),
  readCard: () => Promise.resolve({ card: { kind: 'markdown', title: '测试卡', payload: {} }, state: null }),
  writeCardState: () => Promise.resolve(),
  renameCard: () => Promise.resolve(),
  deleteCard: () => Promise.resolve(),
}));

const { activeRootViews, rootViewsServicePlugin } = await import('../src/composition/root-views-service');
const { compositionServicesPlugin } = await import('../src/composition/services');
const { Context } = await import('../src/cordis');
const { shelfDomainPlugin } = await import('../src/plugins/builtin/shelf-domain');
const { useDockStore } = await import('../src/state/dock-store');
const { useShelfStore } = await import('../src/state/shelf-store');

describe('架阁卡片行动作可见性（v66 收尾）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const actionLabels = (): string[] =>
    [...container!.querySelectorAll('.pp-shelf-actions button')].map((b) => (b.textContent ?? '').trim());

  const openCardPage = async () => {
    await act(async () => {
      useShelfStore.getState().openShelf('card');
    });
    // 卡片清单是异步读的：让 microtask 队列跑完再断言。
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const ctx = new Context();
    await ctx.plugin(compositionServicesPlugin);
    await ctx.plugin(rootViewsServicePlugin);
    await ctx.plugin(shelfDomainPlugin);
    useShelfStore.getState().closeShelf();
    useDockStore.getState().closePanel('paper');
    await act(async () => {
      // 与 App.tsx 同一条渲染路（按槽取活动贡献行）。
      root?.render(activeRootViews('overlay').map((v) => <v.component key={v.id} />));
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useShelfStore.getState().closeShelf();
    useDockStore.getState().closePanel('paper');
  });

  it('首页（纸关着）不出现「引」「摊」', async () => {
    expect(useDockStore.getState().open.paper).toBeFalsy();
    await openCardPage();
    const labels = actionLabels();
    expect(labels.length, '卡片行没渲染出来，用例前提不成立').toBeGreaterThan(0);
    expect(labels, '没有画布时把无效操作摆出来了').not.toContain('引');
    expect(labels, '没有画布时把无效操作摆出来了').not.toContain('摊');
  });

  it('「改」「删」在任何界面状态都在（卡片库自己的操作）', async () => {
    await openCardPage();
    const labels = actionLabels();
    expect(labels).toContain('改');
    expect(labels).toContain('删');
  });

  it('纸开着（在画布里）时「引」「摊」回来', async () => {
    await act(async () => useDockStore.getState().openPanel('paper'));
    await openCardPage();
    const labels = actionLabels();
    expect(labels).toContain('引');
    expect(labels).toContain('摊');
  });
});
