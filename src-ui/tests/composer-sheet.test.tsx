// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸的**输入面**（2026-11-15 V2 立卷 UX 的 V2-P1 判据）。
//
// 三件事必须同时为真，缺一条纸就不成立：
//   ① 纸在场时**坞槽整只不渲染**（不是隐藏输入条——V1 的 hidden 双轨已拆）；
//   ② 纸上那张输入面是**同一个组件**（ComposerSurface 的 sheet 变体），不是第二份实现；
//   ③ 纸期设置行 = 题签（组合 + 模型），**没有权限段**（权限是工作区级，纸期拨它无意义）。
//
// 判据读的都是 DOM 结构（组件行为面），不钉像素。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock, ComposerSheet } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { usePresetStore } from '../src/state/preset-store';
import { getChatStore } from '../src/ui/chat-store';

const PANEL = 'sheet-composer';

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    registerComposer: vi.fn(),
    builtinCommands: () => [],
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  flyToPoint: vi.fn(),
};

function mount(node: JSX.Element, container: HTMLDivElement): Root {
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<PaperDockContext.Provider value={DOCK_CONTEXT}>{node}</PaperDockContext.Provider>);
  });
  return root;
}

describe('待题纸的输入面（V2-P1）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    useDraftSheetStore.getState().dismiss();
    usePresetStore.setState({ selected: 'standard', error: null });
    useCoreStore.getState().setChatCore(fakeCore(PANEL));
    getChatStore(PANEL).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    getChatStore(PANEL).input.getState().setInputText('');
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    useDraftSheetStore.getState().dismiss();
  });

  it('纸不在场：坞在、纸期面不在（两槽互斥的第一半）', async () => {
    root = mount(
      <>
        <ComposerDock />
        <ComposerSheet />
      </>,
      container,
    );
    await act(async () => {});

    expect(container.querySelector('.pp-composer')).not.toBeNull();
    // 纸期面自己返回 null（它渲染的也是 .pp-composer，故用书眉判据区分）
    expect(container.querySelector('.pp-sheet-header')).toBeNull();
  });

  it('纸在场：坞壳整只不渲染，纸上那面出来（两槽互斥的第二半）', async () => {
    root = mount(
      <>
        <ComposerDock />
        <ComposerSheet />
      </>,
      container,
    );
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });

    const docks = container.querySelectorAll('.pp-composer');
    expect(docks).toHaveLength(1); // 只有纸期那一面
    // 纸期书眉（没有卷名可报，只有状态 + 弃纸）——这是「这一面是纸」的机读断言
    expect(container.querySelector('.pp-sheet-header')).not.toBeNull();
    expect(container.textContent).toContain('待题 · 未开卷');
    expect(container.textContent).toContain('弃纸');
    // 坞期的书眉卷名不在（那一行是「这一卷的账」，纸还没有卷号）
    expect(container.querySelector('.pp-composer-target')).toBeNull();
  });

  it('纸期设置行 = 题签：组合在、权限段不在', async () => {
    root = mount(<ComposerSheet />, container);
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });

    const settings = container.querySelector('.pp-composer-settings');
    expect(settings?.getAttribute('data-variant')).toBe('sheet');
    expect(container.querySelector('.pp-sheet-comp')).not.toBeNull();
    // 权限三档是坞期的事（工作区级单一真相）——纸上摆它只是噪音
    expect(container.querySelector('.pp-mode-seg')).toBeNull();
  });

  it('纸期的模型下拉与坞同一枚组件（不是第二份实现）', async () => {
    root = mount(<ComposerSheet />, container);
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });
    expect(container.querySelector('.ms-trigger')).not.toBeNull();
  });
});
