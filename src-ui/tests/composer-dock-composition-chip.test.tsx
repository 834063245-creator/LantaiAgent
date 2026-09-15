// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// S6 P1e：创作坞**组合芯片**（卷级组合选择的 UI 入口）——两态 + 只读锁。
//
// 用户序列（与设计件 §2 序列 A/B 对拍）：
//   1. 无主态（无活跃卷）→ 芯片拨的是**新卷出生默认**（全局默认，落 settings）；
//   2. 有活跃卷且**空白** → 芯片可拨，拨的是**卷级选择**（写路径 core.selectSessionPreset）；
//   3. 该卷**跑过一轮** → 芯片变**只读标签**（不再有按钮/下拉）；
//   4. 写路径拒绝（不可解析 / 已跑过一轮）→ 拒绝原因就地可见（localNotice）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { usePresetStore } from '../src/state/preset-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

const SID = 1;

/** 桩 core：带组合三能力位（读身份 / 空白判据 / 卷级选择），选择结果可注入。 */
function fakeCore(
  panelId: string,
  opts: { blank?: boolean; change?: { ok: boolean; reason?: string } } = {},
): {
  core: ChatCore;
  selectCalls: Array<{ sid: number; id: string }>;
} {
  const selectCalls: Array<{ sid: number; id: string }> = [];
  const core = {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    registerComposer: vi.fn(),
    isSessionBlank: vi.fn(() => opts.blank ?? true),
    sessionComposition: vi.fn(async () => ({ presetId: 'standard', source: 'global' as const, error: null })),
    selectSessionPreset: vi.fn(async (sid: number, id: string) => {
      selectCalls.push({ sid, id });
      return opts.change ?? { ok: true };
    }),
  } as unknown as ChatCore;
  return { core, selectCalls };
}

const ctx = (activeSessionId: string | null): PaperDockContextValue => ({ activeSessionId, flyToPoint: vi.fn() });

function mount(container: HTMLDivElement, value: PaperDockContextValue): Root {
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(createElement(PaperDockContext.Provider, { value }, createElement(ComposerDock)));
  });
  return root;
}

describe('S6 P1e 创作坞组合芯片：两态 + 只读锁', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    usePresetStore.setState({ selected: 'standard', error: null });
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  it('无主态：芯片在设置行左端（紧跟模型），拨动走全局默认入口', async () => {
    const { core, selectCalls } = fakeCore('e1');
    useCoreStore.getState().setChatCore(core);
    getChatStore('e1').sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
    root = mount(container, ctx(null));
    await act(async () => {});

    const chip = container.querySelector('[data-comp-chip]')!;
    expect(chip.querySelector('.pp-comp-pill')?.textContent).toContain('组合 ·');
    // 无活跃卷：不是卷级写路径（拨的是新卷出生默认）
    expect(core.selectSessionPreset).not.toHaveBeenCalled();
    // 点开 → 菜单列出内置 preset（standard/minimal 之类）
    const pill = chip.querySelector('.pp-comp-pill') as HTMLButtonElement;
    act(() => pill.click());
    const opts = [...container.querySelectorAll('.pp-comp-opt')];
    expect(opts.length).toBeGreaterThan(0);
    // 选一个 → 走全局入口（selectPreset 落 settings；这里断言没走卷级写路径）
    act(() => (opts[0] as HTMLButtonElement).click());
    await act(async () => {});
    expect(selectCalls).toEqual([]);
  });

  it('空白卷：芯片可拨 → 走卷级写路径（core.selectSessionPreset，卷号传 number）', async () => {
    const { core, selectCalls } = fakeCore('e2', { blank: true });
    useCoreStore.getState().setChatCore(core);
    getChatStore('e2').sess.setState({
      sessions: [{ id: SID, label: '空白卷' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    msgStoreFor('e2', SID).getState().setMessages([]);
    root = mount(container, ctx(String(SID)));
    await act(async () => {});

    const pill = container.querySelector('[data-comp-chip] .pp-comp-pill') as HTMLButtonElement;
    expect(pill.tagName).toBe('BUTTON'); // 可拨 = 按钮
    act(() => pill.click());
    const opts = [...container.querySelectorAll('.pp-comp-opt')];
    // 选一个**与当前不同**的 preset（当前 standard → 选 minimal）
    const minimal = opts.find((o) => o.textContent?.includes('minimal')) as HTMLButtonElement;
    act(() => minimal.click());
    await act(async () => {});

    expect(selectCalls).toEqual([{ sid: SID, id: 'minimal' }]);
  });

  it('跑过一轮：芯片退化为只读标签（不是按钮、无下拉、无写路径）', async () => {
    const { core, selectCalls } = fakeCore('e3', { blank: false });
    useCoreStore.getState().setChatCore(core);
    getChatStore('e3').sess.setState({
      sessions: [{ id: SID, label: '跑过的卷' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    msgStoreFor('e3', SID)
      .getState()
      .setMessages([{ _id: 1, role: 'user', text: '第一轮' } as never]);
    root = mount(container, ctx(String(SID)));
    await act(async () => {});

    const chip = container.querySelector('[data-comp-chip]')!;
    const label = chip.querySelector('.pp-comp-pill') as HTMLElement;
    expect(label.tagName).toBe('SPAN'); // 只读标签，不是按钮
    expect(chip.querySelector('.pp-comp-pill[data-locked]')).not.toBeNull();
    act(() => label.click()); // 点了也不该有菜单
    expect(chip.querySelector('.pp-comp-menu')).toBeNull();
    expect(selectCalls).toEqual([]);
  });

  it('写路径拒绝：原因就地可见（localNotice），不静默', async () => {
    const { core } = fakeCore('e4', {
      blank: true,
      change: { ok: false, reason: '本卷已跑过一轮——组合决定模型看到的工具与提示面，不能中途换（另起一卷再选）' },
    });
    useCoreStore.getState().setChatCore(core);
    getChatStore('e4').sess.setState({
      sessions: [{ id: SID, label: '卷' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    msgStoreFor('e4', SID).getState().setMessages([]);
    root = mount(container, ctx(String(SID)));
    await act(async () => {});

    const pill = container.querySelector('[data-comp-chip] .pp-comp-pill') as HTMLButtonElement;
    act(() => pill.click());
    const minimal = [...container.querySelectorAll('.pp-comp-opt')].find((o) =>
      o.textContent?.includes('minimal'),
    ) as HTMLButtonElement;
    act(() => minimal.click());
    await act(async () => {});

    expect(container.textContent).toContain('组合未切换');
    expect(container.textContent).toContain('跑过一轮');
  });
});
