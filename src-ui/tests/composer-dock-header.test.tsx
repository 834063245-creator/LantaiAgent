// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞三行制书眉行钉（2026-09-06 续批）：卷名 + 翰/律（+ 后台卷指示）恒居
// 坞顶书眉行（pp-composer-header）——用户打回「整组一起下沉」的旧两行制：三控件
// （模型/权限/思考）下沉设置行，但卷名/翰/律是坞的书眉，不随迁。本文件钉顶行
// 归属面防回退。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
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
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  flyToPoint: vi.fn(),
};

describe('创作坞书眉行（2026-09-06 续批：卷名/翰/律恒居顶行）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  const mountDock = async (panelId: string, value: PaperDockContextValue = DOCK_CONTEXT) => {
    useCoreStore.getState().setChatCore(fakeCore(panelId));
    getChatStore(panelId).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    getChatStore(panelId).input.getState().setInputText('');
    act(() => {
      root = createRoot(container);
      root.render(createElement(PaperDockContext.Provider, { value }, createElement(ComposerDock)));
    });
    await act(async () => {});
  };

  it('书眉行是坞的第一行：pp-composer-header 在输入行之前（两行制，无设置行）', async () => {
    await mountDock('header-order');
    const dock = container.querySelector('.pp-composer')!;
    const classes = [...dock.children].map((el) => el.className);
    expect(classes[0]).toBe('pp-composer-header'); // 书眉恒居顶
    const headerIdx = classes.indexOf('pp-composer-header');
    const rowIdx = classes.indexOf('pp-composer-row');
    expect(rowIdx).toBeGreaterThan(headerIdx);
    // 2026-11-08 丙案：设置行整行退役（坞面 13 件 → 5 件）
    expect(classes).not.toContain('pp-composer-settings');
  });

  it('卷名 + 模型 归属书眉行；翰/律 已于 2026-11-09 撤出（「案」抽屉里各有一份）', async () => {
    await mountDock('header-membership');
    const header = container.querySelector('.pp-composer-header')!;
    expect(header.querySelector('.pp-composer-target')).not.toBeNull(); // 卷名回顶
    // 2026-11-09 密度批：翰/律 撤出书眉——它们与「案」抽屉「另起」段里的同名行**重复**，
    // 同一件事在同一个坞里两个入口，读作"挤"。书眉工具带从此只剩「移/锁」（能力位）。
    expect(header.querySelectorAll('.pp-tool-btn').length).toBe(0);
    // 2026-11-08 丙案：模型（含档位后缀）也是书眉级身份件
    expect(header.querySelector('.ms-trigger')).not.toBeNull();
    // 输入行里不得重复出现书眉件
    const row = container.querySelector('.pp-composer-row')!;
    expect(row.querySelector('.pp-composer-target')).toBeNull();
    expect(row.querySelector('.pp-dock-tools')).toBeNull();
    expect(row.querySelector('.ms-trigger')).toBeNull();
  });

  it('律册在「案」抽屉里就地展开（2026-11-09：书眉那枚「律」钮撤掉后浮层改挂抽屉）', async () => {
    await mountDock('header-help-sheet');
    // 书眉里不再有 律 钮
    expect(
      [...container.querySelectorAll('.pp-composer-header .pp-tool-btn')].some((b) => b.textContent === '律'),
    ).toBe(false);
    act(() => {
      (container.querySelector('.pp-scheme-btn') as HTMLButtonElement).click();
    });
    await act(async () => {});
    const panel = container.querySelector('.pp-scheme-panel')!;
    const lü = [...panel.querySelectorAll<HTMLButtonElement>('.pp-scheme-row')].find((b) =>
      b.textContent?.includes('律'),
    )!;
    expect(lü).not.toBeUndefined();
    act(() => lü.click());
    await act(async () => {});
    const inline = panel.querySelector('.pp-help-inline');
    expect(inline).not.toBeNull(); // 就地展开，不再是绝对定位浮层
    expect(inline?.textContent).toContain('Enter'); // 键位在册
  });

  /* 2026-09-17 二版：拖动锁那枚单字工具（`移` ↔ `锁`）落**坞自己的工具行**——
   * 与 翰/律 同排同语言、常显可点。一版曾试「槽里浮一枚 hover 小钮」：浮在坞外，
   * 揭示靠悬停、命中又要靠揭示（互为前提）⇒ 用户「还没挪过去就消失了」；
   * 且外观不合坞的语言 ⇒ 用户「太难看了」。**位置与外观都归坞本体**。 */
  it('拖动锁工具：宿主给能力位才渲染（能力位纪律），默认锁定显「移」、点它回调写面', async () => {
    const toggle = vi.fn();
    await mountDock('header-lock', { ...DOCK_CONTEXT, composerLock: { unlocked: false, toggle } });
    const tools = [...container.querySelectorAll('.pp-dock-tools .pp-tool-btn')] as HTMLButtonElement[];
    // 2026-11-09：瀚/律 撤出后工具带只剩拖动锁这一枚
    expect(tools.map((b) => b.textContent)).toEqual(['移']);
    expect(tools[0].getAttribute('aria-pressed')).toBe('false');
    expect(tools[0].getAttribute('data-tip')).toContain('解锁创作坞');
    act(() => tools[0].click());
    expect(toggle).toHaveBeenCalledTimes(1); // 写面在槽主人手里，坞只回调

    await mountDock('header-lock-on', { ...DOCK_CONTEXT, composerLock: { unlocked: true, toggle } });
    const on = [...container.querySelectorAll('.pp-dock-tools .pp-tool-btn')] as HTMLButtonElement[];
    expect(on[0].textContent).toBe('锁');
    expect(on[0].getAttribute('aria-pressed')).toBe('true');
    expect(on[0].className).toContain('open'); // 选中语言与翰/律 的 .open 同款
  });

  it('拖动锁能力位缺失（宿主不给）：整枚不出现——工具带此时（翰/律 已撤）为空', async () => {
    await mountDock('header-no-lock'); // DOCK_CONTEXT 无 composerLock
    const tools = [...container.querySelectorAll('.pp-dock-tools .pp-tool-btn')] as HTMLButtonElement[];
    expect(tools.length).toBe(0); // 无能力位 + 无 翰/律 ⇒ 整条工具带为空
  });
});
