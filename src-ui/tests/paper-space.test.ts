// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-space — Stage-2 一纸多卷空间层无头测试。
// 覆盖：① 线性排比默认落位 + 网格吸附 ② layoutRegion 多锚布局（流区隔离）
// ③ 跨流区虚拟化 ④ canvas-store 流区位置（工作区级）持久化往返
// ⑤ ctx.space 读面 + demo 插件消费验证。

import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { CommandsService } from '../src/composition/services';
import { SpaceService } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { createBlock } from '../src/paper/block-model';
import { layoutRegion } from '../src/paper/canvas-math';
import { stashStripPositionAt } from '../src/paper/selection';
import { defaultRegionFor, nearestFreeRegion, STREAM_REGION, STREAM_SNAP_GRID, snapRegionX } from '../src/paper/space';
import { type RegionFlowGeom, visibleRegionWindows } from '../src/paper/virtualize';
import { formatSpaceState, spaceDemoPlugin } from '../src/plugins/space-demo-plugin';
import {
  getCanvasStore,
  resetCanvasStoresForTests,
  snapshotCanvas,
  snapshotFromBlock,
} from '../src/state/canvas-store';
import { getChatStore } from '../src/ui/chat-store';

const STORE = 'test-space';

/** 测试用假 core——SpaceService 只消费 panelId 与若干转发方法。 */
function fakeCore(panelId = STORE): ChatCore {
  return { panelId } as ChatCore;
}

describe('paper/space 常量与落位', () => {
  it('流区定案常量：宽 1440 / 间距 720 / 吸附网格 2160 / 边缘 6px', () => {
    expect(STREAM_REGION.width).toBe(1440);
    expect(STREAM_REGION.spacing).toBe(720);
    expect(STREAM_SNAP_GRID).toBe(2160);
    expect(STREAM_REGION.edgeWidth).toBe(6);
  });

  it('defaultRegionFor：线性排比——第 i 个会话贴第 i 列', () => {
    const r0 = defaultRegionFor(0);
    const r1 = defaultRegionFor(1);
    const r2 = defaultRegionFor(2);
    expect(r0.anchorX).toBe(0);
    expect(r1.anchorX).toBe(STREAM_SNAP_GRID);
    expect(r2.anchorX).toBe(STREAM_SNAP_GRID * 2);
    expect(r0.anchorY).toBe(0);
    expect(r0.width).toBe(STREAM_REGION.width);
  });

  it('snapRegionX：吸附到网格粒度', () => {
    expect(snapRegionX(100)).toBe(0);
    expect(snapRegionX(1000)).toBe(0);
    expect(snapRegionX(1081)).toBe(2160);
    expect(snapRegionX(2160 + 900)).toBe(2160);
    expect(snapRegionX(2160 + 1200)).toBe(4320);
    expect(snapRegionX(-1100)).toBe(-2160);
  });

  it('nearestFreeRegion：空场落参考列，Y 取参考 y', () => {
    const r = nearestFreeRegion([], 100, -500);
    expect(r).toEqual({ anchorX: 0, anchorY: -500, width: STREAM_REGION.width });
  });

  it('nearestFreeRegion：参考列被占 → 向左右外扩找最近空列', () => {
    const regions = [
      { sessionId: 'a', anchorX: 0 },
      { sessionId: 'b', anchorX: STREAM_SNAP_GRID },
    ];
    // 参考列 0 被占 → 先右（+1 已占）→ 左（-1）→ 落 -2160
    const r = nearestFreeRegion(regions, 100, 0);
    expect(r.anchorX).toBe(-STREAM_SNAP_GRID);
    // 参考列 1 被占 → 右 +1 = 4320 空 → 落 4320
    const r2 = nearestFreeRegion(regions, STREAM_SNAP_GRID + 100, 0);
    expect(r2.anchorX).toBe(STREAM_SNAP_GRID * 2);
  });

  it('nearestFreeRegion：填洞优先（占用间空列先被取）', () => {
    const regions = [
      { sessionId: 'a', anchorX: 0 },
      { sessionId: 'b', anchorX: STREAM_SNAP_GRID * 2 },
    ];
    // 参考列 0 被占、+1 空 → 落 +1（填洞而非外扩到 -1）
    const r = nearestFreeRegion(regions, 100, 0);
    expect(r.anchorX).toBe(STREAM_SNAP_GRID);
  });

  it('nearestFreeRegion：排除自身（拖动中的卷可留在原列）', () => {
    const regions = [{ sessionId: 'a', anchorX: 0 }];
    const r = nearestFreeRegion(regions, 100, 0, 'a');
    expect(r.anchorX).toBe(0);
  });
});

describe('paper/canvas-math layoutRegion（多锚布局）', () => {
  it('两流区各自坐标正确、互不牵连、整体平移', () => {
    const blocks = [
      { id: 'a', h: 100, w: 720, kind: 'markdown' },
      { id: 'b', h: 60, w: 720, kind: 'user' },
    ];
    const r0 = layoutRegion(blocks, { x: 0, y: 0 });
    const r1 = layoutRegion(blocks, { x: STREAM_SNAP_GRID, y: -500 });
    // 相对关系在两区一致（平移不变）
    const d0 = (r0.get('a')!.y - r0.get('b')!.y) / 1;
    const d1 = (r1.get('a')!.y - r1.get('b')!.y) / 1;
    expect(d0).toBe(d1);
    // r1 = r0 + 锚点平移
    expect(r1.get('a')!.x - r0.get('a')!.x).toBe(STREAM_SNAP_GRID);
    expect(r1.get('b')!.y - r0.get('b')!.y).toBe(-500);
  });

  it('layoutRegion 与单锚 layoutFlow 在锚点 (0,0) 同构（不回归）', () => {
    // 用 layoutFlow 作为参照：同输入同输出（锚点 0,0 时应逐位一致）
    // 这里不复算 layoutFlow（paper-core 已测），验证多锚路径不改变相对栈序。
    const blocks = [
      { id: 'old', h: 100 },
      { id: 'new', h: 60 },
    ];
    const laid = layoutRegion(blocks, { x: 0, y: 0 });
    expect(laid.get('new')!.y).toBe(-60); // 最新块底边贴锚点
    expect(laid.get('old')!.y).toBeLessThan(-60); // 旧块在更上方
  });
});

describe('paper/virtualize visibleRegionWindows（跨流区）', () => {
  const rect = { x0: -500, y0: -800, x1: 500, y1: 0 };

  it('只返回视口横向相交流区的可见窗口', () => {
    const regions: RegionFlowGeom[] = [
      { sessionId: '1', flow: [{ id: 'b1', y: -100, h: 60, x: -360, w: 720 }], anchorX: 0, anchorY: 0, width: 1440 },
      { sessionId: '2', flow: [{ id: 'b2', y: -100, h: 60, x: -360, w: 720 }], anchorX: 5000, anchorY: 0, width: 1440 },
      { sessionId: '3', flow: [{ id: 'b3', y: -100, h: 60, x: -360, w: 720 }], anchorX: 2160, anchorY: 0, width: 1440 },
    ];
    const win = visibleRegionWindows(regions, rect);
    expect([...win.keys()]).toEqual(['1']); // 仅流区 1 与视口相交
    expect(win.get('1')).toEqual({ first: 0, lastExcl: 1 });
  });

  it('流区 x 相交但块不可见 → 不出现在结果', () => {
    const regions: RegionFlowGeom[] = [
      // 流区 1 横向相交，但块在很上方（视口 y 之外）
      { sessionId: '1', flow: [{ id: 'b1', y: -50000, h: 60, x: -360, w: 720 }], anchorX: 0, anchorY: 0, width: 1440 },
    ];
    const win = visibleRegionWindows(regions, rect, 200);
    expect(win.size).toBe(0);
  });
});

describe('canvas-store 流区位置（工作区级持久化形状，Stage-5）', () => {
  beforeEach(() => {
    resetCanvasStoresForTests();
  });

  it('setRegion/moveRegion/ensureRegion 语义', () => {
    const st = getCanvasStore(STORE).getState();
    expect(st.getRegion('1')).toBeUndefined();

    st.setRegion('1', { anchorX: 2160, anchorY: -300, width: 1440 });
    expect(st.getRegion('1')).toEqual({ anchorX: 2160, anchorY: -300, width: 1440 });

    st.moveRegion('1', 4320, -500);
    expect(st.getRegion('1')).toEqual({ anchorX: 4320, anchorY: -500, width: 1440 });

    // ensureRegion：已存在不覆盖
    st.ensureRegion('1', { anchorX: 9999, anchorY: 0, width: 1440 });
    expect(st.getRegion('1')).toEqual({ anchorX: 4320, anchorY: -500, width: 1440 });
    // 缺失时补写
    st.ensureRegion('2', defaultRegionFor(0));
    expect(st.getRegion('2')).toEqual(defaultRegionFor(0));
  });

  it('流区位置随工作区画布状态文件落盘/恢复往返（重启恢复）', () => {
    const st = getCanvasStore(STORE).getState();
    st.setRegion('7', { anchorX: 6480, anchorY: -1200, width: 1440 });
    const block = createBlock('markdown', { text: 'x' }, { messageId: 'm1', part: null });
    st.setPin(block.id, {
      x: 100,
      y: -200,
      w: block.w,
      source: { sessionId: 7, blockId: block.id },
      snapshot: snapshotFromBlock(block),
    });

    const snapshot = snapshotCanvas(STORE);
    expect(snapshot.spread).toEqual([{ sessionId: 7, anchorX: 6480, anchorY: -1200, width: 1440 }]);
    expect(Object.keys(snapshot.publics.pinned)).toHaveLength(1);

    // 模拟重启：清内存 → 恢复
    resetCanvasStoresForTests();
    getCanvasStore(STORE).getState().loadCanvas(snapshot);
    const restored = getCanvasStore(STORE).getState();
    expect(restored.getRegion('7')).toEqual({ anchorX: 6480, anchorY: -1200, width: 1440 });
    expect(restored.getPin(block.id)).toMatchObject({ x: 100, y: -200 });
  });

  it('旧存档无 region 字段 = 未落位（渲染层按默认落位补写），不炸', () => {
    getCanvasStore(STORE).getState().loadCanvas(null);
    const st = getCanvasStore(STORE).getState();
    expect(st.getRegion('9')).toBeUndefined();
  });

  it('setRegion 引用比较短路：位置未变不触发订阅', () => {
    const st = getCanvasStore(STORE).getState();
    st.setRegion('1', { anchorX: 0, anchorY: 0, width: 1440 });
    let calls = 0;
    const un = getCanvasStore(STORE).subscribe(() => calls++);
    st.setRegion('1', { anchorX: 0, anchorY: 0, width: 1440 });
    expect(calls).toBe(0);
    st.setRegion('1', { anchorX: 2160, anchorY: 0, width: 1440 });
    expect(calls).toBe(1);
    un();
  });
});

describe('paper/selection stashStripPositionAt（流区中轴落点）', () => {
  it('落点相对流区中轴：x = centerX + 带半宽 + 边距', () => {
    const pos = stashStripPositionAt(-500, [], 400, 2160);
    expect(pos.x).toBe(2160 + 400 + 48);
    expect(pos.y).toBe(-500);
  });

  it('centerX=0 与旧 stashStripPosition 同构', () => {
    const at0 = stashStripPositionAt(-500, [], 400, 0);
    expect(at0.x).toBe(448);
  });
});

describe('ctx.space 通道（SpaceService + demo 插件消费）', () => {
  beforeEach(() => {
    resetCanvasStoresForTests();
    // 注入测试面板的假 core（SpaceService 以 panelId 定位 canvas/sess store）
    useCoreStore.getState().setChatCore(fakeCore());
  });

  it('getState：读流区位置 + 活跃会话（含默认落位推导）', () => {
    const canvas = getCanvasStore(STORE).getState();
    canvas.setRegion('1', { anchorX: 2160, anchorY: -300, width: 1440 });
    getChatStore(STORE).sess.setState({
      sessions: [
        { id: 1, label: '案卷一' },
        { id: 2, label: '' },
      ],
      activeIdx: 1,
    });

    const ctx = new Context();
    new SpaceService(ctx);
    const state = ctx.space.getState();
    expect(state.activeSessionId).toBe('2');
    expect(state.regions).toHaveLength(2);
    // 流区 1 读持久化位置；流区 2 无位置 → 默认线性排比
    expect(state.regions[0]).toMatchObject({ sessionId: '1', anchorX: 2160, anchorY: -300, width: 1440 });
    expect(state.regions[1]).toMatchObject({ sessionId: '2', anchorX: STREAM_SNAP_GRID, width: 1440 });
  });

  it('place：落位命令写入 canvas-store', () => {
    const ctx = new Context();
    new SpaceService(ctx);
    ctx.space.place('1', 4320, -600);
    expect(getCanvasStore(STORE).getState().spread['1']).toEqual({
      anchorX: 4320,
      anchorY: -600,
      width: 1440,
    });
  });

  it('subscribe：流区/活跃会话变化触发回调', () => {
    const ctx = new Context();
    new SpaceService(ctx);
    let calls = 0;
    const un = ctx.space.subscribe(() => calls++);
    getChatStore(STORE).sess.setState({ sessions: [{ id: 1, label: 'a' }], activeIdx: 0 });
    expect(calls).toBe(1);
    getCanvasStore(STORE).getState().setRegion('1', { anchorX: 2160, anchorY: 0, width: 1440 });
    expect(calls).toBe(2);
    un();
  });

  it('demo 插件经 ctx.space 读到画布状态（stage-2 验收：孔可用）', () => {
    const canvas = getCanvasStore(STORE).getState();
    canvas.setRegion('1', { anchorX: 2160, anchorY: -300, width: 1440 });
    getChatStore(STORE).sess.setState({ sessions: [{ id: 1, label: '案卷一' }], activeIdx: 0 });

    const ctx = new Context();
    new CommandsService(ctx);
    new SpaceService(ctx);
    // 插件 apply 不抛（注册订阅 + 命令）
    spaceDemoPlugin.apply(ctx);
    // 插件的读面格式函数能看到画布状态
    const msg = formatSpaceState(ctx.space.getState());
    expect(msg).toContain('案卷一');
    expect(msg).toContain('@(2160, -300)');
    expect(msg).toContain('活跃 1');
    expect(ctx.commands.get('space/demo-status')).toBeTruthy();
  });
});
