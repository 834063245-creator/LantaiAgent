// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷开合两窗（2026-10-18 卷开合动效批 · 用户拍板「甲 · 入场 + 退场对称」）——
// 纯函数考官。行为面（真实 PaperPanel 上「合卷当帧仍在 DOM + data-leaving、窗满才
// 卸载、重开卷重播落纸与墨律」）在 tests/paper-region-leave.test.tsx。
//
// 口径：
//   - **退场窗**：卷从 `regions` 消失的那一帧就要进窗（**不许晚一趟**——晚一趟 = 先拆
//     后挂，退场窗里重播入场，DockPanel 相位机 2026-10-16 那条实测病灶）；
//   - **落纸窗**：新出场的卷挂类**满一窗**才摘（单帧发类会被同帧后续重渲染摘掉 =
//     等于没发——2026-10-18 本批实测踩到的那一脚，是本模块存在的直接理由）；
//   - 首帧整批算「已落纸」（冷启动/恢复工作区不满屏淡入）；
//   - 两窗同长 = `REGION_MOTION_MS`（= `--m-sheet`，由 motion-contract 对拍）。

import { describe, expect, it } from 'vitest';
import {
  createRegionMotionWindow,
  REGION_MOTION_MS,
  stepRegionMotion,
} from '../src/plugins/builtin/paper-shell/region-motion';

/** 卷的最小形状（本模块对 view 是泛型的，只要求 sessionId）。 */
interface Vol {
  sessionId: string;
}
const vol = (sid: string): Vol => ({ sessionId: sid });
const sids = (m: Map<string, unknown>): string[] => [...m.keys()].sort();

describe('卷开合窗 · 退场窗', () => {
  it('消失的**那一帧**就进窗，且快照是消失当帧那一份原样（同一引用）', () => {
    const win = createRegionMotionWindow<Vol>();
    const last = vol('2');
    const first = stepRegionMotion(win, [vol('1'), last], 1000);
    expect(first.entered).toEqual([]);
    expect(win.leaving.size).toBe(0);

    const second = stepRegionMotion(win, [vol('1')], 1016);
    expect(second.entered.map((v) => v.sessionId)).toEqual(['2']);
    expect(second.entered[0]).toBe(last); // 冻结最后一帧，不重算
    expect(win.leaving.get('2')?.until).toBe(1016 + REGION_MOTION_MS);
  });

  it('窗内重开 = 撤销退场（不进窗、不回报 entered）', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1')], 0);
    stepRegionMotion(win, [], 10);
    expect(win.leaving.has('1')).toBe(true);

    const back = stepRegionMotion(win, [vol('1')], 100);
    expect(win.leaving.has('1')).toBe(false);
    expect(back.entered).toEqual([]);
  });

  it('窗满摘除；未满的继续计时（nextExpiry = 最早到期时刻）', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('a')], 0);
    stepRegionMotion(win, [], 1000); // a 进窗 → until 1260
    stepRegionMotion(win, [], 1240);
    expect(sids(win.leaving)).toEqual(['a']);
    expect(stepRegionMotion(win, [], 1240).nextExpiry).toBe(1260);
    const past = stepRegionMotion(win, [], 1260);
    expect(win.leaving.size).toBe(0);
    expect(past.nextExpiry).toBeNull();
  });

  it('多个卷同一帧消失：各自独立计时，entered 全回报', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('x'), vol('y'), vol('z')], 500);
    const { entered } = stepRegionMotion(win, [vol('y')], 516);
    expect(entered.map((v) => v.sessionId).sort()).toEqual(['x', 'z']);
    expect(win.leaving.get('x')?.until).toBe(516 + REGION_MOTION_MS);
  });
});

describe('卷开合窗 · 落纸窗', () => {
  it('首帧整批算「已落纸」（冷启动不满屏淡入）；此后新出场的卷才开窗', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1'), vol('2')], 0);
    expect(win.spread.size).toBe(0); // 首帧：整批已落纸

    stepRegionMotion(win, [vol('1'), vol('2'), vol('3')], 500);
    expect(sids(win.spread)).toEqual(['3']);
    expect(win.spread.get('3')).toBe(500 + REGION_MOTION_MS);
  });

  it('窗满才摘（**不是**发一帧就摘）：窗内多次重渲染/re-step 类都在', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1')], 0);
    const born = stepRegionMotion(win, [vol('1'), vol('2')], 100);
    expect(sids(win.spread)).toEqual(['2']);

    // 同帧后续那几趟重渲染（落位/焦点/测高回写都在同一批 commit 里）
    for (const t of [104, 110, 140, 200]) {
      stepRegionMotion(win, [vol('1'), vol('2')], t);
      expect(win.spread.has('2'), `t=${t} 落纸类不该被中途摘掉`).toBe(true);
    }
    expect(born.nextExpiry).toBe(100 + REGION_MOTION_MS);

    // 窗满 → 摘，且摘后再 step 不会重开（同一卷不会二次落纸）
    stepRegionMotion(win, [vol('1'), vol('2')], 100 + REGION_MOTION_MS);
    expect(win.spread.has('2')).toBe(false);
    stepRegionMotion(win, [vol('1'), vol('2')], 100 + REGION_MOTION_MS + 16);
    expect(win.spread.has('2')).toBe(false);
  });

  it('窗内合卷再重开：落纸窗仍在（纸平平地淡回来，不重播一次完整落纸）', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1')], 0);
    stepRegionMotion(win, [vol('1'), vol('2')], 100); // 2 落纸（until 360）
    stepRegionMotion(win, [vol('1')], 200); // 2 进退场窗
    const back = stepRegionMotion(win, [vol('1'), vol('2')], 260); // 半路掉头
    expect(win.leaving.has('2')).toBe(false);
    expect(win.spread.has('2')).toBe(true);
    expect(back.entered).toEqual([]);
  });

  it('两窗同长、nextExpiry 取两窗最早（落纸窗也能驱动重渲染）', () => {
    const win = createRegionMotionWindow<Vol>();
    expect(REGION_MOTION_MS).toBe(260);
    stepRegionMotion(win, [vol('1')], 0);
    // 500：卷 2 落纸（until 760）；600：卷 1 退场（until 860）
    stepRegionMotion(win, [vol('1'), vol('2')], 500);
    const r = stepRegionMotion(win, [vol('2')], 600);
    expect(r.nextExpiry).toBe(760);
    const r2 = stepRegionMotion(win, [vol('2')], 760);
    expect(r2.nextExpiry).toBe(860);
  });
});
