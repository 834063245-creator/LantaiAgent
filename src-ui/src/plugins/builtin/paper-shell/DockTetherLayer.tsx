// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DockTetherLayer — 匣脚引线的**渲染面**（2026-11-19 手感批：坞高变化时线不许跳）。
//
// 为什么单独立件：缓动必须逐帧 setState，而渲染点原住在 PaperPanel（大组件——平移 /
// 缩放每帧都在重渲）。把「每帧重渲」关进这三个 SVG 元素的组件里，画布主体零成本。
//
// 两条判据（各记理由）：
//   · `dragging` 时缓动时长 = 0：拖动坞必须跟手，线滞后于匣就读作「线掉了」；
//   · 只有**坞侧**锚点缓动，卷侧（纸脚）逐帧即时：纸在动而线拖尾 = 指不准。
//
// 坞高变化的三条来路（用户 2026-11-19 报的「生硬」）：输入框换行 / 附件行出现 /
// 墨量册展开——它们都把坞顶线（从而把版口钮锚点）整个抬起来，旧实现里线的两端
// 同一帧换成新坐标，读作「闪了一下」。180ms 的 easeOut 足够读成一次移动。

import { useEffect, useMemo, useRef, useState } from 'react';
import { DOCK_TETHER_PEN } from './dock-tether';
import { tetherPath } from './provenance';

/** 坞侧锚点缓动时长（ms）：比坞自身入场（260ms）短一档——线是跟随者，不是主角。 */
const EASE_MS = 180;

export interface DockTetherGeometry {
  /** 坞侧锚点（屏幕坐标；坞顶左端版口钮起端中点）。 */
  from: { x: number; y: number };
  /** 卷侧锚点（屏幕坐标；活卷纸脚）。 */
  to: { x: number; y: number };
  /** 定种子（同卷恒同线、平移不闪）。 */
  seed: number;
  /** 拖动中（= 跟手，不缓动）。 */
  dragging: boolean;
  /** 坞实测高——缓动的唯一触发信号：**只有它变了**（匣长高）才值得交代；
   *  坞位变化 / 首次实测落位一律即时（见 hook 头注）。 */
  dockHeight: number;
}

export function DockTetherLayer({ geom }: { geom: DockTetherGeometry }) {
  const from = useSmoothAnchor(geom.from, geom.dockHeight, geom.dragging ? 0 : EASE_MS);
  const art = useMemo(() => tetherPath(from, geom.to, geom.seed, DOCK_TETHER_PEN), [from, geom.to, geom.seed]);
  return (
    <svg className="pp-tether-layer pp-dock-layer" aria-hidden="true">
      <path className="pp-tether pp-dock-tether" d={art.d} />
      <circle className="pp-tether-origin" cx={art.origin.x} cy={art.origin.y} r={2.2} />
      <circle className="pp-tether-bead" cx={art.bead.x} cy={art.bead.y} r={2.2} />
    </svg>
  );
}

/** 坞侧锚点缓动。触发条件只有一条：**坞实测高变了**（匣长高 / 收短）且横向没动。
 *
 *  为什么这么窄（2026-11-19 实测两版）：第一版按「y 变了就缓动」，于是**首次实测落位**
 *  （坞从屏心量到真位置）也被缓动——线上的起笔点从屏心飞过去；第二版按「x 没变才缓动」
 *  仍会吃掉窗口 resize 那一档。真正常见的、值得交代的只有「内容态把匣顶抬起来」这一种，
 *  其余（拖动 / 吸附 / 首次落位 / 窗口变化）一律即时——位置类变化缓动 = 线追不上匣。 */
function useSmoothAnchor(target: { x: number; y: number }, dockHeight: number, ms: number): { x: number; y: number } {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const rafRef = useRef(0);
  const prevH = useRef(dockHeight);
  const { x: tx, y: ty } = target;
  useEffect(() => {
    const from = shownRef.current;
    const prevHeight = prevH.current;
    const heightChanged = Math.abs(dockHeight - prevHeight) >= 0.5;
    prevH.current = dockHeight;
    const xMoved = Math.abs(from.x - tx) >= 0.5;
    /* 只有「匣长高 + 横向没动 + 已量到过真高 + 时长 > 0 + 有 rAF」才走缓动，其余全部即时。
     * `prevHeight <= 0` 是**首次实测**（RO 第一次把坞量出来）——那一次落位不是内容态。 */
    const instant = !heightChanged || prevHeight <= 0 || xMoved || ms <= 0 || !Number.isFinite(ty);
    if (instant || typeof window.requestAnimationFrame !== 'function') {
      shownRef.current = { x: tx, y: ty };
      setShown(shownRef.current);
      return;
    }
    const t0 = performance.now();
    /* 时间基准以 `performance.now()` 为准，**不读 rAF 回调参数**（2026-11-19 实测：
     * 部分环境 / 桩把 0 或另一个基准递进来，差值成负 ⇒ 缓动系数负数 ⇒ 线被推到
     * 几十万像素外。k 再夹到 [0,1]，任何基准都能落回「从起点走到终点」）。 */
    const tick = () => {
      const k = Math.min(1, Math.max(0, (performance.now() - t0) / ms));
      const e = 1 - (1 - k) ** 3;
      const next = { x: tx, y: from.y + (ty - from.y) * e };
      shownRef.current = next;
      setShown(next);
      if (k < 1) rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafRef.current);
  }, [tx, ty, dockHeight, ms]);
  return shown;
}
