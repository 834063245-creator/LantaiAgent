// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸开卷 · **落位判别**（2026-11-14 用户报「开卷后很多东西定位错了」；
// **2026-11-15 V2 改道**：起卷编排整体搬进 `ChatCore.openDraftVolume`）。
//
// 要害：开卷后卷必须落在**纸所在的那个锚点**。若落位静默失效，会退回
// `use-region-placement` 的 nearestFreeRegion（视口中心最近空位）——空画布上两个
// 算法恰好给出同一个数，**测不出来**；一旦用户平移过画布，两者立刻分家，用户看到的
// 就是「纸在这里、呼吸灯和引线在那里」。
//
// 本测刻意制造分家：先开纸，再把视口平移一大段，然后走**发送即开卷**这条真路径，
// 断言卷落在纸的锚点，而不是视口中心。

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
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

const { ChatCore } = await import('../src/app/chat/chat-core');
const { useCoreStore } = await import('../src/app/chat/core-instance');
const { useShellStore } = await import('../src/app/shell-store');
const { draftPlacement } = await import('../src/plugins/builtin/paper-shell/draft-sheet');
const { getCanvasStore } = await import('../src/state/canvas-store');
const { useCanvasViewStore } = await import('../src/state/canvas-view-store');
const { useDraftSheetStore } = await import('../src/state/draft-sheet-store');
const { getChatStore } = await import('../src/ui/chat-store');
const { nearestFreeRegion } = await import('../src/paper/space');
const { identityView } = await import('../src/paper/canvas-math');

const PANEL = 'draft-placement-split';

describe('发送即开卷：落位不许悄悄退回 nearestFreeRegion', () => {
  let panel: InstanceType<typeof ChatCore> | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    useShellStore.setState({ projectPath: 'D:/draft-ws' });
    useDraftSheetStore.getState().dismissAll();
    getCanvasStore(PANEL).getState().clearCanvas();
    useCanvasViewStore.setState({ view: identityView(), canvasSize: { w: 1600, h: 900 } });
  });

  afterEach(() => {
    useDraftSheetStore.getState().dismissAll();
  });

  it('开纸后平移视口 → 发送仍落在纸的锚点（不是视口中心）', async () => {
    panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const canvas = getCanvasStore(panel.panelId);

    const paper = draftPlacement({ panelId: panel.panelId });
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().setAnchor(paper);
    });

    // 用户平移画布：视口中心跑到别处（纸在世界里不动）
    await act(async () => {
      useCanvasViewStore.getState().setView({ zoom: 1, panX: 3000, panY: 1200 });
    });
    const movedCenter = nearestFreeRegion([], 3000 + 800, 1200 + 450);
    expect(movedCenter.anchorX).not.toBeCloseTo(paper.anchorX, 0);

    await act(async () => {
      getChatStore(panel!.panelId).input.getState().setInputText('落笔');
      await panel!.sendMessage();
      await new Promise((r) => setTimeout(r, 300));
    });

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions).toHaveLength(1);
    const sid = String(st.sessions[0]!.id);
    const placed = canvas.getState().spread[sid];
    expect(placed).toBeTruthy();
    expect(placed!.anchorX).toBeCloseTo(paper.anchorX, 0);
    expect(placed!.anchorY).toBeCloseTo(paper.anchorY, 0);
  });

  it('发送成功后纸撤场（化卷），题签随之作废（不再有第二真源）', async () => {
    panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const paper = draftPlacement({ panelId: panel.panelId });
    await act(async () => {
      useDraftSheetStore.getState().openSheet({ presetId: 'standard' });
      useDraftSheetStore.getState().setAnchor(paper);
    });

    await act(async () => {
      getChatStore(panel!.panelId).input.getState().setInputText('落笔');
      await panel!.sendMessage();
      await new Promise((r) => setTimeout(r, 300));
    });

    const draft = useDraftSheetStore.getState();
    expect(draft.papers.length > 0).toBe(false);
    expect(draft.papers.find((p) => p.id === draft.focusedId)?.picks ?? null).toBeNull();
    expect(draft.morphs).toEqual({});
  });
});
