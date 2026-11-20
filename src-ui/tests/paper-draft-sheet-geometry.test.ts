// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸 · 几何一致性（2026-11-14 用户真机报「开卷后很多东西定位错了」；
// **2026-11-15 V2**：起卷编排收进 `ChatCore.openDraftVolume`，纸高改实测）。
//
// 呼吸灯 / 匣脚引线 / 落位，这三样都以「流区几何」为单一真源：
//   · 落笔点（呼吸）走 CSS 的 bottom:56（相对流区盒）——只要流区盒 = 锚点框就对；
//   · 匣脚引线走 regionFootAnchorOf（regionTop + regionHeight）；
//   · 落位走 canvas.spread。
// 开卷这条路径与「侧栏新建」的差别只在**落位是谁写的**：侧栏交给落位 effect 的
// nearestFreeRegion，待题纸自己 place 到纸的锚点。若两者对同一卷给出不同的 anchor，
// 就会一套对一套错。

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
const { regionFootAnchorOf } = await import('../src/plugins/builtin/paper-shell/dock-tether');
const { getCanvasStore } = await import('../src/state/canvas-store');
const { useCanvasViewStore } = await import('../src/state/canvas-view-store');
const { useDraftSheetStore } = await import('../src/state/draft-sheet-store');
const { getChatStore } = await import('../src/ui/chat-store');
const { identityView } = await import('../src/paper/canvas-math');
const { EMPTY_REGION_CONTENT_H, STREAM_REGION } = await import('../src/paper/space');

describe('发送即开卷：几何与流区同一真源', () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    useShellStore.setState({ projectPath: 'D:/draft-ws' });
    useDraftSheetStore.getState().dismissAll();
    useCanvasViewStore.setState({ view: identityView(), canvasSize: { w: 1600, h: 900 } });
  });

  afterEach(() => {
    useDraftSheetStore.getState().dismissAll();
  });

  it('落位 = 纸的锚点（不撒手给另一个算法）', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const canvas = getCanvasStore(panel.panelId);
    const paper = draftPlacement({ panelId: panel.panelId });

    await act(async () => {
      useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().setAnchor(paper);
    });
    await act(async () => {
      getChatStore(panel.panelId).input.getState().setInputText('落笔');
      await panel.sendMessage();
      await new Promise((r) => setTimeout(r, 250));
    });

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions).toHaveLength(1);
    const sid = String(st.sessions[0]!.id);
    const placed = canvas.getState().spread[sid];
    expect(placed).toBeTruthy();
    expect(placed!.anchorX).toBeCloseTo(paper.anchorX, 0);
    expect(placed!.anchorY).toBeCloseTo(paper.anchorY, 0);
  });

  it('匣脚引线的卷侧锚点在**纸脚**上：落位与 regionTop/Height 必须同一套算式', () => {
    // 零块卷的流区几何（use-paper-regions 的同款算式）：
    const anchor = { anchorX: 800, anchorY: 450, width: STREAM_REGION.width };
    const regionTop = anchor.anchorY - EMPTY_REGION_CONTENT_H;
    const regionHeight = Math.max(0, anchor.anchorY - regionTop) + 72;
    const foot = regionFootAnchorOf({ ...anchor, regionTop, regionHeight });
    // 纸脚 = 锚点 + 72（STREAM_REGION 底距）——引线必须落在这里，不是落锚点上
    expect(foot.y).toBe(anchor.anchorY + 72);
    // 版心左缘：纸左缘 + (宽 − 版心宽)/2，版心 = 纸半
    expect(foot.x).toBe(anchor.anchorX - anchor.width / 2 + (anchor.width - anchor.width / 2) / 2);
  });
});
