// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸 · **失焦之后还能不能再拿回来**（2026-11-19 用户报「题签态无法正常工作」）。
//
// 病灶（真机 CDP 取证）：非焦点那张纸整壳带 `inert`（2026-11-19 放弃合上态批），
// 而 JSX 里写的 `onPointerDownCapture` 并**不能**替 `inert` 开一条指针通道——
// `inert` 是被浏览器在**命中测试**阶段就摘掉的：`document.elementFromPoint` 在纸面
// 上返回的是纸**下面**的 `.pp-canvas`（实测），于是
//   ① 点纸 = 点在画布空白上 ⇒ `use-paper-viewport` 把焦点交回卷/画布；
//   ② 换焦点那条 capture 回调永远收不到事件（纸壳不是命中目标）；
//   ③ 纸上那枚输入面在子树里，于是再也打不了字——「题签态」成了钉在画布上的一页死纸。
// 叠加：空态判据读的是「焦点在不在纸上」⇒ 失焦留下一张纸的同时空态又盖上来
// （`.pp-empty` 与纸同屏），题签彻底不可达。
//
// 判据（本文件）：
//   ① 失焦的纸仍**可点**：纸壳不许带整壳 inert（那会连指针一并摘掉）；
//   ② 点它 = 焦点回到它（core.focusDraft 收到它，纸上的输入面随之可打字）。
// 空态那一条另钉在 paper-draft-empty-overlap（那一处要真 PaperPanel）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text })),
  walkLineRanges: vi.fn(),
  materializeLineRange: vi.fn(() => ({ width: 100, text: 'mock' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

import { DraftSheet } from '../src/plugins/builtin/paper-shell/DraftSheet';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';

const PANEL = 'draft-refocus';

describe('待题纸 · 失焦后仍可点回（inert 不许摘掉指针通道）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    useDraftSheetStore.getState().dismissAll();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useDraftSheetStore.getState().dismissAll();
  });

  async function mountWithTwoPapers(focusDraft: (id: string) => void): Promise<string> {
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      (root as Root).render(<DraftSheet core={{ panelId: PANEL, focusDraft }} />);
    });
    let first = '';
    await act(async () => {
      first = useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().openSheet(); // 第二张拿焦点 ⇒ 第一张失焦
    });
    await act(async () => {});
    return first;
  }

  it('失焦那张纸壳**不许**带 inert（整壳摘掉 = 点它等于点画布空白）', async () => {
    const first = await mountWithTwoPapers(vi.fn());
    const idle = container?.querySelector(`[data-paper-id="${first}"]`) as HTMLElement | null;
    expect(idle).not.toBeNull();
    expect(idle?.dataset.focused).toBeUndefined();
    /* 判据 = **纸壳本身必须还能被命中**：inert 写在纸壳上时，浏览器在命中测试阶段
     * 就把整壳摘掉（真机实测 elementFromPoint 落在 .pp-canvas 上）——换焦点那条
     * capture 回调永远收不到事件，纸于是成了钉在画布上的一页死纸。 */
    expect(idle?.hasAttribute('inert'), '失焦的纸不许整壳 inert（点不到就回不来）').toBe(false);
    expect(idle?.getAttribute('aria-hidden'), '同理：整壳 aria-hidden = 读屏也找不到它').toBeNull();
  });

  it('「只有焦点那张吃键盘」由天头之下的输入栈承担（inert 落在 .pp-draft-stack，不在纸壳）', async () => {
    const first = await mountWithTwoPapers(vi.fn());
    const idle = container?.querySelector(`[data-paper-id="${first}"]`) as HTMLElement | null;
    expect(idle?.querySelector('.pp-draft-stack')?.hasAttribute('inert'), '失焦那张的输入栈不进交互树').toBe(true);
    const focusedId = useDraftSheetStore.getState().focusedId;
    const focusedEl = container?.querySelector(`[data-paper-id="${focusedId}"]`) as HTMLElement | null;
    expect(focusedEl?.querySelector('.pp-draft-stack')?.hasAttribute('inert'), '焦点那张的输入栈照常可交互').toBe(
      false,
    );
  });

  it('点失焦那张 = 焦点回到它', async () => {
    const focusDraft = vi.fn((id: string) => useDraftSheetStore.getState().focusSheet(id));
    const first = await mountWithTwoPapers(focusDraft);
    expect(useDraftSheetStore.getState().focusedId).not.toBe(first);

    const idle = container?.querySelector(`[data-paper-id="${first}"]`) as HTMLElement | null;
    await act(async () => {
      idle?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(focusDraft).toHaveBeenCalledWith(first);
    expect(useDraftSheetStore.getState().focusedId).toBe(first);
    // 焦点回来 = 纸壳重开交互树
    const back = container?.querySelector(`[data-paper-id="${first}"]`) as HTMLElement | null;
    expect(back?.dataset.focused).toBe('true');
  });
});
