// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatCore.requestFocus —— 待题纸开卷的「出生 = 一种展开」（2026-11-14 真机病灶）。
//
// 病灶复盘：待题纸开卷写的是 `core.requestFocus?.(sid)`，而 ChatCore **从来没有**这个
// 能力位 ⇒ 可选链静默吞掉 ⇒ 新卷既不飞也不成为活跃流区。用户看到的三个症状同源：
//   · 匣脚引线整层不画（activeSessionKey === null 时不画）；
//   · 创作坞对着上一卷 / 停在无主态；
//   · 目次带不指向新卷。
// 这一测钉住两件事：活跃流区被标上、定位请求被发出。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bridge', () => ({
  invoke: vi.fn(async () => null),
  rpc: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => true,
}));

import { ChatCore } from '../src/app/chat/chat-core';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';

describe('ChatCore.requestFocus：出生即展开', () => {
  beforeEach(() => {
    useCanvasViewStore.setState({ pendingFocusId: null });
  });

  it('标活跃流区 + 发定位请求（引线/坞/目次带三处判据）', () => {
    const core = new ChatCore();
    const canvas = getCanvasStore(core.panelId);
    canvas.getState().clearCanvas();

    core.requestFocus('7');

    expect(canvas.getState().activeSessionId).toBe('7');
    expect(useCanvasViewStore.getState().pendingFocusId).toBe('7');
  });

  it('null = 清请求（不残留悬空定位）', () => {
    const core = new ChatCore();
    const canvas = getCanvasStore(core.panelId);
    canvas.getState().clearCanvas();
    core.requestFocus('7');

    core.requestFocus(null);
    expect(useCanvasViewStore.getState().pendingFocusId).toBeNull();
  });
});
