// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper 内核无头测试 — 走查弹三层（块模型/画布数学/转译）纯逻辑对拍。
// vitest jsdom 环境下不触 DOM——本套只测数学与映射。

import { describe, expect, it } from 'vitest';
import {
  createBlock,
  DEFAULT_BLOCK_WIDTH,
  movePinned,
  pinBlock,
  resetBlockIdCounterForTests,
  unpinBlock,
} from '../src/paper/block-model';
import {
  ANCHOR,
  identityView,
  layoutFlow,
  panBy,
  screenToWorld,
  viewForAnchor,
  wheelFactor,
  worldToScreen,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
} from '../src/paper/canvas-math';
import { translateMessages, USER_BLOCK_WIDTH } from '../src/paper/translate';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

/* ── 测试数据构造（真实 message-model 形状，非 mock 接口——数据是本地产物） ── */

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}

function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}

/* ═══ 块模型 ═══ */

describe('paper/block-model', () => {
  it('createBlock 默认 flow（D-R1-2）', () => {
    resetBlockIdCounterForTests();
    const b = createBlock('markdown', { text: 'hi' }, { messageId: 'm1', part: null });
    expect(b.state).toBe('flow');
    expect(b.w).toBe(DEFAULT_BLOCK_WIDTH);
  });

  it('pinBlock/unpinBlock 状态与坐标往返', () => {
    resetBlockIdCounterForTests();
    const b = createBlock('markdown', { text: 'x' }, { messageId: 'm1', part: null });
    const p = pinBlock(b, 120, -340);
    expect(p.state).toBe('pinned');
    expect(p.x).toBe(120);
    expect(p.y).toBe(-340);
    // 幂等：同坐标再 pin 返回同一引用
    expect(pinBlock(p, 120, -340)).toBe(p);
    const back = unpinBlock(p);
    expect(back.state).toBe('flow');
    // flow 再 unpin 幂等
    expect(unpinBlock(back)).toBe(back);
  });

  it('movePinned 只改坐标不改状态', () => {
    resetBlockIdCounterForTests();
    const b = pinBlock(createBlock('user', { text: 'a' }, { messageId: 'm1', part: null }), 0, 0);
    const m = movePinned(b, 5, 5);
    expect(m.x).toBe(5);
    expect(m.state).toBe('pinned');
  });

  it('块 id 单调唯一', () => {
    resetBlockIdCounterForTests();
    const a = createBlock('notice', { text: '', level: 'info' }, { messageId: 'm', part: null });
    const b = createBlock('notice', { text: '', level: 'info' }, { messageId: 'm', part: null });
    expect(a.id).not.toBe(b.id);
  });
});

/* ═══ 画布数学 ═══ */

describe('paper/canvas-math', () => {
  it('world↔screen 互逆', () => {
    const v = { panX: 100, panY: 200, zoom: 1.5 };
    const s = worldToScreen(v, 40, -60);
    const w = screenToWorld(v, s.x, s.y);
    expect(w.x).toBeCloseTo(40);
    expect(w.y).toBeCloseTo(-60);
  });

  it('zoomAt 以光标为锚（锚点屏幕坐标不变）', () => {
    const v = identityView();
    const at = { x: 300, y: 200 };
    const z = zoomAt(v, at.x, at.y, 1.25);
    const s = worldToScreen(
      z,
      ...(() => {
        const w = screenToWorld(v, at.x, at.y);
        return [w.x, w.y];
      })(),
    );
    expect(s.x).toBeCloseTo(at.x);
    expect(s.y).toBeCloseTo(at.y);
  });

  it('zoomAt 夹在 [ZOOM_MIN, ZOOM_MAX]（无限画布但有缩放护栏）', () => {
    let v = identityView();
    for (let i = 0; i < 50; i++) v = zoomAt(v, 0, 0, 1.3);
    expect(v.zoom).toBeLessThanOrEqual(ZOOM_MAX);
    for (let i = 0; i < 50; i++) v = zoomAt(v, 0, 0, 0.5);
    expect(v.zoom).toBeGreaterThanOrEqual(ZOOM_MIN);
  });

  it('wheelFactor：deltaY 正 → 缩小', () => {
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-100)).toBeGreaterThan(1);
  });

  it('panBy 纯位移', () => {
    const v = panBy(identityView(), 10, -20);
    expect(v.panX).toBe(10);
    expect(v.panY).toBe(-20);
  });

  it('layoutFlow：最新块底边贴锚点（y=0），流向上生长（D-R1-3）', () => {
    const laid = layoutFlow([
      { id: 'old', h: 100 },
      { id: 'mid', h: 80 },
      { id: 'new', h: 60 },
    ]);
    // 最新块底边 = 0
    expect(laid.get('new')?.y).toBe(-60);
    // 中块底边 = 新块顶 - gap
    expect(laid.get('mid')?.y).toBe(-60 - ANCHOR.blockGap - 80);
    // 最旧块再往上
    expect(laid.get('old')?.y).toBe(-60 - ANCHOR.blockGap - 80 - ANCHOR.blockGap - 100);
    // 所有块居中窄带：块中心 x = 0
    for (const p of laid.values()) expect(p.x).toBe(-360); // 默认宽 720
  });

  it('viewForAnchor：锚点位于视口下缘上方、水平居中', () => {
    const { panX, panY } = viewForAnchor(1000, 800);
    // 世界 (0,0) 应映射到屏幕 (500, 800-96)
    const s = worldToScreen({ panX, panY, zoom: 1 }, 0, 0);
    expect(s.x).toBe(500);
    expect(s.y).toBe(800 - ANCHOR.screenBottomMargin);
  });
});

/* ═══ 转译层 ═══ */

describe('paper/translate', () => {
  it('user/notice 消息 1:1 转译；user 块窄', () => {
    resetBlockIdCounterForTests();
    const msgs: ChatMessage[] = [userMsg('u1', '修个 bug'), { role: 'notice', _id: 'n1', text: '提示', level: 'info' }];
    const blocks = translateMessages(msgs);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('user');
    expect(blocks[0].payload).toEqual({ text: '修个 bug' });
    expect(blocks[0].w).toBe(USER_BLOCK_WIDTH);
    expect(blocks[0].id).toBe('pb:u1');
    expect(blocks[1].kind).toBe('notice');
  });

  it('assistant parts 顺序映射为块序列（含 tool 状态直映）', () => {
    resetBlockIdCounterForTests();
    const msgs: ChatMessage[] = [
      asstMsg('a1', [
        { type: 'text', text: '开头', finalised: true },
        {
          type: 'tool',
          toolId: 't1',
          name: 'read_file_content',
          label: '读文件',
          args: '{}',
          readOnly: true,
          status: 'done',
          output: 'abc',
        },
        { type: 'text', text: '结尾', finalised: true },
      ]),
    ];
    const blocks = translateMessages(msgs);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown', 'tool', 'markdown']);
    const tool = blocks[1];
    expect(tool.payload).toMatchObject({ name: 'read_file_content', status: 'done', output: 'abc' });
    // 稳定 id：消息 id + part 序号
    expect(blocks[0].id).toBe('pb:a1:0');
    expect(tool.id).toBe('pb:a1:1');
    // 活引用：source.part 是原 part 对象
    expect(tool.source.part).toBe(msgs[0].parts[1]);
  });

  it('subagent parts 拍平展开，id 带子前缀不撞父消息', () => {
    resetBlockIdCounterForTests();
    const subPart = { type: 'text' as const, text: '子产出', finalised: true };
    const msgs: ChatMessage[] = [
      asstMsg('a1', [
        { type: 'subagent', agentId: 'sub-1', description: '调研', status: 'done', parts: [subPart], version: 1 },
      ]),
    ];
    const blocks = translateMessages(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('markdown');
    expect(blocks[0].id).toBe('pb:a1:0s0');
    expect(blocks[0].payload).toEqual({ text: '子产出' });
  });

  it('重转译按稳定 id 续命钉住态（活引用 D-R2-3）', () => {
    resetBlockIdCounterForTests();
    const msgs: ChatMessage[] = [asstMsg('a1', [{ type: 'text', text: 'v1', finalised: true }])];
    const first = translateMessages(msgs);
    // 用户钉住了这个块
    const pinned = new Map([[first[0].id, { x: 500, y: -300 }]]);
    // 消息更新（文本变长）后重转译
    const msgs2: ChatMessage[] = [asstMsg('a1', [{ type: 'text', text: 'v1（已更新很长）', finalised: true }])];
    const second = translateMessages(msgs2, { pinnedPositions: pinned });
    expect(second[0].id).toBe(first[0].id); // 稳定 id
    expect(second[0].state).toBe('pinned'); // 续命
    expect(second[0].x).toBe(500);
    expect(second[0].payload).toEqual({ text: 'v1（已更新很长）' }); // 内容取新（活引用）
  });

  it('空消息流 → 空块集', () => {
    expect(translateMessages([])).toEqual([]);
  });
});
