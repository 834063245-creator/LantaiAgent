// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-store + 纸面持久化收尾测试（2026-08-24）。
// 覆盖：① store 按会话隔离（钉住/纸条互不串卷）② 快照捕获→恢复往返
// ③ 清理路径（合卷/删卷/切工作区）④ selection 扩展（source 元信息）。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyDropZone,
  makeStrip,
  resetStripIdCounterForTests,
  STRIP_H_APPROX,
  STRIP_STASH_GAP,
  stashStripPosition,
} from '../src/paper/selection';
import {
  clearPaperSessions,
  getPaperSessionData,
  getPaperStore,
  loadPaperSessionData,
  removePaperSessionData,
  resetPaperStoresForTests,
} from '../src/state/paper-store';

const STORE = 'test-panel';

describe('paper-store 会话隔离', () => {
  beforeEach(() => {
    resetPaperStoresForTests();
    resetStripIdCounterForTests();
  });

  it('钉住坐标按会话隔离：setPinned 只写目标卷', () => {
    const st = getPaperStore(STORE).getState();
    st.setPinned('1', 'pb:m1:0', { x: 100, y: -200 });
    st.setPinned('2', 'pb:m1:0', { x: 999, y: -999 });

    expect(st.getPinned('1')).toEqual({ 'pb:m1:0': { x: 100, y: -200 } });
    expect(st.getPinned('2')).toEqual({ 'pb:m1:0': { x: 999, y: -999 } });
  });

  it('setPinned(null) = 收回：删除记录', () => {
    const st = getPaperStore(STORE).getState();
    st.setPinned('1', 'pb:a', { x: 1, y: 2 });
    st.setPinned('1', 'pb:a', null);
    expect(st.getPinned('1')).toEqual({});
  });

  it('纸条增/拖/删按会话隔离', () => {
    const st = getPaperStore(STORE).getState();
    const s1 = makeStrip('卷一纸条', 10, 10);
    const s2 = makeStrip('卷二纸条', 20, 20);
    st.addStrip('1', s1);
    st.addStrip('2', s2);

    expect(st.getStrips('1').map((s) => s.id)).toEqual([s1.id]);
    expect(st.getStrips('2').map((s) => s.id)).toEqual([s2.id]);

    st.moveStrip('1', s1.id, 500, -500);
    expect(st.getStrips('1')[0]).toMatchObject({ x: 500, y: -500 });

    st.removeStrip('1', s1.id);
    expect(st.getStrips('1')).toEqual([]);
    expect(st.getStrips('2')).toHaveLength(1); // 卷二不受影响
  });

  it('缺失会话返回稳定空引用（不产生新对象——防无谓重渲染）', () => {
    const st = getPaperStore(STORE).getState();
    expect(st.getPinned('nope')).toBe(st.getPinned('nope'));
    expect(st.getStrips('nope')).toBe(st.getStrips('nope'));
  });
});

describe('纸面持久化往返', () => {
  beforeEach(() => {
    resetPaperStoresForTests();
    resetStripIdCounterForTests();
  });

  it('getPaperSessionData → loadPaperSessionData 数据往返一致', () => {
    const st = getPaperStore(STORE).getState();
    st.setPinned('7', 'pb:m1:0', { x: 120, y: -340 });
    st.addStrip('7', makeStrip('一段引用', 300, -200));

    // 捕获（saveActiveSession 路径）
    const snapshot = getPaperSessionData(STORE, 7);
    expect(snapshot.pinned).toEqual({ 'pb:m1:0': { x: 120, y: -340 } });
    expect(snapshot.strips).toHaveLength(1);
    expect(snapshot.strips?.[0].text).toBe('一段引用');

    // 模拟重启：清内存 → 恢复（loadSessionFromDisk 路径）
    clearPaperSessions(STORE);
    expect(getPaperStore(STORE).getState().getPinned('7')).toEqual({});

    loadPaperSessionData(STORE, 7, snapshot);
    const restored = getPaperStore(STORE).getState();
    expect(restored.getPinned('7')).toEqual(snapshot.pinned);
    expect(restored.getStrips('7')).toEqual(snapshot.strips);
  });

  it('旧存档无 paper 字段（null）= 空纸面，不炸', () => {
    loadPaperSessionData(STORE, 9, null);
    const st = getPaperStore(STORE).getState();
    expect(st.getPinned('9')).toEqual({});
    expect(st.getStrips('9')).toEqual([]);
  });

  it('removePaperSessionData（合卷/删卷）只清目标卷', () => {
    const st = getPaperStore(STORE).getState();
    st.setPinned('1', 'pb:a', { x: 1, y: 1 });
    st.setPinned('2', 'pb:b', { x: 2, y: 2 });

    removePaperSessionData(STORE, 1);
    expect(st.getPinned('1')).toEqual({});
    expect(st.getPinned('2')).toEqual({ 'pb:b': { x: 2, y: 2 } });
  });

  it('clearPaperSessions（切工作区）清空全部', () => {
    const st = getPaperStore(STORE).getState();
    st.setPinned('1', 'pb:a', { x: 1, y: 1 });
    st.setPinned('2', 'pb:b', { x: 2, y: 2 });
    st.addStrip('1', makeStrip('t', 0, 0));

    clearPaperSessions(STORE);
    expect(st.getPinned('1')).toEqual({});
    expect(st.getPinned('2')).toEqual({});
    expect(st.getStrips('1')).toEqual([]);
    expect(st.activeSessionId).toBeNull();
  });
});

describe('makeStrip source 元信息（收尾 2026-08-24）', () => {
  beforeEach(() => resetStripIdCounterForTests());

  it('无 source：形状不变（向后兼容）', () => {
    const s = makeStrip('text', 1, 2);
    expect(s.source).toBeUndefined();
  });

  it('带 source：元信息随纸条持久化', () => {
    const s = makeStrip('text', 1, 2, 480, { messageId: 'm42' });
    expect(s.source).toEqual({ messageId: 'm42' });
    // JSON 往返（会话快照走 JSON.stringify）
    const back = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(back.source).toEqual({ messageId: 'm42' });
  });
});

/* ═══ 拖拽语义几何（收尾批 II：A+B 交互）═══ */

describe('classifyDropZone / stashStripPosition', () => {
  const BAND = 400; // 与 ANCHOR.bandHalfWidth 同值（纯函数测试字面量钉住）

  it('classifyDropZone：带内 flow / 带外 strip（含边界值）', () => {
    expect(classifyDropZone(0, BAND)).toBe('flow');
    expect(classifyDropZone(-400, BAND)).toBe('flow'); // 边界 = 带内
    expect(classifyDropZone(400.1, BAND)).toBe('strip');
    expect(classifyDropZone(-800, BAND)).toBe('strip');
  });

  it('stashStripPosition：空场落第一档（带右 + 边距），y 跟选区', () => {
    const pos = stashStripPosition(-500, [], BAND);
    expect(pos.x).toBe(BAND + STRIP_STASH_GAP);
    expect(pos.y).toBe(-500);
  });

  it('stashStripPosition：同档已占 → 向下叠放一档', () => {
    const first = stashStripPosition(-500, [], BAND);
    const second = stashStripPosition(-500, [{ x: first.x, y: first.y, w: 480 }], BAND);
    expect(second.x).toBe(first.x); // 同列
    expect(second.y).toBeGreaterThan(first.y); // 向下错开
    expect(second.y).toBeGreaterThanOrEqual(first.y + STRIP_H_APPROX); // 不重叠
  });

  it('stashStripPosition：异列纸条不挡（x 距离超纸条宽不算占用）', () => {
    const pos = stashStripPosition(-500, [{ x: firstStashX() + 600, y: -500, w: 480 }], BAND);
    expect(pos.y).toBe(-500); // 不叠放
    function firstStashX(): number {
      return BAND + STRIP_STASH_GAP;
    }
  });
});
