// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 空画布 + 待题纸：**案头形态也退场**（2026-11-15 用户报「文字和题签重叠」的同胞病灶）。
//
// 空态块（.pp-empty）与案头形态（pp-at-desk + 签条架）读的是**同一条判据**
// ——`sessions.length === 0`。待题纸不建卷 ⇒ 两者都以为"还是空案头"：
//   · 空态：kicker/题字/引导句/花押 压在题签上；
//   · 案头：坞退匣直书 + 坞下挂「续 · 卷名」签条架，同样与纸撞。
// 本测钉住第二件：纸在场时坞**不再**是案头形态、签条架不出现。

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

describe('空画布 + 待题纸：案头形态退场', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    useShellStore.setState({ projectPath: 'D:/desk-ws' });
    useDraftSheetStore.getState().dismissAll();
    useDockStore.getState().closePanel('paper');
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useDraftSheetStore.getState().dismissAll();
  });

  it('纸摊开后坞槽不再是案头形态（pp-at-desk 退场）', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
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

    // 空画布 = 案头形态在场
    expect(container.querySelector('.pp-composer-slot.pp-at-desk'), '空画布应是案头形态').not.toBeNull();

    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });

    // 纸在场 ⇒ 案头退场（否则坞退匣直书 + 签条架与纸同屏）
    expect(container.querySelector('[data-draft-sheet]')).not.toBeNull();
    expect(
      container.querySelector('.pp-composer-slot.pp-at-desk'),
      '纸摊开时坞仍是案头形态 = 退匣直书/签条架与纸同屏',
    ).toBeNull();
  });
});
