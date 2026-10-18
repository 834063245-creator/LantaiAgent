// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷开合两窗（2026-10-18 卷开合动效批 · 用户拍板「甲 · 入场 + 退场对称」）——
// 纯函数考官。行为面（真实 PaperPanel 上「合卷当帧仍在 DOM + data-leaving、窗满才
// 卸载、重开卷重播落纸与墨律」）在 tests/paper-region-leave.test.tsx。
//
// 口径：
//   - **退场窗**：卷从 `regions` 消失的那一帧就要进窗（**不许晚一趟**——晚一趟 = 先拆
//     后挂，退场窗里重播入场，DockPanel 相位机 2026-10-16 那条实测病灶）；
//   - **落纸窗**：判据是「首次**可见**」（不是「首次活跃」）——开卷带着 260ms 视角飞行，
//     远卷落地时不在视口里，按「活跃」发类会在屏外播完（2026-10-18 实机反馈
//     「动效不太明显」的第一因）；且挂类**满一窗**才摘（按帧发会被同帧后续重渲染摘掉
//     = 浏览器根本没见到那个类）；
//   - 首帧那批量算「已落纸」（冷启动/恢复工作区不满屏淡入；恢复是异步的，故空首帧不
//     prime，等第一批真数据）；
//   - 两窗同长 = `REGION_MOTION_MS`（= `--m-sheet`，由 motion-contract 对拍）。

import { describe, expect, it } from 'vitest';
import {
  createRegionMotionWindow,
  REGION_MOTION_MS,
  regionOnScreen,
  stepRegionMotion,
} from '../src/plugins/builtin/paper-shell/region-motion';

/** 卷的最小形状（本模块对 view 是泛型的，只要求 sessionId）。 */
interface Vol {
  sessionId: string;
}
const vol = (sid: string): Vol => ({ sessionId: sid });
const sids = (m: Map<string, unknown>): string[] => [...m.keys()].sort();
/** 视口内集合（缺省 = 全在视口里，考退场窗时不必逐条写）。 */
const all = (...ids: string[]): Set<string> => new Set(ids);

describe('卷开合窗 · 退场窗', () => {
  it('消失的**那一帧**就进窗，且快照是消失当帧那一份原样（同一引用）', () => {
    const win = createRegionMotionWindow<Vol>();
    const last = vol('2');
    const first = stepRegionMotion(win, [vol('1'), last], all('1', '2'), 1000);
    expect(first.entered).toEqual([]);
    expect(win.leaving.size).toBe(0);

    const second = stepRegionMotion(win, [vol('1')], all('1'), 1016);
    expect(second.entered.map((v) => v.sessionId)).toEqual(['2']);
    expect(second.entered[0]).toBe(last); // 冻结最后一帧，不重算
    expect(win.leaving.get('2')?.until).toBe(1016 + REGION_MOTION_MS);
  });

  it('窗内重开 = 撤销退场（不进窗、不回报 entered）', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1')], all('1'), 0);
    stepRegionMotion(win, [], all(), 10);
    expect(win.leaving.has('1')).toBe(true);

    const back = stepRegionMotion(win, [vol('1')], all('1'), 100);
    expect(win.leaving.has('1')).toBe(false);
    expect(back.entered).toEqual([]);
  });

  it('窗满摘除；未满的继续计时（nextExpiry = 最早到期时刻）', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('a')], all('a'), 0);
    stepRegionMotion(win, [], all(), 1000); // a 进窗 → until 1260
    stepRegionMotion(win, [], all(), 1240);
    expect(sids(win.leaving)).toEqual(['a']);
    expect(stepRegionMotion(win, [], all(), 1240).nextExpiry).toBe(1260);
    const past = stepRegionMotion(win, [], all(), 1260);
    expect(win.leaving.size).toBe(0);
    expect(past.nextExpiry).toBeNull();
  });

  it('多个卷同一帧消失：各自独立计时，entered 全回报', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('x'), vol('y'), vol('z')], all('x', 'y', 'z'), 500);
    const { entered } = stepRegionMotion(win, [vol('y')], all('y'), 516);
    expect(entered.map((v) => v.sessionId).sort()).toEqual(['x', 'z']);
    expect(win.leaving.get('x')?.until).toBe(516 + REGION_MOTION_MS);
  });
});

describe('卷开合窗 · 落纸窗（首次可见）', () => {
  it('首帧整批算「已落纸」（冷启动不满屏淡入）；此后新出场且可见的卷才开窗', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), 0);
    expect(win.spread.size).toBe(0); // 首帧：整批已落纸

    stepRegionMotion(win, [vol('1'), vol('2'), vol('3')], all('1', '2', '3'), 500);
    expect(sids(win.spread)).toEqual(['3']);
    expect(win.spread.get('3')).toBe(500 + REGION_MOTION_MS);
  });

  it('空首帧不 prime：恢复是异步的，第一批**真数据**才算「已落纸」', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [], all(), 0); // 挂载首帧：sess 还没恢复
    expect(win.primed).toBe(false);
    stepRegionMotion(win, [vol('1')], all('1'), 40); // 恢复到位 —— 算已落纸，不放动画
    expect(win.primed).toBe(true);
    expect(win.spread.size).toBe(0);
  });

  it('**屏外摊开不播**；镜头带到它（首次可见）那一帧才起手', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1')], all('1'), 0);
    // 用户点了「已合卷」里的一卷：卷进 live，但还在屏外（视角正在飞过去）
    const off = stepRegionMotion(win, [vol('1'), vol('2')], all('1'), 100);
    expect(win.spread.size, '屏外不该发落纸类（否则会在屏外播完）').toBe(0);
    expect(off.nextExpiry).toBeNull();
    // 260ms 飞行途中/结束，卷首次进视口 → 此刻才起手
    stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), 360);
    expect(sids(win.spread)).toEqual(['2']);
    expect(win.spread.get('2')).toBe(360 + REGION_MOTION_MS);
  });

  it('窗满才摘（**不是**发一帧就摘）：窗内多次重渲染类都在；摘后不二次落纸', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1')], all('1'), 0);
    const born = stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), 100);
    expect(sids(win.spread)).toEqual(['2']);

    // 同帧后续那几趟重渲染（落位/焦点/测高回写都在同一批 commit 里）
    for (const t of [104, 110, 140, 200]) {
      stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), t);
      expect(win.spread.has('2'), `t=${t} 落纸类不该被中途摘掉`).toBe(true);
    }
    expect(born.nextExpiry).toBe(100 + REGION_MOTION_MS);

    stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), 100 + REGION_MOTION_MS);
    expect(win.spread.has('2')).toBe(false);
    stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), 100 + REGION_MOTION_MS + 16);
    expect(win.spread.has('2')).toBe(false);
  });

  it('已落过纸的卷滚出视口再回来：**不重播**（否则平移时纸面反复凭空浮现）', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1')], all('1'), 0); // 冷启动：1 已落纸
    stepRegionMotion(win, [vol('1')], all(), 100); // 滚出视口
    stepRegionMotion(win, [vol('1')], all('1'), 200); // 滚回来
    expect(win.spread.size).toBe(0);
  });

  it('合卷离开 ⇒ 清「已落纸」⇒ 重开（再次可见）重播', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), 0);
    stepRegionMotion(win, [vol('1')], all('1'), 100); // 2 合卷
    expect(win.played.has('2')).toBe(false);
    stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), 900); // 重开且可见
    expect(sids(win.spread)).toEqual(['2']);
  });

  it('窗内合卷再重开：退场撤销（不重挂）且落纸窗仍在——纸平平地淡回来', () => {
    const win = createRegionMotionWindow<Vol>();
    stepRegionMotion(win, [vol('1')], all('1'), 0);
    stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), 100); // 2 落纸（until 360）
    stepRegionMotion(win, [vol('1')], all('1'), 200); // 2 进退场窗
    const back = stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), 260); // 半路掉头
    expect(win.leaving.has('2')).toBe(false);
    expect(win.spread.has('2')).toBe(true);
    expect(back.entered).toEqual([]);
  });
});

describe('卷开合窗 · 可见判据与两窗共同计时', () => {
  it('regionOnScreen：纵向重叠才可见（横向由 visibleRegionIds 管）', () => {
    // 卷世界 y ∈ [1000, 3000]，视口 y ∈ [0, 800] ⇒ 不重叠
    expect(regionOnScreen(1000, 3000, 0, 800)).toBe(false);
    // 视口下移到位 ⇒ 重叠
    expect(regionOnScreen(1000, 3000, 900, 1700)).toBe(true);
    // 视口在卷内部（卷很大、只看到一段）⇒ 仍算可见
    expect(regionOnScreen(1000, 3000, 1500, 2300)).toBe(true);
    // 边界相接算可见（闭区间）
    expect(regionOnScreen(1000, 3000, 3000, 3800)).toBe(true);
  });

  it('两窗同长、nextExpiry 取两窗最早（落纸窗也能驱动重渲染）', () => {
    const win = createRegionMotionWindow<Vol>();
    expect(REGION_MOTION_MS).toBe(260);
    stepRegionMotion(win, [vol('1')], all('1'), 0);
    // 500：卷 2 落纸（until 760）；600：卷 1 退场（until 860）
    stepRegionMotion(win, [vol('1'), vol('2')], all('1', '2'), 500);
    const r = stepRegionMotion(win, [vol('2')], all('2'), 600);
    expect(r.nextExpiry).toBe(760);
    const r2 = stepRegionMotion(win, [vol('2')], all('2'), 760);
    expect(r2.nextExpiry).toBe(860);
  });
});
