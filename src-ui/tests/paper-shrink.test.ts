// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-shrink — 块宽相关：钉住宽度续命 / canvas-store 宽度手调。
// 2026-08-30 来文标题化：P2 变宽纸条（来文收缩宽）整体退役，收缩 describe 移除。

import { describe, expect, it } from 'vitest';

import { translateMessage, USER_BLOCK_WIDTH } from '../src/paper/translate';
import { getCanvasStore } from '../src/state/canvas-store';
import type { UserMessage } from '../src/ui/message-model';

/* ═══ 钉住宽度续命（P2b：pin.w 是钉住几何唯一真相）═══ */

describe('translate 钉住宽度续命', () => {
  it('pin.w 覆盖块宽（渲染宽经 translate 消费）', () => {
    const msg: UserMessage = { role: 'user', _id: 'm-pin', text: '钉住', sessionIndex: 0 };
    const b = translateMessage(msg, new Map([['pb:m-pin', { x: 10, y: -20, w: 400 }]]))[0];
    expect(b.state).toBe('pinned');
    expect(b.x).toBe(10);
    expect(b.y).toBe(-20);
    expect(b.w).toBe(400);
  });

  it('无 w 的钉住表维持 kind 缺省宽（向后兼容旧 canvas.json）', () => {
    const msg: UserMessage = { role: 'user', _id: 'm-pin2', text: '钉住', sessionIndex: 0 };
    const b = translateMessage(msg, new Map([['pb:m-pin2', { x: 0, y: 0 }]]))[0];
    expect(b.w).toBe(USER_BLOCK_WIDTH);
  });
});

/* ═══ canvas-store 宽度手调（P2b）═══ */

describe('canvas-store resizePin/resizeStrip', () => {
  it('resizePin 改 pin.w（引用更新、同值短路）', () => {
    const store = getCanvasStore('shrink-test');
    store.getState().setPin('pb:x', {
      x: 1,
      y: 2,
      w: 560,
      snapshot: { kind: 'user', text: 't' },
    });
    store.getState().resizePin('pb:x', 400);
    expect(store.getState().pins['pb:x']?.w).toBe(400);
    store.getState().resizePin('pb:x', 400); // 同值短路
    expect(store.getState().pins['pb:x']?.w).toBe(400);
    store.getState().unpin('pb:x');
  });

  it('resizeStrip 改纸条宽（同值短路）', () => {
    const store = getCanvasStore('shrink-test');
    store.getState().addStrip({ id: 'strip1', text: 't', x: 0, y: 0, w: 480 });
    store.getState().resizeStrip('strip1', 360);
    expect(store.getState().strips[0]?.w).toBe(360);
    store.getState().resizeStrip('strip1', 360);
    expect(store.getState().strips[0]?.w).toBe(360);
    store.getState().removeStrip('strip1');
  });
});
