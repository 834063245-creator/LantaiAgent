// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸开卷 · **活跃流区**（2026-11-14 用户报「呼吸灯 / 创作坞引线定位错」；
// **2026-11-15 V2**：判据从「纸的按钮」搬到 `ChatCore.openDraftVolume` 的几何编排）。
//
// 这三样东西的定位都挂在「活跃卷」这一个判据上：
//   · 匣脚引线 dockTether：activeSessionKey === null 整层不画；
//   · 创作坞：activeSessionId 决定它对着哪一卷；
//   · 目次带：同判据。
// 若开卷后 activeSessionId 没跟上（仍是 null 或上一卷），用户看到的是
// 「坞对着别处 / 引线指向别处」——注意这与"流区盒几何错"是两回事。
//
// V2 的编排在 core 一处（openDraftVolume → placeRegion → requestFocus），
// 故本测直接钉 core 的那三个动作，不再绕经组件。

import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const { getCanvasStore } = await import('../src/state/canvas-store');
const { useCanvasViewStore } = await import('../src/state/canvas-view-store');
const { useDraftSheetStore } = await import('../src/state/draft-sheet-store');
const { getChatStore } = await import('../src/ui/chat-store');
const { identityView } = await import('../src/paper/canvas-math');

describe('发送即开卷：新卷必须成为活跃流区（引线/坞/目次带的判据）', () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    useShellStore.setState({ projectPath: 'D:/draft-ws' });
    useDraftSheetStore.getState().dismiss();
    useCanvasViewStore.setState({ view: identityView(), canvasSize: { w: 1600, h: 900 } });
  });

  it('开卷后 activeSessionId 指向新卷（否则引线不画、坞对着别处）', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    getCanvasStore(panel.panelId).getState().clearCanvas();

    await act(async () => {
      useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().setAnchor({ anchorX: 800, anchorY: 450, width: 1440 });
    });
    await act(async () => {
      getChatStore(panel.panelId).input.getState().setInputText('落笔');
      await panel.sendMessage();
      await new Promise((r) => setTimeout(r, 250));
    });

    const st = getChatStore(panel.panelId).sess.getState();
    expect(st.sessions).toHaveLength(1);
    const sid = String(st.sessions[0]!.id);
    // 判据：活跃流区 = 新卷。引线/坞/目次带全靠它。
    expect(getCanvasStore(panel.panelId).getState().activeSessionId).toBe(sid);
    // 落位也已写上（不是交给落位 effect 的兜底）
    expect(getCanvasStore(panel.panelId).getState().spread[sid]).toBeTruthy();
  });
});
