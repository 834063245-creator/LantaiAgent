// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 边缘滚动子系统·策略读面（2026-09-17 立为原生功能）——纯函数考官：
// 设置字段 → 调参（缺省容错 / 毒化夹取 / 灵敏度映射）。
// 行为面（开关生效、灵敏度改带宽、三族手势接入）在
// tests/paper-viewport-ux.test.tsx；设置面板写面在
// tests/ui/settings-panel-save-split.test.ts。

import { describe, expect, it } from 'vitest';
import { clampSensitivity, EDGE_SCROLL, edgeScrollTuning } from '../src/plugins/builtin/paper-shell/edge-scroll';
import type { AppSettings } from '../src/settings';

/** 只给本域关心的字段（其余用最小骨架——被测函数只读 canvas.edgeScroll）。 */
function settingsWith(canvas: AppSettings['canvas']): AppSettings {
  return { canvas } as AppSettings;
}

describe('边缘滚动·策略读面', () => {
  it('缺省：旧存储无 canvas / 无 edgeScroll 字段 = 开 + 基准灵敏度', () => {
    const base = edgeScrollTuning(settingsWith(undefined));
    expect(base.enabled).toBe(true);
    expect(base.band).toBe(EDGE_SCROLL.band);
    expect(base.maxSpeed).toBe(EDGE_SCROLL.maxSpeed);
    expect(edgeScrollTuning(settingsWith({ wheelMode: 'pan' }))).toEqual(base);
    // 只缺 sensitivity（半旧存储）
    expect(
      edgeScrollTuning(settingsWith({ wheelMode: 'pan', edgeScroll: { enabled: true, sensitivity: NaN } })),
    ).toEqual(base);
  });

  it('开关：enabled=false 即关（关掉后曲线参数不再被消费）', () => {
    expect(
      edgeScrollTuning(settingsWith({ wheelMode: 'pan', edgeScroll: { enabled: false, sensitivity: 1 } })).enabled,
    ).toBe(false);
    // 非布尔毒化值一律按「开」处理（宁可开，不可静默失效）
    expect(
      edgeScrollTuning(
        settingsWith({ wheelMode: 'pan', edgeScroll: { enabled: 'no' as unknown as boolean, sensitivity: 1 } }),
      ).enabled,
    ).toBe(true);
  });

  it('灵敏度映射：滚速线性、带宽温和同向（√），两端夹取', () => {
    const t = (sensitivity: number): { band: number; maxSpeed: number } => {
      const r = edgeScrollTuning(settingsWith({ wheelMode: 'pan', edgeScroll: { enabled: true, sensitivity } }));
      return { band: r.band, maxSpeed: r.maxSpeed };
    };
    expect(t(1)).toEqual({ band: EDGE_SCROLL.band, maxSpeed: EDGE_SCROLL.maxSpeed });
    expect(t(2)).toEqual({ band: Math.round(EDGE_SCROLL.band * Math.SQRT2), maxSpeed: EDGE_SCROLL.maxSpeed * 2 });
    expect(t(0.5).maxSpeed).toBe(EDGE_SCROLL.maxSpeed * 0.5);
    expect(t(0.5).band).toBeLessThan(EDGE_SCROLL.band); // 越弱 = 越晚起滚
    // 越界与毒化值夹取到区间（不静默给 0——0 = 功能静默消失）
    expect(t(99).maxSpeed).toBe(EDGE_SCROLL.maxSpeed * EDGE_SCROLL.sensMax);
    expect(t(-5).maxSpeed).toBe(EDGE_SCROLL.maxSpeed * EDGE_SCROLL.sensMin);
    expect(clampSensitivity('x')).toBe(EDGE_SCROLL.sensDefault);
    expect(clampSensitivity(undefined)).toBe(EDGE_SCROLL.sensDefault);
  });
});
