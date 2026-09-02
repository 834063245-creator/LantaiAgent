// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// canvas-store — Stage-5 工作区画布状态测试。
// 覆盖：① 摊开集合（setRegion/moveRegion/ensureRegion/removeRegion）
// ② 公共物钉住块（setPin/unpin/movePin + 快照互转）③ 公共物纸条
// ④ 活跃会话镜像 ⑤ StoredWorkspaceCanvas 快照→恢复往返 ⑥ 切工作区清空。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlock } from '../src/paper/block-model';
import { makeStrip, resetStripIdCounterForTests } from '../src/paper/selection';
import { defaultRegionFor } from '../src/paper/space';
import {
  blockFromSnapshot,
  getCanvasStore,
  loadCanvasFromDisk,
  pinsPositionMap,
  resetCanvasStoresForTests,
  saveCanvasToDisk,
  snapshotCanvas,
  snapshotFromBlock,
} from '../src/state/canvas-store';

// P3-2 分片测试：mock typedRpc 走内存假文件系统（真实 store + 真实序列化）
const fakeFs = new Map<string, string>();
vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  return {
    ...actual,
    typedRpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'write_file_content') {
        fakeFs.set(String(params.file_path), String(params.content));
        return 'null';
      }
      if (method === 'read_file_content') {
        const hit = fakeFs.get(String(params.file_path));
        if (hit === undefined) throw new Error('文件不存在');
        return hit;
      }
      throw new Error(`未 mock 的 RPC: ${method}`);
    }),
  };
});

const STORE = 'test-panel';

describe('canvas-store 摊开集合（工作区级流区位置）', () => {
  beforeEach(() => {
    resetCanvasStoresForTests();
  });

  it('setRegion/moveRegion/ensureRegion/removeRegion 语义', () => {
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

    // 收起 = 移除（流区退场不重排）
    st.removeRegion('1');
    expect(st.getRegion('1')).toBeUndefined();
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

describe('canvas-store 公共物（钉住块 + 纸条，工作区级宿主）', () => {
  beforeEach(() => {
    resetCanvasStoresForTests();
    resetStripIdCounterForTests();
  });

  it('setPin/unpin/movePin：钉到拔为止（不按会话隔离）', () => {
    const st = getCanvasStore(STORE).getState();
    const block = createBlock('markdown', { text: '一段计划' }, { messageId: 'm1', part: null });
    st.setPin(block.id, {
      x: 100,
      y: -200,
      w: block.w,
      source: { sessionId: 7, blockId: block.id },
      snapshot: snapshotFromBlock(block),
    });
    expect(st.getPin(block.id)).toMatchObject({ x: 100, y: -200, source: { sessionId: 7, blockId: block.id } });

    st.movePin(block.id, 300, -400);
    expect(st.getPin(block.id)).toMatchObject({ x: 300, y: -400 });

    st.unpin(block.id);
    expect(st.getPin(block.id)).toBeUndefined();
  });

  it('纸条增/拖/删：工作区级容器（不按会话归属）', () => {
    const st = getCanvasStore(STORE).getState();
    const s1 = makeStrip('纸条一', 10, 10);
    const s2 = makeStrip('纸条二', 20, 20);
    st.addStrip(s1);
    st.addStrip(s2);
    expect(st.getStrips().map((s) => s.id)).toEqual([s1.id, s2.id]);

    st.moveStrip(s1.id, 500, -500);
    expect(st.getStrips()[0]).toMatchObject({ x: 500, y: -500 });

    st.removeStrip(s1.id);
    expect(st.getStrips().map((s) => s.id)).toEqual([s2.id]);
  });
});

describe('canvas-store 快照互转与持久化往返', () => {
  beforeEach(() => {
    resetCanvasStoresForTests();
    resetStripIdCounterForTests();
  });

  it('snapshotFromBlock → blockFromSnapshot：源会话退场后仍可渲染', () => {
    const block = createBlock(
      'plan',
      { planId: 'p1', title: '计划', content: '- 步骤一', status: 'active' },
      { messageId: 'm1', part: null },
    );
    const pin = {
      x: 120,
      y: -340,
      w: block.w,
      source: { sessionId: 7, blockId: block.id },
      snapshot: snapshotFromBlock(block),
    };
    const rebuilt = blockFromSnapshot(block.id, pin);
    expect(rebuilt.kind).toBe('plan');
    expect(rebuilt.payload).toMatchObject({ planId: 'p1', content: '- 步骤一', status: 'active' });
    expect(rebuilt.state).toBe('pinned');
    expect(rebuilt.x).toBe(120);
    expect(rebuilt.y).toBe(-340);
    // JSON 往返（工作区画布状态文件走 JSON.stringify）——快照不含函数字段
    const back = JSON.parse(JSON.stringify(pin)) as typeof pin;
    expect(back.snapshot.kind).toBe('plan');
    expect(back.snapshot.payload).toMatchObject({ planId: 'p1' });
  });

  it('snapshotCanvas → loadCanvas 数据往返一致（重启恢复）', () => {
    const st = getCanvasStore(STORE).getState();
    st.setRegion('7', { anchorX: 6480, anchorY: -1200, width: 1440 });
    const block = createBlock('markdown', { text: '钉住内容' }, { messageId: 'm1', part: null });
    st.setPin(block.id, {
      x: 100,
      y: -200,
      w: block.w,
      source: { sessionId: 7, blockId: block.id },
      snapshot: snapshotFromBlock(block),
    });
    st.addStrip(makeStrip('纸条', 300, -200));
    st.setActiveRegion('7');

    const snapshot = snapshotCanvas(STORE);
    expect(snapshot.spread).toEqual([{ sessionId: 7, anchorX: 6480, anchorY: -1200, width: 1440 }]);
    expect(snapshot.activeSessionId).toBe(7);
    expect(Object.keys(snapshot.publics.pinned)).toHaveLength(1);
    expect(snapshot.publics.strips).toHaveLength(1);

    // 模拟重启：清内存 → 恢复
    resetCanvasStoresForTests();
    getCanvasStore(STORE).getState().loadCanvas(snapshot);
    const restored = getCanvasStore(STORE).getState();
    expect(restored.spread['7']).toEqual({ anchorX: 6480, anchorY: -1200, width: 1440 });
    expect(restored.pins[block.id]).toMatchObject({ x: 100, y: -200 });
    expect(restored.strips).toHaveLength(1);
    expect(restored.activeSessionId).toBe('7');
  });

  it('loadCanvas(null) = 空画布，不炸（旧存档/缺失）', () => {
    getCanvasStore(STORE).getState().loadCanvas(null);
    const st = getCanvasStore(STORE).getState();
    expect(st.spread).toEqual({});
    expect(st.pins).toEqual({});
    expect(st.strips).toEqual([]);
    expect(st.activeSessionId).toBeNull();
  });

  it('clearCanvas（切工作区）清空全部', () => {
    const st = getCanvasStore(STORE).getState();
    st.setRegion('1', defaultRegionFor(0));
    st.addStrip(makeStrip('t', 0, 0));
    st.setActiveRegion('1');
    st.clearCanvas();
    const fresh = getCanvasStore(STORE).getState();
    expect(fresh.spread).toEqual({});
    expect(fresh.strips).toEqual([]);
    expect(fresh.activeSessionId).toBeNull();
  });

  it('pinsPositionMap：钉住块 id → 位置查找表（转译层 ghosting）', () => {
    const st = getCanvasStore(STORE).getState();
    const block = createBlock('markdown', { text: 'x' }, { messageId: 'm1', part: null });
    st.setPin(block.id, {
      x: 300,
      y: -400,
      w: block.w,
      source: { sessionId: 1, blockId: block.id },
      snapshot: snapshotFromBlock(block),
    });
    expect(pinsPositionMap(STORE)).toEqual({ [block.id]: { x: 300, y: -400 } });
  });
});

describe('canvas-store 磁盘分片（P3-2，2026-09-02）', () => {
  const WS = 'D:/fake-ws';

  beforeEach(() => {
    resetCanvasStoresForTests();
    resetStripIdCounterForTests();
    fakeFs.clear();
  });

  it('saveCanvasToDisk 写三文件：v2 布局面 + pins/strips 分片；load 往返一致', async () => {
    const st = getCanvasStore(STORE).getState();
    st.setRegion('7', { anchorX: 6480, anchorY: -1200, width: 1440 });
    const block = createBlock('markdown', { text: '钉住内容' }, { messageId: 'm1', part: null });
    st.setPin(block.id, {
      x: 100,
      y: -200,
      w: block.w,
      source: { sessionId: 7, blockId: block.id },
      snapshot: snapshotFromBlock(block),
    });
    st.addStrip(makeStrip('纸条', 300, -200));
    st.setActiveRegion('7');

    expect(await saveCanvasToDisk(STORE, WS)).toBe(true);
    // 三文件齐 + 形状正确（v2 布局面不含 publics；分片各含 version）
    const layout = JSON.parse(fakeFs.get(`${WS}/.lantai/canvas.json`) ?? '{}');
    expect(layout.version).toBe(2);
    expect(layout.spread).toEqual([{ sessionId: 7, anchorX: 6480, anchorY: -1200, width: 1440 }]);
    expect(layout.activeSessionId).toBe(7);
    expect(layout.publics).toBeUndefined();
    const pinsShard = JSON.parse(fakeFs.get(`${WS}/.lantai/canvas-pins.json`) ?? '{}');
    expect(pinsShard.version).toBe(1);
    expect(Object.keys(pinsShard.pinned)).toHaveLength(1);
    const stripsShard = JSON.parse(fakeFs.get(`${WS}/.lantai/canvas-strips.json`) ?? '{}');
    expect(stripsShard.version).toBe(1);
    expect(stripsShard.strips).toHaveLength(1);

    // 重启恢复：清内存 → 三文件读回 → 复合形状一致
    resetCanvasStoresForTests();
    await loadCanvasFromDisk(STORE, WS);
    const restored = getCanvasStore(STORE).getState();
    expect(restored.spread['7']).toEqual({ anchorX: 6480, anchorY: -1200, width: 1440 });
    expect(restored.pins[block.id]).toMatchObject({ x: 100, y: -200 });
    expect(restored.strips).toHaveLength(1);
    expect(restored.activeSessionId).toBe('7');
  });

  it('v1 旧格式（publics 内联）迁移读——下次落盘自然写 v2 分片', async () => {
    fakeFs.set(
      `${WS}/.lantai/canvas.json`,
      JSON.stringify({
        version: 1,
        spread: [{ sessionId: 3, anchorX: 100, anchorY: -50, width: 1440 }],
        activeSessionId: 3,
        publics: {
          pinned: {},
          strips: [{ id: 'strip-1', text: '旧纸条', x: 10, y: 10, w: 360 }],
        },
      }),
    );
    await loadCanvasFromDisk(STORE, WS);
    const restored = getCanvasStore(STORE).getState();
    expect(restored.spread['3']).toEqual({ anchorX: 100, anchorY: -50, width: 1440 });
    expect(restored.strips).toHaveLength(1);
    expect(restored.strips[0]).toMatchObject({ text: '旧纸条' });
    expect(restored.activeSessionId).toBe('3');

    // 下次落盘 = v2 分片（迁移落定）
    expect(await saveCanvasToDisk(STORE, WS)).toBe(true);
    expect(JSON.parse(fakeFs.get(`${WS}/.lantai/canvas.json`) ?? '{}').version).toBe(2);
    expect(fakeFs.has(`${WS}/.lantai/canvas-strips.json`)).toBe(true);
  });

  it('v2 + 分片缺失 = 空公共物（不炸、不复活幽灵）', async () => {
    fakeFs.set(
      `${WS}/.lantai/canvas.json`,
      JSON.stringify({
        version: 2,
        spread: [{ sessionId: 1, anchorX: 0, anchorY: 0, width: 1440 }],
        activeSessionId: 1,
      }),
    );
    await loadCanvasFromDisk(STORE, WS);
    const restored = getCanvasStore(STORE).getState();
    expect(restored.spread['1']).toEqual({ anchorX: 0, anchorY: 0, width: 1440 });
    expect(restored.pins).toEqual({});
    expect(restored.strips).toEqual([]);
  });

  it('全空也写分片（防「删光钉后旧分片复活」）', async () => {
    getCanvasStore(STORE).getState().setRegion('1', defaultRegionFor(0));
    expect(await saveCanvasToDisk(STORE, WS)).toBe(true);
    expect(JSON.parse(fakeFs.get(`${WS}/.lantai/canvas-pins.json`) ?? '{}')).toEqual({ version: 1, pinned: {} });
    expect(JSON.parse(fakeFs.get(`${WS}/.lantai/canvas-strips.json`) ?? '{}')).toEqual({ version: 1, strips: [] });
  });
});
