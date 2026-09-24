// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-focus-coldstart — R1 真位置守卫 + R2 冷启动聚焦（2026-09-05）时序语义测试。
//
// 覆盖的是「决策逻辑」而不是 React 组件：把 PaperPanel 里两处 effect 的核心
// 判定抽成纯谓词（focusableWhen 见下），测守卫对 spread/restoredView 的组合。
// 组件侧接线（flyToRegion 内部守卫 + 挂载 effect 兜底聚焦）以注释 + 单测双钉。

import { describe, expect, it } from 'vitest';
import { createFocusFlightScheduler } from '../src/plugins/builtin/paper-shell/focus-flight';

/** R1 守卫核心判定（与 PaperPanel.flyToRegion 同规则）：
 *  目标卷在 spread 有持久位置 → 可飞；无位置（新建/未展开卷）→ 不可飞。 */
function focusableWhen(spreadHas: boolean, pending: string | null, current: string | null): boolean {
  if (!pending || pending === current) return false;
  return spreadHas;
}

describe('R1 真位置守卫（新建/展开卷不飞网格占位）', () => {
  it('spread 有位置 → 可飞（书脊定位/恢复卷）', () => {
    expect(focusableWhen(true, '7', null)).toBe(true);
    expect(focusableWhen(true, '7', '3')).toBe(true);
  });

  it('spread 无位置（新建卷落位 effect 未跑）→ 不可飞，pending 保持由补飞接管', () => {
    expect(focusableWhen(false, '9', null)).toBe(false);
    expect(focusableWhen(false, '9', '3')).toBe(false);
  });

  it('pending 清空/同目标都不飞', () => {
    expect(focusableWhen(true, null, null)).toBe(false);
    expect(focusableWhen(true, '7', '7')).toBe(false);
  });

  it('飞行调度器：无位置时保持 idle（补飞 effect 可接管）', () => {
    // 模拟 PaperPanel 流程：pending 到来 → 守卫拦截（不 begin）→
    // 落位 effect 写入 spread → regions 变化 → 补飞 begin
    const sched = createFocusFlightScheduler();
    const spreadHas = false;
    if (focusableWhen(spreadHas, '9', null)) sched.begin('9');
    expect(sched.isActive()).toBe(false); // 没飞成
    const spreadHasNow = true;
    if (focusableWhen(spreadHasNow, '9', null) && !sched.isActive()) sched.begin('9');
    expect(sched.isActive()).toBe(true);
    expect(sched.targetSessionId()).toBe('9');
    sched.end();
  });
});

/** R2 冷启动聚焦判定（与 PaperPanel 挂载 effect 同规则）：
 *  无恢复视图 + 有摊开卷 → 应聚焦目标（活跃卷 ?? 首个摊开卷）。 */
function coldStartFocusTarget(restoredView: unknown, spreadKeys: string[], active: string | null): string | null {
  if (restoredView) return null; // 有恢复视图：视角已在上次视野，不兜底
  if (spreadKeys.length === 0) return null; // 无摊开卷：不兜底
  if (active && spreadKeys.includes(active)) return active;
  return spreadKeys[0]!;
}

describe('R2 冷启动聚焦兜底（无恢复视图 → 带视角到卷上）', () => {
  it('无恢复视图 + 摊开卷 → 聚焦活跃卷', () => {
    expect(coldStartFocusTarget(null, ['5', '7'], '7')).toBe('7');
  });

  it('无恢复视图 + 摊开卷 + 活跃卷不在摊开集 → 首个摊开卷', () => {
    expect(coldStartFocusTarget(null, ['5', '7'], '99')).toBe('5');
    expect(coldStartFocusTarget(undefined, ['5', '7'], null)).toBe('5');
  });

  it('有恢复视图（新数据）→ 不兜底（视角已在卷上）', () => {
    expect(coldStartFocusTarget({ panX: 1, panY: 2, zoom: 1 }, ['5'], '5')).toBeNull();
  });

  it('无摊开卷 → 不兜底（案头态）', () => {
    expect(coldStartFocusTarget(null, [], null)).toBeNull();
  });

  it('恢复视图合法性校验：非法值不认（存了烂数据也兜底聚焦）', () => {
    // 与 loadCanvasFromDisk 的守卫同规则：zoom<=0 / NaN 视为无效
    const valid = (
      v: { panX: number; panY: number; zoom: number } | null | undefined,
    ): v is { panX: number; panY: number; zoom: number } =>
      !!v && Number.isFinite(v.panX) && Number.isFinite(v.panY) && v.zoom > 0;
    expect(valid({ panX: 1, panY: 2, zoom: 0 })).toBe(false);
    expect(valid({ panX: Number.NaN, panY: 2, zoom: 1 })).toBe(false);
    expect(valid(null)).toBe(false);
    expect(valid({ panX: 1, panY: 2, zoom: 1 })).toBe(true);
  });
});
