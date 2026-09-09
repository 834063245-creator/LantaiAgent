// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 焦点飞行域（paper-panel-split C2）——视口轻动画：飞到指定会话的指定世界 y
//（书脊定位器/目次带共用）+ 小地图点击滑视 + pendingFocus 补飞。飞行调度
//（focusFlight）与 raf 载体由 use-paper-viewport 创建传入——wheel/手动拖拽在
// 视口域抢占飞行，两域共享同一实例（同仓显式穿参纪律，禁共享模块态）。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect } from 'react';
import type { RegionView } from './host';
import { type createFocusFlightScheduler, getCanvasStore, useCanvasViewStore, viewFocusRegion } from './host';
import type { PaperCore } from './use-paper-sessions';

/** 焦点飞行域（paper-panel-split C2，自 PaperPanel 1476-1590 域内原样搬入）。
 *  挂载序约束：必须晚于 use-paper-regions 调用——补飞 effect 依赖 regions
 *  值（regions 引用变化 = 触发重判）。 */
export function usePaperFocus(params: {
  core: PaperCore | null;
  canvasSize: { w: number; h: number };
  regions: RegionView[];
  regionsRef: MutableRefObject<RegionView[]>;
  focusRafRef: MutableRefObject<number>;
  focusFlightRef: MutableRefObject<ReturnType<typeof createFocusFlightScheduler>>;
}) {
  const { core, canvasSize, regions, regionsRef, focusRafRef, focusFlightRef } = params;

  /* ── 视口轻动画：飞到指定会话的指定世界 y（书脊定位器/目次带共用）──
   * 复用 viewFocusRegion（锚到流区中轴 + 目标世界 y）；未摊开卷 expand
   * 在途时 pending 保持，流区出现后补飞（regions 依赖的第二个 effect）。 */
  const flyToPoint = useCallback(
    (sessionId: string, worldY: number) => {
      const region = regionsRef.current.find((r) => r.sessionId === sessionId);
      if (!region) return;
      // 同目标动画在途不再重播（regions 随视口每帧换引用——无守卫会自锁成乱飞）
      if (focusFlightRef.current.begin(sessionId) === 'rejected') return;
      const start = useCanvasViewStore.getState().view;
      const target = viewFocusRegion(start, canvasSize.w, canvasSize.h, {
        x: region.anchor.anchorX,
        y: worldY,
      });
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
      const DURATION = 240;
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / DURATION);
        const ease = 1 - (1 - t) ** 3;
        useCanvasViewStore.getState().setView({
          zoom: start.zoom,
          panX: start.panX + (target.panX - start.panX) * ease,
          panY: start.panY + (target.panY - start.panY) * ease,
        });
        if (t < 1) {
          focusRafRef.current = requestAnimationFrame(tick);
        } else {
          focusRafRef.current = 0;
          focusFlightRef.current.end();
          useCanvasViewStore.getState().requestFocus(null);
        }
      };
      focusRafRef.current = requestAnimationFrame(tick);
    },
    [canvasSize.w, canvasSize.h, regionsRef, focusRafRef, focusFlightRef],
  );
  const flyToRegion = useCallback(
    (sessionId: string) => {
      // R1 真位置守卫（2026-09-05，时序竞态修复）：新建/未摊开卷在 spread 无
      // 持久位置时（落位 effect 尚未跑，regions memo 只能拿 defaultRegionFor
      // 网格占位）**不飞**——pending 保持，落位 effect 把卷摆到视口中心后
      // regions 变化触发补飞（下方第二个 effect）。否则视角会飞往原点附近
      // 网格位，而卷实际在视口中心——「定位不到卷上」的病根。
      if (!core) return;
      const spread = getCanvasStore(core.panelId).getState().spread;
      if (!spread[sessionId]) return;
      const region = regionsRef.current.find((r) => r.sessionId === sessionId);
      if (region) flyToPoint(sessionId, region.anchor.anchorY);
    },
    [flyToPoint, core, regionsRef],
  );
  /* 小地图点击跳转（V3b 欠账接回，2026-08-30）：视口中心滑到目标世界点（保 zoom）。
   * 复用 focusRafRef——与 flyToPoint 互斥（后动取消先动）。 */
  const glideViewTo = useCallback(
    (worldX: number, worldY: number) => {
      // glide 也是飞行：进入在途态（无目标卷），阻挡补飞打扰；定位到达后取代
      if (focusFlightRef.current.begin(null) === 'rejected') return;
      const start = useCanvasViewStore.getState().view;
      const target = {
        zoom: start.zoom,
        panX: canvasSize.w / 2 - worldX * start.zoom,
        panY: canvasSize.h / 2 - worldY * start.zoom,
      };
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
      const DURATION = 240;
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / DURATION);
        const ease = 1 - (1 - t) ** 3;
        useCanvasViewStore.getState().setView({
          zoom: start.zoom,
          panX: start.panX + (target.panX - start.panX) * ease,
          panY: start.panY + (target.panY - start.panY) * ease,
        });
        if (t < 1) {
          focusRafRef.current = requestAnimationFrame(tick);
        } else {
          focusRafRef.current = 0;
          focusFlightRef.current.end();
          useCanvasViewStore.getState().requestFocus(null);
        }
      };
      focusRafRef.current = requestAnimationFrame(tick);
    },
    [canvasSize.w, canvasSize.h, focusRafRef, focusFlightRef],
  );
  const pendingFocusId = useCanvasViewStore((s) => s.pendingFocusId);
  useEffect(() => {
    if (pendingFocusId) flyToRegion(pendingFocusId);
  }, [pendingFocusId, flyToRegion]);
  useEffect(() => {
    // 未摊开卷 expand 在途：流区出现后补飞（pending 未清且目标已存在）。
    // 动画在途不重启（2026-08-31 视口乱飞修复）：regions 随视口每帧换引用，
    // 无守卫会让补飞每帧 cancel+重播动画 → 动画永不完、pending 永不清。
    // R1（2026-09-05）：spread 尚无目标位置 = 落位 effect 未跑（新建/未摊开
    // 卷）→ 不重判（flyToRegion 内部守卫已挡）；位置落定后 regions 变化
    //（canvasState.spread 写入 → regions memo 重算）本 effect 重跑补飞。
    void regions;
    const pending = useCanvasViewStore.getState().pendingFocusId;
    if (pending && !focusFlightRef.current.isActive()) flyToRegion(pending);
  }, [regions, flyToRegion, focusFlightRef]);
  useEffect(
    () => () => {
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
      focusFlightRef.current.end();
    },
    [focusRafRef, focusFlightRef],
  );

  return { flyToPoint, flyToRegion, glideViewTo };
}
