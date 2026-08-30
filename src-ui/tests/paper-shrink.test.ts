// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-shrink — P2 变宽纸条（宽度自由）：来文收缩宽 / 钉住宽度续命 /
// canvas-store 宽度手调。pretext 全 mock（jsdom 无 Canvas 2D）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { naturalWidthMock, richStatsMock } = vi.hoisted(() => ({
  naturalWidthMock: vi.fn(() => 200),
  richStatsMock: vi.fn(() => ({ lineCount: 1, maxLineWidth: 150 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _segs: true })),
  measureNaturalWidth: naturalWidthMock,
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: richStatsMock,
}));

import { DEFAULT_BLOCK_WIDTH } from '../src/paper/block-model';
import { shrinkWrapUserWidth, USER_SHRINK_MIN_W } from '../src/paper/measure';
import { translateMessage, USER_BLOCK_WIDTH } from '../src/paper/translate';
import { getCanvasStore } from '../src/state/canvas-store';
import type { UserMessage } from '../src/ui/message-model';

function userBlock(text: string, files?: Array<{ path: string; name: string }>) {
  const msg: UserMessage = {
    role: 'user',
    _id: 'm-shrink',
    text,
    ...(files ? { files } : undefined),
    sessionIndex: 0,
  };
  return translateMessage(msg, undefined)[0];
}

/* ═══ 来文收缩宽（P2a）═══ */

describe('paper/measure 收缩宽', () => {
  beforeEach(() => {
    naturalWidthMock.mockClear();
    richStatsMock.mockClear();
    naturalWidthMock.mockReturnValue(200);
    richStatsMock.mockReturnValue({ lineCount: 1, maxLineWidth: 150 });
  });

  it('短来文收缩：natural + 左内缩 20', () => {
    const b = userBlock('短句');
    // natural 200 + inset 20 = 220 → 低于下限 clamp 到 USER_SHRINK_MIN_W
    expect(shrinkWrapUserWidth(b.payload as { text: string }, USER_BLOCK_WIDTH)).toBe(USER_SHRINK_MIN_W);
    naturalWidthMock.mockReturnValue(400);
    expect(shrinkWrapUserWidth(b.payload as { text: string }, USER_BLOCK_WIDTH)).toBe(420);
  });

  it('内容超预算宽 → null（保持全宽，不收缩）', () => {
    const b = userBlock('一段很长很长的来文内容');
    naturalWidthMock.mockReturnValue(800); // > 560 - 20
    expect(shrinkWrapUserWidth(b.payload as { text: string }, USER_BLOCK_WIDTH)).toBeNull();
  });

  it('rich 圈点路径：lineCount>1 = 折行 → null；单行取 maxLineWidth', () => {
    const b = userBlock('看【关键词】');
    expect(shrinkWrapUserWidth(b.payload as { text: string }, USER_BLOCK_WIDTH)).toBe(USER_SHRINK_MIN_W);
    richStatsMock.mockReturnValue({ lineCount: 2, maxLineWidth: 150 });
    expect(shrinkWrapUserWidth(b.payload as { text: string }, USER_BLOCK_WIDTH)).toBeNull();
  });

  it('附件行参与取宽（「附 · 」前缀 + 文件名）', () => {
    const b = userBlock('短', [{ path: 'D:/a.md', name: 'a.md' }]);
    void shrinkWrapUserWidth(b.payload as { text: string }, USER_BLOCK_WIDTH);
    // mock 收到 prepared 对象——剥 _text 验证量的是「附 · 文件名」整串
    const texts = naturalWidthMock.mock.calls.map((c) => (c[0] as { _text?: string })._text);
    expect(texts).toContain('附 · a.md');
  });

  it('纯文本块（markdown 等）不在收缩面（P2a 只收来文）', () => {
    // markdown 块 w=DEFAULT_BLOCK_WIDTH：shrinkWrapUserWidth 是 kind 无关纯函数，
    // 收缩分派在壳层（只对 user flow 块调用）——这里只钉契约：markdown 不经此函数。
    expect(DEFAULT_BLOCK_WIDTH).toBe(720);
  });
});

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
