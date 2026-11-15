// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 空画布 + 待题纸：**空态与纸不许同屏**（2026-11-15 用户报「点新开卷之后文字会和题签重叠」）。
//
// 根因：空态块 `.pp-empty`（LANTAI · BLANK SHEET /「案上无卷，落笔即起」/ CTA /
// 引导句 / 花押三星）只在 `sessions.length === 0` 时渲染；而待题纸**不建卷**
// （这正是立卷 UX 的要害），于是 sessions 仍是 0 ⇒ 空态照旧渲染，与纸同屏叠着：
// 空态在 top:36% 居整屏、纸在版心上——两段文字直接压在一起。
//
// 判据：待题纸摊开时，空态整块退场（纸本身就是出生面，CTA/引导句不再需要）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const layoutMock = vi.hoisted(() => vi.fn(() => ({ height: 36, lineCount: 2 })));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _mock: true })),
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

class Fake2dCtx {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textBaseline = '';
  setTransform(): void {}
  clearRect(): void {}
  fillRect(): void {}
  fillText(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
  strokeRect(): void {}
  closePath(): void {}
}
HTMLCanvasElement.prototype.getContext = function fakeGetContext() {
  return new Fake2dCtx();
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

let rafSeq = 0;
const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = ((cb: (t: number) => void) => {
  const id = ++rafSeq;
  rafTimers.set(
    id,
    setTimeout(() => {
      rafTimers.delete(id);
      cb(performance.now());
    }, 16),
  );
  return id;
}) as unknown as typeof requestAnimationFrame;
(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = ((id: number) => {
  const t = rafTimers.get(id);
  if (t) clearTimeout(t);
  rafTimers.delete(id);
}) as unknown as typeof cancelAnimationFrame;

import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { getChatStore } from '../src/ui/chat-store';

const W = 1200;
const H = 800;

describe('空画布：待题纸摊开时空态退场（不与题签重叠）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    useShellStore.setState({ projectPath: 'D:/empty-ws' });
    useDraftSheetStore.getState().dismiss();
    useDockStore.getState().closePanel('paper');
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useDraftSheetStore.getState().dismiss();
  });

  it('空画布：先有「案上无卷」空态 → 点新开卷后空态消失、只剩待题纸', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    // 空画布（一个卷都没有）
    getChatStore(panel.panelId).sess.setState({ sessions: [], activeIdx: -1, nextSessionId: 1 });
    useCanvasViewStore.getState().setCanvasSize(W, H);
    useCanvasViewStore.getState().restoreView({ zoom: 1, panX: 0, panY: 0 });

    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      (root as Root).render(<PaperPanel />);
    });
    await act(async () => {
      useCanvasViewStore.getState().setCanvasSize(W, H);
    });

    // ① 空画布 = 空态在场
    expect(container.querySelector('.pp-empty'), '空画布应有空态').not.toBeNull();

    // ② 点「另起一卷」→ 落待题纸（不建卷）
    const cta = container.querySelector('.pp-empty-cta') as HTMLButtonElement | null;
    expect(cta).not.toBeNull();
    await act(async () => {
      cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // ③ 纸在场，**空态必须退场**——否则两段文字叠在一起（用户报的那个）
    expect(container.querySelector('[data-draft-sheet]'), '待题纸应在场').not.toBeNull();
    expect(
      container.querySelector('.pp-empty'),
      '空态与待题纸同屏 = 文字重叠（LANTAI·BLANK SHEET / 案上无卷 / 引导句 压在题签上）',
    ).toBeNull();
  });
});
