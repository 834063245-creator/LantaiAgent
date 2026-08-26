// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Stage-4 §4.1 自动选中地基：视口中心命中 + 三道闸停留控制器。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSettleSelector,
  hitRegionAtWorld,
  type RegionHitRect,
  viewportCenterWorld,
} from '../src/paper/active-region';
import { identityView } from '../src/paper/canvas-math';

const REGIONS: RegionHitRect[] = [
  { sessionId: '1', x0: -720, x1: 720, y0: -1000, y1: 0 },
  { sessionId: '2', x0: 1440, x1: 2880, y0: -800, y1: 0 },
];

describe('paper/active-region 命中判定', () => {
  it('视口中心（世界）命中所在流区', () => {
    const v = identityView();
    expect(viewportCenterWorld(v, 1600, 900)).toEqual({ x: 800, y: 450 });
    // 中心落在流区 1 内
    expect(hitRegionAtWorld(0, -100, REGIONS)).toBe('1');
    expect(hitRegionAtWorld(2000, -200, REGIONS)).toBe('2');
  });

  it('空白（流区间隙/流区外）返回 null——保持当前', () => {
    expect(hitRegionAtWorld(1000, -300, REGIONS)).toBeNull(); // 两区间隙
    expect(hitRegionAtWorld(0, 100, REGIONS)).toBeNull(); // 流区底（内容区）之下
    expect(hitRegionAtWorld(0, -2000, REGIONS)).toBeNull(); // 流区顶之上
  });
});

describe('paper/active-region 三道闸停留控制器', () => {
  let onChange: ReturnType<typeof vi.fn>;
  let timers: Array<ReturnType<typeof setTimeout>>;
  let fakeSet: ReturnType<typeof vi.fn>;
  let fakeClear: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
    timers = [];
    fakeSet = vi.fn((fn: () => void) => {
      const id = setTimeout(fn, 400) as unknown as ReturnType<typeof setTimeout>;
      timers.push(id);
      return id;
    });
    fakeClear = vi.fn((id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  });
  afterEach(() => {
    for (const t of timers) clearTimeout(t);
  });

  function boot() {
    return createSettleSelector({
      delayMs: 400,
      onChange,
      setTimeoutFn: fakeSet,
      clearTimeoutFn: fakeClear,
    });
  }

  it('视口停住 + 中心落流区 + 连续停留 400ms 才切', () => {
    vi.useFakeTimers();
    try {
      const sel = boot();
      sel.push('1', false);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      expect(onChange).toHaveBeenCalledWith('1');
      sel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('平移中不判（moving=true 取消在途计时）', () => {
    vi.useFakeTimers();
    try {
      const sel = boot();
      sel.push('1', false);
      vi.advanceTimersByTime(200);
      sel.push('2', true); // 开始平移
      vi.advanceTimersByTime(400);
      expect(onChange).not.toHaveBeenCalled();
      sel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('中心点空白保持当前（不切、不启动计时）', () => {
    vi.useFakeTimers();
    try {
      const sel = boot();
      sel.push('1', false);
      vi.advanceTimersByTime(100);
      sel.push(null, false);
      vi.advanceTimersByTime(400);
      expect(onChange).not.toHaveBeenCalled();
      sel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一 pending 连续停留不重计；落定后再次命中同区不再触发', () => {
    vi.useFakeTimers();
    try {
      const sel = boot();
      sel.push('1', false);
      vi.advanceTimersByTime(100);
      sel.push('1', false); // 同 pending：计时继续
      vi.advanceTimersByTime(300);
      expect(onChange).toHaveBeenCalledTimes(1);
      // 落定后视口仍停在同一区：不再触发
      sel.push('1', false);
      vi.advanceTimersByTime(1000);
      expect(onChange).toHaveBeenCalledTimes(1);
      sel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopt 同步显式切换：防自动选中立刻拉回', () => {
    vi.useFakeTimers();
    try {
      const sel = boot();
      sel.adopt('1');
      sel.push('1', false);
      vi.advanceTimersByTime(400);
      expect(onChange).not.toHaveBeenCalled(); // 1 已是显式落定值
      // 换到 2 仍可自动选中
      sel.push('2', false);
      vi.advanceTimersByTime(400);
      expect(onChange).toHaveBeenCalledWith('2');
      sel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
