// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸的**输入面**（2026-11-15 V2 立卷 UX 的 V2-P1 判据；
// **2026-11-19 题签重画批改写**）。
//
// 三件事必须同时为真，缺一条纸就不成立：
//   ① 纸在场时**坞槽整只不渲染**（不是隐藏输入条——V1 的 hidden 双轨已拆）；
//   ② 纸上那张输入面是**同一个组件**（ComposerSurface 的 sheet 变体），不是第二份实现；
//   ③ **纸身里没有设置行**（2026-11-19）：组合 / 模型 / 权限三笔升为卷首档行，走
//      'draft-folio' 槽（`DraftFolioPicks` → `DraftFolioSurface`），纸期书眉行同时退役
//      （它只说「待题 · 未开卷」+ 一枚弃纸，那句话与卷首眉行逐字重复）。
//      本文件因此只钉「纸身剩下什么」；三笔的**行为**（能开、能落账）在
//      `composer-folio-picks.test.tsx`——那是它们现在住的宿主。
//
// 判据读的都是 DOM 结构（组件行为面），不钉像素。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { DraftPaperContext, PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock, ComposerSheet } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { draftInputKey, useDraftSheetStore } from '../src/state/draft-sheet-store';
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
    useDraftSheetStore.getState().dismissAll();
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
    useDraftSheetStore.getState().dismissAll();
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
    // 纸期的书眉行**整行退役**（2026-11-19）：它只说「待题 · 未开卷」+ 一枚弃纸，
    // 而那句话与卷首眉行逐字重复。判据改为「这一面是纸」的反面：坞期那两件不在。
    expect(container.querySelector('.pp-sheet-header')).toBeNull();
    expect(container.querySelector('.pp-composer-target')).toBeNull();
    // 纸身只剩输入行（三笔已升为卷首档行）
    expect(container.querySelector('.pp-composer-row textarea')).not.toBeNull();
  });

  it('纸身里**没有设置行**（2026-11-19：三笔升为卷首档行，纸只剩输入行）', async () => {
    root = mount(<ComposerSheet />, container);
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });

    // 纸期不再有 data-variant="sheet" 的设置行（那一行随纸签一起退役）
    expect(container.querySelector('.pp-composer-settings')).toBeNull();
    // 坞期那套权限三档也不该被塞进纸身
    expect(container.querySelector('.pp-mode-seg')).toBeNull();
    // 模型触发器同样不在纸身（它现在住在卷首档行，见 composer-folio-picks）
    expect(container.querySelector('.ms-trigger')).toBeNull();
  });

  /* ⚠ 2026-11-30 非焦点纸身批：每张纸的输入面要显示**自己那份草稿**。
   * 旧实现一律读 input store 的 live 槽（= 焦点那张的正文），于是第二张纸的输入框里
   * 显示的是别人的字（看着像复制了一份）。切焦点时 `claimLive` 已经把旧主的正文快照
   * 进 `sessionDrafts['draft:<id>']`，故非焦点那张读槽就是它自己的字。 */
  it('两张纸：非焦点那张的输入面显示自己的草稿正文（不是焦点那张的）', async () => {
    let a = '';
    let b = '';
    await act(async () => {
      a = useDraftSheetStore.getState().openSheet();
      b = useDraftSheetStore.getState().openSheet(); // 焦点在 b
    });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <PaperDockContext.Provider value={DOCK_CONTEXT}>
          {[a, b].map((pid) => (
            <div key={pid} data-row={pid}>
              <DraftPaperContext.Provider value={pid}>
                <ComposerSheet />
              </DraftPaperContext.Provider>
            </div>
          ))}
        </PaperDockContext.Provider>,
      );
    });
    const input = getChatStore(PANEL).input;
    /* 生产时序：切焦点 = claimLive（旧主正文快照进槽）→ 在新主里打字 */
    await act(async () => {
      input.getState().claimLive(draftInputKey(a));
      input.getState().setInputText('甲的正文');
    });
    await act(async () => {
      input.getState().claimLive(draftInputKey(b));
      input.getState().setInputText('乙的正文');
    });

    const textOf = (pid: string) =>
      container.querySelector<HTMLTextAreaElement>(`[data-row="${pid}"] textarea`)?.value ?? '';
    expect(textOf(a), '非焦点那张读自己那份槽').toBe('甲的正文');
    expect(textOf(b), '焦点那张读 live').toBe('乙的正文');
  });
});
