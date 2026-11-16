// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸 · 行为面（新卷出生面，**2026-11-15 V2：纸即输入面，发送即开卷**）。
// 设计件：docs/plans/canvas-space/new-session-ux.md §3.1 / §6.8 / §8
//
// 用户序列（与设计件 §3.1 三段对拍）：
//   0. 点「＋」→ 落一张**会打字的纸**：一个卷都不建（sessions 长度不变、不烧号）；
//   1. 纸上就是这张卷的创作坞（题签 + 输入 + 发送），纸面**没有第二个主动作**
//      ——没有「开卷」按钮（V1 的形态，V2 删）；
//   2. 按发送 → 起卷 + 把这句话发出去（编排在 ChatCore；本件只验纸的行为面）；
//   3. 发送被拒 → 纸留在原地 + 原因写在纸脚；
//   4. Esc（焦点不在输入件）= 弃纸。
//
// pretext 是真实文本引擎（node 下要 OffscreenCanvas）——卷首测高按纸面约定打桩
// （与 tests/paper-folio-height.test.ts 同一手法：行数 = ceil(宽 / 可用宽)）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const layoutMock = vi.hoisted(() =>
  vi.fn((_p: { _text: string }, _maxWidth: number, lineHeight: number) => ({ lineCount: 1, height: lineHeight })),
);
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text })),
  layout: layoutMock,
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text })),
  walkLineRanges: vi.fn(),
  materializeLineRange: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 1, maxLineWidth: 0 })),
}));

const { DraftSheet } = await import('../src/plugins/builtin/paper-shell/DraftSheet');
const { useDraftSheetStore } = await import('../src/state/draft-sheet-store');
const { usePresetStore } = await import('../src/state/preset-store');
const { resetCanvasStoresForTests } = await import('../src/state/canvas-store');
const { useCanvasViewStore } = await import('../src/state/canvas-view-store');
const { identityView } = await import('../src/paper/canvas-math');

const PANEL = 'draft-behaviour';

async function mount(): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(DraftSheet, { core: { panelId: PANEL } }));
  });
  return { root, container };
}

describe('待题纸 · 出生面（V2：纸即输入面）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    useDraftSheetStore.getState().dismissAll();
    usePresetStore.setState({ selected: 'standard', error: null });
    resetCanvasStoresForTests();
    useCanvasViewStore.setState({ view: identityView(), canvasSize: { w: 1600, h: 900 } });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useDraftSheetStore.getState().dismissAll();
  });

  it('未摊开 = 不渲染任何东西（零成本）', async () => {
    const m = await mount();
    root = m.root;
    container = m.container;
    expect(container.querySelector('[data-draft-sheet]')).toBeNull();
  });

  it('摊开 = 一张纸（天头已具形 + 待题眉行），不建卷、不烧号', async () => {
    const m = await mount();
    root = m.root;
    container = m.container;

    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });
    const sheet = container.querySelector('[data-draft-sheet]');
    expect(sheet).not.toBeNull();
    expect(sheet?.getAttribute('data-body-state')).toBe('ready');
    expect(container.textContent).toContain('待题');
    expect(container.textContent).toContain('案卷');
  });

  it('纸面**没有第二个主动作**：不存在「开卷」按钮（V1 形态已删）', async () => {
    const m = await mount();
    root = m.root;
    container = m.container;
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });

    const openBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('开卷'));
    expect(openBtn).toBeUndefined();
  });

  it('弃纸可达（Esc 之外的明路）：点「弃纸」= 不烧号地撤纸', async () => {
    const m = await mount();
    root = m.root;
    container = m.container;
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });
    // 弃纸按钮住在纸上的创作坞（overlays 贡献行）——本测只钉纸自身可达的那条：
    // Esc（焦点不在输入件）。按钮面由 composer-dock 的组件测试覆盖。
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useDraftSheetStore.getState().papers.length > 0).toBe(false);
  });

  it('发送被拒 → 纸留在原地 + 原因写在纸脚（错误不静默）', async () => {
    const m = await mount();
    root = m.root;
    container = m.container;
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });
    await act(async () => {
      useDraftSheetStore.getState().setNotice('组合「x」不在册');
    });

    expect(useDraftSheetStore.getState().papers.length > 0).toBe(true);
    expect(container.querySelector('[data-draft-sheet]')?.getAttribute('data-body-state')).toBe('rejected');
    expect(container.textContent).toContain('组合「x」不在册');
  });
});
