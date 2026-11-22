// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 他卷待答提示（2026-11-22 二轮）：卡架是全局单架，别的卷在等作答/批准时，
// 本框敲的字仍发给**当前卷**。旧形态只有卡片上的卷名徽标——用户在本框里答完
// 才发现没送到。本行把事实摆在输入行上方，并给「切过去」入口（顶队头 + 切卷）。
//
// 与 tests/ui/ask-promote.test.ts 分工：那边考卡架队列与草稿；本份只考坞面提示。
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { type PendingAskEntry, useAskPendingStore } from '../src/state/ask-pending-store';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { getChatStore } from '../src/ui/chat-store';

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    registerComposer: vi.fn(),
    promoteAskBySession: vi.fn(),
    switchToSession: vi.fn(),
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  flyToPoint: vi.fn(),
};

function pending(over: Partial<PendingAskEntry> = {}): PendingAskEntry {
  return { id: 'ask-1', ownerSid: 2, kind: 'ask', label: '选一个方案', badge: '卷二', at: 1, ...over };
}

describe('创作坞 · 他卷待答提示', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    useAskPendingStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    useAskPendingStore.getState().reset();
  });

  const mountDock = async (core: ChatCore) => {
    useCoreStore.getState().setChatCore(core);
    getChatStore(core.panelId).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    getChatStore(core.panelId).input.getState().setInputText('');
    act(() => {
      root = createRoot(container);
      root.render(createElement(PaperDockContext.Provider, { value: DOCK_CONTEXT }, createElement(ComposerDock)));
    });
    await act(async () => {});
  };

  it('他卷在等作答 ⇒ 输入行上方出现提示，文案说清「本框发给当前卷」', async () => {
    await mountDock(fakeCore('ask-elsewhere'));
    expect(container.querySelector('.pp-ask-elsewhere')).toBeNull(); // 零待答不占行高

    act(() => {
      useAskPendingStore.getState().upsert(pending());
    });
    const hint = container.querySelector('.pp-ask-elsewhere');
    expect(hint).toBeTruthy();
    expect(hint!.textContent).toContain('卷二');
    expect(hint!.textContent).toContain('正在等作答');
    expect(hint!.textContent).toContain('本框输入仍发给当前卷');

    // 提示在输入行之前（敲字前可见），且不打断「书眉 → 输入 → 设置」的行序
    const dock = container.querySelector('.pp-composer')!;
    const classes = [...dock.children].map((el) => el.className);
    expect(classes.indexOf('pp-ask-elsewhere')).toBeLessThan(classes.indexOf('pp-composer-row'));
    expect(classes.indexOf('pp-composer-header')).toBe(0);
  });

  it('点「切过去」= 顶该卷的卡到队头 + 切卷（与待答缩略行同一手势）', async () => {
    const core = fakeCore('ask-elsewhere-jump');
    await mountDock(core);
    act(() => {
      useAskPendingStore.getState().upsert(pending({ ownerSid: 3, badge: '卷三' }));
    });
    const go = container.querySelector<HTMLButtonElement>('.pp-ask-elsewhere-go')!;
    expect(go).toBeTruthy();
    await act(async () => {
      go.click();
    });
    expect(core.promoteAskBySession).toHaveBeenCalledWith(3);
    expect(core.switchToSession).toHaveBeenCalledWith(3);
  });

  it('本卷自己的待答不提示（只有「别的卷」才需要这句话）', async () => {
    await mountDock(fakeCore('ask-elsewhere-self'));
    act(() => {
      useAskPendingStore.getState().upsert(pending({ ownerSid: 1, badge: '案卷一' }));
    });
    expect(container.querySelector('.pp-ask-elsewhere')).toBeNull();
  });

  it('权限卡同样提示（等批准也别在本框里答）；结账后提示消失', async () => {
    await mountDock(fakeCore('ask-elsewhere-perm'));
    act(() => {
      useAskPendingStore.getState().upsert(pending({ id: 'perm-1', kind: 'perm', label: 'bash', badge: '卷二' }));
    });
    const hint = container.querySelector('.pp-ask-elsewhere');
    expect(hint!.textContent).toContain('正在等批准');

    act(() => {
      useAskPendingStore.getState().settle('perm-1');
    });
    expect(container.querySelector('.pp-ask-elsewhere')).toBeNull();
  });
});
