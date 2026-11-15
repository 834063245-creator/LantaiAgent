// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸 · **化卷那一拍**（V2-P3，2026-11-15）。
//
// 病灶（V1 实测）：发送后纸**当帧消失**、卷当帧淡入——两件事同时发生，用户读到的是
// 「纸啪一下没了，卷啪一下出现」，而不是「这张纸变成了那一卷」。
//
// 本测钉三件事：
//   ① 发送成功后纸**不是当帧撤**，而是进交接态（data-morph='out'）——与新卷的
//      落纸同一窗（窗长 DRAFT_MORPH_MS = --m-sheet）；
//   ② 交接期**输入面整块撤掉**（那一句已经发出去了，留着它只会吃焦点/让人再发一次）；
//   ③ 窗满真撤纸；动效敏感（prefers-reduced-motion）时**当帧撤**（不留一座停住的纸）。
//
// 视觉面（只动 opacity / 不声明 transform）由 tests/motion-contract 钉；
// 起卷与落位由 tests/paper-draft-placement-split 钉——本件只管「那一拍有多长、长什么样」。

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
const { DRAFT_MORPH_MS, useDraftSheetStore } = await import('../src/state/draft-sheet-store');
const { EMPTY_REGION_CONTENT_H, REGION_FOOT_GAP, STREAM_REGION } = await import('../src/paper/space');
const { usePresetStore } = await import('../src/state/preset-store');
const { resetCanvasStoresForTests } = await import('../src/state/canvas-store');
const { useCanvasViewStore } = await import('../src/state/canvas-view-store');
const { identityView } = await import('../src/paper/canvas-math');

const PANEL = 'draft-morph';

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

describe('待题纸 · 化卷那一拍（V2-P3）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    useDraftSheetStore.getState().dismiss();
    usePresetStore.setState({ selected: 'standard', error: null });
    resetCanvasStoresForTests();
    useCanvasViewStore.setState({ view: identityView(), canvasSize: { w: 1600, h: 900 } });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useDraftSheetStore.getState().dismiss();
    vi.useRealTimers();
  });

  it('窗长与 --m-sheet 同值（0.26s）——镜像由 motion-contract 再钉一次', () => {
    expect(DRAFT_MORPH_MS).toBe(260);
  });

  it('发送后进交接态：纸不撤、输入面撤、天头改口「已交卷」', async () => {
    const m = await mount();
    root = m.root;
    container = m.container;
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().setAnchor({ anchorX: 800, anchorY: 450, width: 1440 });
    });
    // 交接前：纸在场 + 输入面在
    expect(container.querySelector('[data-morph]')).toBeNull();

    await act(async () => {
      useDraftSheetStore.getState().beginMorph(7);
    });

    // 纸还在（不是当帧撤），但已进交接态
    const sheet = container.querySelector('[data-draft-sheet]');
    expect(sheet).not.toBeNull();
    expect(sheet?.getAttribute('data-morph')).toBe('out');
    // 输入面整块撤掉（那一句已经发出去了）
    expect(container.querySelector('.pp-draft-stack')).toBeNull();
    expect(container.textContent).toContain('已交卷');
    // store：open 已 false（坞可以出现），morph 在场（纸张力上还在）
    expect(useDraftSheetStore.getState().open).toBe(false);
    expect(useDraftSheetStore.getState().morph).toEqual({ sessionId: 7 });
  });

  it('纸盒 = 卷盒：盒底落在锚点 + 底距（化卷那一拍纸不往上跳）', async () => {
    const m = await mount();
    root = m.root;
    container = m.container;
    const anchor = { anchorX: 800, anchorY: 450, width: STREAM_REGION.width };
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().setAnchor(anchor);
    });

    const sheet = container.querySelector('[data-draft-sheet]') as HTMLElement;
    const top = Number.parseFloat(sheet.style.top);
    const height = Number.parseFloat(sheet.style.height);
    // 盒底 = 锚点 + 底距：与卷的纸脚同一个尺子（此前纸以锚点为底线 ⇒ 化卷时纸往上跳 72px）
    expect(top + height).toBeCloseTo(anchor.anchorY + REGION_FOOT_GAP, 0);
    // 盒高不低于卷的最小盒高（小纸变不成大卷，否则那一拍会「拉开」一下）
    expect(height).toBeGreaterThanOrEqual(EMPTY_REGION_CONTENT_H + REGION_FOOT_GAP);
  });

  it('窗满真撤纸（交接不是永久的）', async () => {
    const m = await mount();
    root = m.root;
    container = m.container;
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().setAnchor({ anchorX: 800, anchorY: 450, width: 1440 });
    });
    await act(async () => {
      useDraftSheetStore.getState().beginMorph(9);
    });
    expect(container.querySelector('[data-draft-sheet]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(DRAFT_MORPH_MS + 10);
    });

    expect(container.querySelector('[data-draft-sheet]')).toBeNull();
    expect(useDraftSheetStore.getState().morph).toBeNull();
  });

  it('交接期开新纸 = 旧纸立即作废（定时器不许把新纸抹掉）', async () => {
    const m = await mount();
    root = m.root;
    container = m.container;
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().setAnchor({ anchorX: 800, anchorY: 450, width: 1440 });
    });
    await act(async () => {
      useDraftSheetStore.getState().beginMorph(11);
    });
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });
    // 新纸立刻是正常态（不是交接态），且旧定时器已清
    expect(useDraftSheetStore.getState().morph).toBeNull();
    expect(useDraftSheetStore.getState().open).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(DRAFT_MORPH_MS + 10);
    });
    expect(useDraftSheetStore.getState().open).toBe(true);
  });
});
