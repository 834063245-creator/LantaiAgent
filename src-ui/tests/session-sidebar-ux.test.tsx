// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionSidebar 注疏重排守护（2026-08-31）：分节渲染（摊开中 OPEN / 已合卷
// CLOSED）+ 当前卷朱砂标记 + 常驻检索（过滤 / Esc 清空 / 无匹配空态）+
// 键盘导航（↓ 落列表 / ↑↓ 移动游标 / F2 改名 / Delete 两击确认删除）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { SessionSidebar } from '../src/plugins/builtin/canvas-nav/SessionSidebar';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { getChatStore } from '../src/ui/chat-store';

function fakeCore(panelId: string): { core: ChatCore; deleteSessionFile: Mock } {
  const deleteSessionFile = vi.fn();
  const core = {
    panelId,
    listSavedSessions: vi.fn(async () => [{ id: 2, label: '盘卷甲', msgCount: 5, savedAt: '2026-08-30T00:00:00Z' }]),
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    renameSavedSession: vi.fn(),
    closeSession: vi.fn(),
    deleteSessionFile,
  } as unknown as ChatCore;
  return { core, deleteSessionFile };
}

/** React 受控 input 的原生设值（绕开 value tracker 去重）。 */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function keydown(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('SessionSidebar 注疏重排（分节/检索/键盘）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let panelId: string;
  let core: ChatCore;
  let deleteSessionFile: Mock;

  beforeEach(() => {
    panelId = `test-ss-ux-${Math.random().toString(36).slice(2)}`;
    resetCanvasStoresForTests();
    useShellStore.getState().setProjectPath('');
    container = document.createElement('div');
    document.body.appendChild(container);
    ({ core, deleteSessionFile } = fakeCore(panelId));
    useCoreStore.getState().setChatCore(core);
    // 摊开两卷（卷 1 = 当前卷，均未落盘）+ 盘上一卷（未摊开）
    getChatStore(panelId).sess.setState({
      sessions: [
        { id: 1, label: '案卷一' },
        { id: 3, label: 'Cordis 迁移' },
      ],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 4,
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<SessionSidebar />);
    });
    await act(async () => {}); // listSavedSessions promise flush
  }

  it('分节渲染：摊开中 OPEN 在前 + 已合卷 CLOSED 在后；当前卷带朱砂标记', async () => {
    await mount();
    const heads = [...container.querySelectorAll('.ss-section-head .n')].map((e) => e.textContent);
    expect(heads).toEqual(['OPEN · 2', 'CLOSED · 1']);
    // 摊开节在前（同组新者上——未落盘卷按卷号倒序），合卷节殿后
    const labels = [...container.querySelectorAll('.ss-row .ss-label')].map((e) => e.textContent);
    expect(labels).toEqual(['Cordis 迁移', '案卷一', '盘卷甲']);
    const current = container.querySelector('.ss-row.current .ss-label');
    expect(current?.textContent).toBe('案卷一'); // activeIdx → 卷 1
    expect(container.querySelector('.ss-count')?.textContent).toBe('SESSIONS · 3');
  });

  it('检索：即输即滤 + 无匹配空态 + Esc 清空还原', async () => {
    await mount();
    const input = container.querySelector('.ss-search input') as HTMLInputElement;
    act(() => setNativeValue(input, '甲'));
    const labels = [...container.querySelectorAll('.ss-row .ss-label')].map((e) => e.textContent);
    expect(labels).toEqual(['盘卷甲']); // 只剩已合卷节命中行
    expect([...container.querySelectorAll('.ss-section-head .n')].map((e) => e.textContent)).toEqual(['CLOSED · 1']);
    act(() => setNativeValue(input, '不存在'));
    expect(container.querySelectorAll('.ss-row')).toHaveLength(0);
    expect(container.querySelector('.ss-empty')?.textContent).toBe('无匹配案卷');
    act(() => keydown(input, 'Escape'));
    expect(input.value).toBe(''); // 清空还原
    expect(container.querySelectorAll('.ss-row')).toHaveLength(3);
  });

  it('键盘：↓ 落列表首行，↑↓ 移动游标（roving tabindex）', async () => {
    await mount();
    const input = container.querySelector('.ss-search input') as HTMLInputElement;
    const rows = [...container.querySelectorAll('.ss-row')] as HTMLElement[];
    act(() => keydown(input, 'ArrowDown'));
    expect(document.activeElement).toBe(rows[0]);
    expect(rows[0].tabIndex).toBe(0);
    expect(rows[1].tabIndex).toBe(-1);
    act(() => keydown(rows[0], 'ArrowDown'));
    expect(document.activeElement).toBe(rows[1]);
    act(() => keydown(rows[1], 'ArrowUp'));
    expect(document.activeElement).toBe(rows[0]);
  });

  it('键盘 F2 进入改名 + Esc 取消', async () => {
    await mount();
    const row = container.querySelector('.ss-row') as HTMLElement;
    act(() => row.focus()); // onFocus → 游标切到该行
    act(() => keydown(row, 'F2'));
    const renameInput = container.querySelector('.ss-rename-input') as HTMLInputElement;
    expect(renameInput).not.toBeNull();
    expect(renameInput.value).toBe('Cordis 迁移');
    act(() => keydown(renameInput, 'Escape'));
    expect(container.querySelector('.ss-rename-input')).toBeNull();
  });

  it('键盘 Delete：一击武装（确删?）再一击写墓碑', async () => {
    await mount();
    const rows = [...container.querySelectorAll('.ss-row')] as HTMLElement[];
    const closed = rows[rows.length - 1]; // 盘卷甲（id 2，未摊开）
    act(() => closed.focus()); // onFocus → 游标切到该行
    act(() => keydown(closed, 'Delete')); // 一击：武装
    const danger = container.querySelector('.ss-danger') as HTMLButtonElement;
    expect(danger?.textContent).toBe('确删?');
    expect(deleteSessionFile).not.toHaveBeenCalled();
    act(() => {
      danger.click();
    }); // 再击：写墓碑
    expect(deleteSessionFile).toHaveBeenCalledWith('', 2);
  });
});
