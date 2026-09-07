// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 激活/自动选中域（paper-panel-split C4）——三道闸停留控制器（Stage-4 §4.1）：
// 视口中心命中流区 + 连续停留 400ms 才切；平移/缩放/输入锁存折叠成 moving
// 喂进控制器。显式动作（点流区/书脊/侧边栏/边缘拖拽）走 activateRegion 并
// adopt，防止自动选中在用户显式切换后立刻把它拉回去。运动中不判的 ref 群
//（panning/edgeDrag/drag/stripDrag/focusRaf）经穿参进来——跨域「握着东西
// 不抢活跃」判据。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RegionHitRect, RegionView } from './host';
import {
  createSettleSelector,
  getCanvasStore,
  getChatStore,
  hitRegionAtWorld,
  useCanvasViewStore,
  viewportCenterWorld,
} from './host';
import type { PaperCore } from './use-paper-sessions';

/** 自动选中命中区向上外扩余量（px，世界单位）：卷首头（folio-head）在
 *  regionTop 之上实测 folioH——命中区再外扩 40px 兜住卷首上缘的呼吸带，
 *  用户常把视口中心对准卷首，不扩会“空白保持当前”不切 */
const REGION_HIT_LABEL_BAND = 40;
/** 手动切换后抑制自动选中的窗口（ms）：显式选会话后给 800ms 喘息，
 * 避免“侧边栏点 A、视口中心还在 B，400ms 后被自动选中拉回 B”的冲突感 */
const MANUAL_GUARD_MS = 800;

/** 激活/自动选中域（paper-panel-split C4，自 PaperPanel 1970-1997 + 2066-2134
 *  域内原样搬入）。 */
export function useRegionActivation(params: {
  core: PaperCore | null;
  canvasSize: { w: number; h: number };
  regionsRef: MutableRefObject<RegionView[]>;
  activeSessionKey: string | null;
  panningRef: MutableRefObject<{ lastX: number; lastY: number } | null>;
  edgeDragRef: MutableRefObject<{ sessionId: string; sx: number; sy: number; ax: number; ay: number } | null>;
  dragRef: MutableRefObject<unknown>;
  stripDragRef: MutableRefObject<unknown>;
  /** 拖选自动滚屏手势（use-paper-viewport）：用户正握着一段选区——不抢活跃。 */
  selDragRef: MutableRefObject<unknown>;
  focusRafRef: MutableRefObject<number>;
  zoomGuardUntilRef: MutableRefObject<number>;
}) {
  const {
    core,
    canvasSize,
    regionsRef,
    activeSessionKey,
    panningRef,
    edgeDragRef,
    dragRef,
    stripDragRef,
    selDragRef,
    focusRafRef,
    zoomGuardUntilRef,
  } = params;

  const [inputLocked, setInputLocked] = useState(false);
  const activateRegionRef = useRef<(sessionId: string) => void>(() => {});
  const settleRef = useRef(
    createSettleSelector({
      delayMs: 400,
      onChange: (sessionId) => activateRegionRef.current(sessionId),
    }),
  );
  /* rework P1-1：手动切换守卫——显式切会话后 800ms 内不判自动选中（防“切完被拉回”）。 */
  const manualGuardUntilRef = useRef(0);
  useEffect(() => () => settleRef.current.dispose(), []);

  /* ── 流区激活（点流区背景 = 显式动作立即切；自动选中也经此落定）── */
  const activateRegion = useCallback(
    (sessionId: string) => {
      if (!core) return;
      settleRef.current.adopt(sessionId);
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => String(s.id) === sessionId);
      if (idx < 0) return;
      if (idx !== st.activeIdx) core.switchSession(idx);
      getCanvasStore(core.panelId).getState().setActiveRegion(sessionId);
    },
    [core],
  );
  activateRegionRef.current = activateRegion;

  // 任何路径使活跃会话变化（显式点击/新建/摊开/恢复/自动选中）都把它登记为「最近落定值」，
  // 防止自动选中在状态刚切换后立刻拉回旧流区；同时给 800ms 手动守卫，
  // 避免“侧边栏点 A、视口中心还在 B，400ms 后被自动选中拉回 B”的冲突感。
  useEffect(() => {
    settleRef.current.adopt(activeSessionKey);
    manualGuardUntilRef.current = performance.now() + MANUAL_GUARD_MS;
  }, [activeSessionKey]);

  /* ── 自动选中效果：视口中心 → 命中判定 → 停留控制器 ── */
  useEffect(() => {
    const settle = settleRef.current;
    const panningRefLocal = panningRef; // 平移中不判（随 view 变化每帧喂）
    const tick = () => {
      // 读 store 实时 view：订阅回调在 React 重渲染前同步触发，viewRef 会滞后一帧
      const v = useCanvasViewStore.getState().view;
      const center = viewportCenterWorld(v, canvasSize.w, canvasSize.h);
      const rects: RegionHitRect[] = regionsRef.current.map((r) => ({
        sessionId: r.sessionId,
        x0: r.anchor.anchorX - r.anchor.width / 2,
        x1: r.anchor.anchorX + r.anchor.width / 2,
        // 向上外扩盖住卷首头（卷首在 regionTop 之上实测 folioH）——中心对准卷首也算命中
        y0: r.regionTop - r.folioH - REGION_HIT_LABEL_BAND,
        y1: r.regionBottom,
      }));
      const hit = hitRegionAtWorld(center.x, center.y, rects);
      // 运动中不判：平移/边缘拖/定位动画 + 拖块/拖纸条/拖选（用户正握着东西，
      // 别抢活跃会话）+ 输入锁存 + 缩放守卫 + 手动切换守卫
      const moving =
        panningRefLocal.current != null ||
        edgeDragRef.current != null ||
        dragRef.current != null ||
        stripDragRef.current != null ||
        selDragRef.current != null ||
        focusRafRef.current > 0 ||
        inputLocked ||
        performance.now() < zoomGuardUntilRef.current ||
        performance.now() < manualGuardUntilRef.current;
      settle.push(hit, moving);
    };
    tick();
    // view 每帧变化（平移/缩放/动画）即时喂（运动中快速取消）；
    // 200ms 间隔兜底「停住」后的最终判定（停止后不再有 view 变更事件）。
    const iv = window.setInterval(tick, 200);
    const unsub = useCanvasViewStore.subscribe(tick);
    return () => {
      window.clearInterval(iv);
      unsub();
    };
  }, [
    canvasSize.w,
    canvasSize.h,
    inputLocked,
    regionsRef,
    panningRef,
    edgeDragRef,
    dragRef,
    stripDragRef,
    selDragRef,
    focusRafRef,
    zoomGuardUntilRef,
  ]);

  return { activateRegion, inputLocked, setInputLocked };
}
