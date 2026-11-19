// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸的题签行（2026-11-19 题签重画批的行为判据）。
//
// 这批把「这一卷打算怎么跑」的三笔（组合 / 模型 / 权限）从纸身里那枚纸签，抬到卷首
// 第三行（DraftFolioPicks，经 'draft-folio' 槽挂在天头）。本文件钉它的行为：
//   ① 三笔都在场，且模型那一枚是同一个组件（.ms-trigger，不是第二份实现）；
//   ② 组合下拉真能开、选中落进本卷题签（presetId）；
//   ③ 权限四行（跟随工作区 + 三档）真能开、选中落进题签第四格；
//   ④ 「弃纸」在这一行（书眉行退役后的去处）——点了 = 不烧号地撤纸。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { DraftFolioSurface } from '../src/plugins/builtin/compose-dock/DraftFolioSurface';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { useModeStore } from '../src/state/mode-store';
import { usePresetStore } from '../src/state/preset-store';
import { getChatStore } from '../src/ui/chat-store';

const PANEL = 'folio-picks';

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
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(<PaperDockContext.Provider value={DOCK_CONTEXT}>{node}</PaperDockContext.Provider>);
  });
  return root;
}
describe('待题纸 · 题签行（2026-11-19）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let paperId = '';

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    useDraftSheetStore.getState().dismissAll();
    usePresetStore.setState({ selected: 'standard', error: null });
    useModeStore.setState({ permissionMode: 'ask', sessionModes: {}, pendingYolo: false });
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

  /** 摊开一张纸并把题签填好（不填 = 出厂默认由纸自己写，这里要可控）。 */
  async function open() {
    root = mount(<DraftFolioSurface />, container);
    await act(async () => {
      paperId = useDraftSheetStore.getState().openSheet();
      useDraftSheetStore
        .getState()
        .setPicks({ presetId: null, providerName: '', model: 'm', thinking: undefined, permission: null }, paperId);
    });
  }

  const picks = () => useDraftSheetStore.getState().papers.find((p) => p.id === paperId)?.picks ?? null;

  it('三笔都在场：组合 / 模型（同一个 ModelSelector）/ 权限', async () => {
    await open();
    // 本件是**行内三笔**（.pp-folio-picks 那个盒子归卷首 DraftFolioLine，它测在 paper 侧）
    expect(container.querySelector('.pp-folio-pick')).not.toBeNull();
    const text = container.textContent ?? '';
    expect(text).toContain('组合');
    expect(text).toContain('模型');
    expect(text).toContain('权限');
    // 模型 = 坞期那枚同一个组件（不是第二份实现）
    expect(container.querySelector('.ms-trigger')).not.toBeNull();
  });

  it('组合下拉真能开，选中落进本卷题签（presetId）', async () => {
    await open();
    const signBtn = [...container.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-btn')].find((b) =>
      b.textContent?.includes('组合'),
    );
    expect(signBtn).toBeDefined();
    await act(async () => signBtn?.click());
    const menu = container.querySelector('[role="listbox"][aria-label="组合（preset）"]');
    expect(menu).not.toBeNull();
    const target = usePresetStore
      .getState()
      .roster.find((p) => p.id !== usePresetStore.getState().selected && p.patch !== null);
    expect(target).toBeDefined();
    const opt = [...container.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-opt')].find(
      (o) => o.textContent === (target?.metadata?.name ?? target?.id),
    );
    await act(async () => opt?.click());
    expect(picks()?.presetId).toBe(target?.id);
    expect(container.querySelector('[role="listbox"][aria-label="组合（preset）"]')).toBeNull();
    /* 读数必须跟着题签走（2026-11-19 真机报「选完组合没变」）：本件原先读的是
     * composition.compLabel —— 纸期没有活跃卷 ⇒ 那条链恒报全局默认 ⇒ 选完标签不动。
     * 判据 = 行上显示的就是刚选中的那一个。 */
    const label = [...container.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-btn')].find((b) =>
      b.textContent?.includes('组合'),
    )?.textContent;
    expect(label).toContain(target?.metadata?.name ?? target?.id ?? '');
  });

  it('权限四行（跟随工作区 + 三档）真能开，选中落进题签第四格，选完即收起', async () => {
    await open();
    const permBtn = [...container.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-btn')].find((b) =>
      b.textContent?.includes('权限'),
    );
    expect(permBtn).toBeDefined();
    await act(async () => permBtn?.click());
    const menu = container.querySelector('[role="listbox"][aria-label="权限"]');
    expect(menu).not.toBeNull();
    expect(menu?.querySelectorAll('[role="option"]')).toHaveLength(4);
    const modeOpt = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (o) => o.textContent === '半放',
    );
    await act(async () => modeOpt?.click());
    expect(picks()?.permission).toBe('auto');
    expect(container.querySelector('[role="listbox"][aria-label="权限"]')).toBeNull();
  });

  /* ⚠ 2026-11-19 真机返工（用户：「权限切换弹窗鼠标操作被吞」）：
   * 卷首的「全放」只**弹确认**，不落账——落账归渲染那个模态的那位（纸期输入面的
   * applyMode）。本件若也写一次就是两个真源：模态还没点，题签已经变了。 */
  it('全放只弹确认、不落账（落账归模态宿主；否则确认框是假的）', async () => {
    await open();
    const permBtn = [...container.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-btn')].find((b) =>
      b.textContent?.includes('权限'),
    );
    await act(async () => permBtn?.click());
    const yoloOpt = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (o) => o.textContent === '全放',
    );
    expect(yoloOpt).toBeDefined();
    await act(async () => yoloOpt?.click());
    // 弹确认态已置位，而题签**一个字没改**
    expect(useModeStore.getState().pendingYolo).toBe(true);
    expect(picks()?.permission).toBeNull();
  });

  it('「弃纸」在这一行（书眉行退役后的去处）：点了 = 不烧号地撤纸', async () => {
    await open();
    const discard = container.querySelector<HTMLButtonElement>('.pp-sheet-discard');
    expect(discard).not.toBeNull();
    expect(discard?.textContent).toBe('弃纸');
    await act(async () => discard?.click());
    expect(useDraftSheetStore.getState().papers.length).toBe(0);
  });
});
