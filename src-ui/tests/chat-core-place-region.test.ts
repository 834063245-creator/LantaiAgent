// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 真 ChatCore 的 placeRegion 是否真的写进了画布（2026-11-14 「开卷后定位全错」判别）。
//
// ChatCore.placeRegion 现在的实现是 `activeSpace()?.place(...)` —— **可选链**。
// activeSpace() 在插件服务未注册 / 面板未就绪时返回 null，于是整个落位**静默失效**，
// 且没有任何人知道（错误不静默铁律的漏洞）。本测钉住：无 space 服务时，
// placeRegion 必须仍然落位（回落到 canvas-store 直写），否则纸与卷分家。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bridge', () => ({
  invoke: vi.fn(async () => null),
  rpc: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => true,
}));

import { ChatCore } from '../src/app/chat/chat-core';
import { getCanvasStore } from '../src/state/canvas-store';

describe('ChatCore.placeRegion：落位不许静默失效', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('无 ctx.space 服务时仍写进 canvas-store（开卷后纸与卷同一锚点）', () => {
    const core = new ChatCore();
    const canvas = getCanvasStore(core.panelId);
    canvas.getState().clearCanvas();

    core.placeRegion('42', { anchorX: 1234, anchorY: -567 });

    const region = canvas.getState().spread['42'];
    expect(region, '放在没有 space 服务的环境里时，落位被可选链吞掉了').toBeTruthy();
    expect(region?.anchorX).toBe(1234);
    expect(region?.anchorY).toBe(-567);
  });
});
