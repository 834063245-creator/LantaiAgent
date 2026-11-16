// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸开卷后的**定位一致性**（2026-11-14 用户真机报：开卷后呼吸灯、创作坞引线等
// 定位全错；**2026-11-15 V2 改道**：改为「发送即开卷」这条真路径）。
//
// 用真 PaperPanel + 真 ChatCore 走一遍发送开卷，把「纸在哪 / 卷落在哪 / 流区盒在哪 /
// 引线脚在哪」四个数一次读出来对拍。
//
// 判据（单一真源链）：
//   纸的锚点 = draftPlacement（视口中心最近空位）
//   → 卷落位 = 同一个锚点（core.placeRegion）
//   → 流区盒 top = regionTop − folioH、height = regionHeight + folioH
//   → 纸脚 = 盒底 = 锚点 + 72（STREAM_REGION 底距）
//   → 匣脚引线落点 =（版心左缘, 纸脚）
// 任何一环用另一个算法，用户看到的就是"纸在这里、灯和线在那里"。

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

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

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
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => new Fake2dCtx(),
});

const { ChatCore } = await import('../src/app/chat/chat-core');
const { useCoreStore } = await import('../src/app/chat/core-instance');
const { useShellStore } = await import('../src/app/shell-store');
const { regionFootAnchorOf } = await import('../src/plugins/builtin/paper-shell/dock-tether');
const { draftPlacement } = await import('../src/plugins/builtin/paper-shell/draft-sheet');
const { PaperPanel } = await import('../src/plugins/builtin/paper-shell/PaperPanel');
const { getCanvasStore } = await import('../src/state/canvas-store');
const { useCanvasViewStore } = await import('../src/state/canvas-view-store');
const { useDockStore } = await import('../src/state/dock-store');
const { useDraftSheetStore } = await import('../src/state/draft-sheet-store');
const { getChatStore } = await import('../src/ui/chat-store');
const { EMPTY_REGION_CONTENT_H } = await import('../src/paper/space');

const W = 1200;
const H = 800;
const VIEW = { zoom: 1, panX: 0, panY: 0 };

describe('发送即开卷：落位与流区盒同一真源', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/draft-ws' });
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

  it('发送 → 卷落在纸的锚点，流区盒底 = 锚点 + 72，引线脚在盒底', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const canvas = getCanvasStore(panel.panelId);
    const view = useCanvasViewStore;
    view.getState().setCanvasSize(W, H);
    view.getState().restoreView({ ...VIEW });

    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      (root as Root).render(<PaperPanel />);
    });
    await act(async () => {
      view.getState().setCanvasSize(W, H);
    });
    await act(async () => {
      view.getState().setView({ ...VIEW });
    });

    // 摊开待题纸：记下它自己的锚点（纸画在哪，卷就该落哪）
    const paper = draftPlacement({ panelId: panel.panelId });
    await act(async () => {
      useDraftSheetStore.getState().openSheet();
    });
    const sheet = container.querySelector('[data-draft-sheet]') as HTMLElement | null;
    expect(sheet).not.toBeNull();
    // ① 纸的渲染位置：左缘 = 锚点中轴 − 半宽
    expect(Number.parseFloat(sheet!.style.left)).toBeCloseTo(paper.anchorX - paper.width / 2, 0);

    // 发送即开卷（V2）：纸在场 + 有正文 → sendMessage 走 openDraftVolume。
    await act(async () => {
      getChatStore(panel.panelId).input.getState().setInputText('落笔');
      await panel.sendMessage();
      await new Promise((r) => setTimeout(r, 400));
    });

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions).toHaveLength(1);
    const sid = String(st.sessions[0]!.id);

    // ② 落位 = 纸的锚点（不是另一个"最近空位"算法算出来的地方）
    const placed = canvas.getState().spread[sid];
    expect(placed).toBeTruthy();
    expect(placed!.anchorX).toBeCloseTo(paper.anchorX, 0);
    expect(placed!.anchorY).toBeCloseTo(paper.anchorY, 0);

    // ③ 流区盒 = 零块卷几何（呼吸灯/引线都以它为坐标系）
    const el = container.querySelector(`[data-session-id="${sid}"]`) as HTMLElement | null;
    expect(el).not.toBeNull();
    const boxTop = Number.parseFloat(el!.style.top);
    const boxH = Number.parseFloat(el!.style.height);
    // 盒底 = 锚点 + 72 —— 呼吸灯（bottom:56）与引线脚都从这里派生
    expect(boxTop + boxH).toBeCloseTo(paper.anchorY + 72, 0);

    // ④ 引线脚 = 盒底，且 x 落在版心左缘
    const regionTop = paper.anchorY - EMPTY_REGION_CONTENT_H;
    const regionHeight = Math.max(0, paper.anchorY - regionTop) + 72;
    const foot = regionFootAnchorOf({ ...paper, regionTop, regionHeight });
    expect(foot.y).toBeCloseTo(boxTop + boxH, 0);
  });
});
