// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 压缩触发线：窗口 − 输出预留 − headroom（2026-11-19 对齐 DSH resolveCompactSpec）。
//
// 旧行为：触发线 = W × compactRatio。它漏了「这一次请求还要写多少」——响应输出与
// 输入共用同一个上限，长输出撞上「已用 79% 的提示」时提供方直接 400，而不是优雅
// 截断。1M 窗口/50% 占用的卷碰不到这条线，但小窗口 + 长输出的卷会：那时压缩来不及
// 在 400 之前动手。
//
// 新行为：生效比例 = min(W × ratio, W − 预留 − headroom) / W。**两项都随窗口缩放**
// （预留 ≤ W/4，headroom ≤ W/8）：常量直接套小窗口会把触发线压到 3%，那会让 pre-flight
// 每步都压、下一步无内容可折叠 → stuck（实测 50K 窗口 + 32K 预留即此形态）。
//
// 断言一律从公式算期望值，不手抄比例——手抄的 0.76 会因为常量调一格而全红。

import { describe, expect, it } from 'vitest';
import {
  effectiveCompactRatio,
  COMPACT_HEADROOM_TOKENS as H,
  COMPACT_OUTPUT_RESERVE_TOKENS as R,
} from '../src/agent/compaction-contract';

/** 公式的独立复算（含随窗口缩放的钳制）。 */
const expectRatio = (W: number, r: number, o: number) => {
  const reserve = Math.min(Math.max(0, o), Math.floor(W / 4));
  const headroom = Math.min(H, Math.floor(W / 8));
  return Math.min(W * r, W - reserve - headroom) / W;
};

describe('压缩触发线：输出预留与 headroom', () => {
  it('窗口未知（0）不钳制——返回配置档位本身', () => {
    expect(effectiveCompactRatio(0, 0.8, R)).toBe(0.8);
  });

  it('大窗口：仍以配置档位为准（今天 1M 窗口的真实情形，行为零变更）', () => {
    expect(effectiveCompactRatio(1_000_000, 0.8, R)).toBeCloseTo(0.8, 6);
    expect(effectiveCompactRatio(1_000_000, 0.85, R)).toBeCloseTo(0.85, 6);
  });

  it('中等窗口：被 W − 预留 − headroom 压下来（提前触发，赶在 400 之前）', () => {
    const v = effectiveCompactRatio(200_000, 0.8, R);
    expect(v).toBeCloseTo(expectRatio(200_000, 0.8, R), 6);
    expect(v).toBeLessThan(0.8); // 确实被压下来了
  });

  it('预留越大越早触发（同一窗口下单调）', () => {
    const small = effectiveCompactRatio(200_000, 0.8, 8_000);
    const large = effectiveCompactRatio(200_000, 0.8, 40_000);
    expect(large).toBeLessThan(small);
    expect(large).toBeCloseTo(expectRatio(200_000, 0.8, 40_000), 6);
  });

  it('小窗口：预留与 headroom 一起按比例缩，触发线不会掉到荒谬低位', () => {
    // 50K：预留夹到 12.5K、headroom 夹到 6.25K ⇒ 触发线 62.5%（而非 3%）
    const v = effectiveCompactRatio(50_000, 0.8, R);
    expect(v).toBeCloseTo(0.625, 6);
    expect(v).toBeGreaterThan(0.5); // 绝不掉到「每步都压」
  });

  it('恒 > 0 且 ≤ 1 —— 任何合法窗口下都不会退化成「恒触发」', () => {
    for (const w of [1_000, 16_000, 40_000, 64_000, 128_000, 200_000, 1_000_000]) {
      for (const r of [0.7, 0.8, 0.85]) {
        const v = effectiveCompactRatio(w, r, R);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
