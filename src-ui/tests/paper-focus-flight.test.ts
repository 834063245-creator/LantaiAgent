// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/focus-flight — 焦点飞行调度（2026-08-31 视口乱飞修复）。
// 用户操作序列形态：书脊/侧边栏定位、新建会话、expand 落定补飞的时序，
// 断言「同目标动画在途不重播」（regions 每帧打扰被吞）且「结束可再飞」。

import { describe, expect, it } from 'vitest';
import { createFocusFlightScheduler } from '../src/paper/focus-flight';

describe('paper/focus-flight — 焦点飞行调度（视口乱飞修复）', () => {
  it('书脊定位：空闲启动 = started；动画在途的同目标重播 = rejected（自锁消除）', () => {
    const s = createFocusFlightScheduler();
    // 点书脊卷 2 → requestFocus('2') → 补飞启动动画
    expect(s.begin('2')).toBe('started');
    expect(s.isActive()).toBe(true);
    expect(s.targetSessionId()).toBe('2');
    // 动画在途：regions 每帧换引用触发补飞 → 同目标重播被吞，动画不被打断
    expect(s.begin('2')).toBe('rejected');
    expect(s.isActive()).toBe(true);
  });

  it('动画在途连点另一卷 = superseded（玩家明确切卷允许取代）', () => {
    const s = createFocusFlightScheduler();
    s.begin('2');
    expect(s.begin('3')).toBe('superseded');
    expect(s.targetSessionId()).toBe('3');
    expect(s.isActive()).toBe(true);
  });

  it('glide 浏览在途（无目标）时卷定位到达 = superseded（定位优先于浏览）', () => {
    const s = createFocusFlightScheduler();
    expect(s.begin(null)).toBe('started'); // 小地图 glide 跳转启动
    expect(s.begin('5')).toBe('superseded'); // 书脊定位卷 5 取代浏览动画
    expect(s.targetSessionId()).toBe('5');
  });

  it('动画完成 end 归位：pending 未清时补飞合法（expand 落定后再飞一次）', () => {
    const s = createFocusFlightScheduler();
    s.begin('2');
    s.end(); // 动画完成（flyToPoint 完成分支）
    expect(s.isActive()).toBe(false);
    expect(s.targetSessionId()).toBeNull();
    // expand 落定瞬间 regions 变化 → 补飞检查 → 空闲可再飞
    expect(s.begin('2')).toBe('started');
  });

  it('动画中断 end：滚轮/拖拽接管后，同卷可重新定位（不再被 rejected 卡死）', () => {
    const s = createFocusFlightScheduler();
    s.begin('2');
    // 用户滚轮接管视口：cancel 动画 + requestFocus(null)——取消点必须 end()
    s.end();
    expect(s.isActive()).toBe(false);
    expect(s.begin('2')).toBe('started');
  });
});
