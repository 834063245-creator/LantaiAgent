// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 流区移位域（paper-panel-split C3）——拖流区边缘移动整个流区（Stage-2 定案：
// 悬停边缘即拖拽态，无显式手柄条）+ 四角横向缩放（P6 宽度自由）。拖动中 local
// state 覆盖锚点（不逐帧写 store）；松手一次性落定。edgeDragPos/regionCornerPos
// 是 regions memo 的拖动态锚点覆盖输入（装配根穿参）。
//
// 2026-11-17 交互原语批 C3（3/9）：两套手势都收进 `useDragGesture`——它们此前各挂
// 一份 window mousemove/mouseup，且都没接「失联即收」（窗外松手 = 预览态永久留在
// 场上，下一次拖流区被「有手势在途」的守卫静默吞掉，与抽纸条失灵批同型）。

import type { MutableRefObject } from 'react';
import { useCallback, useRef, useState } from 'react';
import { useDragGesture } from '../../../app/interaction/use-drag-gesture';
import type { RegionView, StreamRegionState } from './host';
import { clampRegionW, getCanvasStore, STREAM_REGION } from './host';
import type { PaperCore } from './use-paper-sessions';

/** 流区移位域（paper-panel-split C3，自 PaperPanel 977-1049 + 2135-2191 域内原样搬入）。 */
export function useRegionMove(params: {
  core: PaperCore | null;
  canvasRef: MutableRefObject<HTMLDivElement | null>;
  viewRef: MutableRefObject<{ zoom: number; panX: number; panY: number }>;
  regionsRef: MutableRefObject<RegionView[]>;
}) {
  const { core, canvasRef, viewRef, regionsRef } = params;

  /* ── 边缘拖动（Stage-2：拖流区边缘移动整个流区）──
   * 拖动中 local state 覆盖锚点（不逐帧写 store）；松手一次性落定。 */
  const edgeDragRef = useRef<{ sessionId: string; sx: number; sy: number; ax: number; ay: number } | null>(null);
  const edgeDragLatestRef = useRef<{ sessionId: string; x: number; y: number } | null>(null);
  const [edgeDragPos, setEdgeDragPos] = useState<{ sessionId: string; x: number; y: number } | null>(null);

  /* ── 四角横向缩放（P6 宽度自由）：角落手柄拖拽改宽——东角动右缘、西角动
   * 左缘（对缘锚定），clamp [720, 2160]；Y 不动（流区 Y 由内容生长）。
   * 拖动中流区框跟手（anchor 覆盖），块体重排走 adaptBlocks（measure 缓存
   * w 键失效自动重测——layout 纯算术零 reflow）。 ── */
  const regionCornerRef = useRef<{
    sessionId: string;
    corner: 'nw' | 'ne' | 'sw' | 'se';
    sx: number;
    orig: StreamRegionState;
  } | null>(null);
  const regionCornerLatestRef = useRef<{ sessionId: string; x: number; width: number } | null>(null);
  const [regionCornerPos, setRegionCornerPos] = useState<{ sessionId: string; x: number; width: number } | null>(null);

  const cornerGesture = useDragGesture({
    onMove: (_e, d) => {
      const cur = regionCornerRef.current;
      if (!cur) return;
      const dx = d.dx / viewRef.current.zoom;
      const east = cur.corner === 'ne' || cur.corner === 'se';
      const newW = clampRegionW(east ? cur.orig.width + dx : cur.orig.width - dx);
      // 对缘锚定：东角动 → 左缘固定；西角动 → 右缘固定
      const leftEdge = cur.orig.anchorX - cur.orig.width / 2;
      const rightEdge = cur.orig.anchorX + cur.orig.width / 2;
      const anchorX = east ? leftEdge + newW / 2 : rightEdge - newW / 2;
      regionCornerLatestRef.current = { sessionId: cur.sessionId, x: anchorX, width: newW };
      setRegionCornerPos({ sessionId: cur.sessionId, x: anchorX, width: newW });
    },
    onEnd: () => {
      const d = regionCornerRef.current;
      const last = regionCornerLatestRef.current;
      regionCornerRef.current = null;
      regionCornerLatestRef.current = null;
      setRegionCornerPos(null);
      if (!d || !last || last.sessionId !== d.sessionId || !core) return;
      const cur = getCanvasStore(core.panelId).getState().spread[d.sessionId];
      getCanvasStore(core.panelId)
        .getState()
        .setRegion(d.sessionId, {
          anchorX: last.x,
          anchorY: cur?.anchorY ?? d.orig.anchorY,
          width: last.width,
        });
    },
    /* 取消（失联 / Esc）：撤预览、**不落定**——与旧实现相比这是新增的正确行为：
     * 旧实现只在 mouseup 收尾，窗外松手会把画布留在「正在缩」的覆盖态。 */
    onCancel: () => {
      regionCornerRef.current = null;
      regionCornerLatestRef.current = null;
      setRegionCornerPos(null);
    },
  });

  const onRegionCornerPointerDown = useCallback(
    (e: React.PointerEvent, sessionId: string, corner: 'nw' | 'ne' | 'sw' | 'se') => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const region = regionsRef.current.find((r) => r.sessionId === sessionId);
      if (!region) return;
      regionCornerRef.current = { sessionId, corner, sx: e.clientX, orig: { ...region.anchor } };
      cornerGesture.begin(e);
    },
    [regionsRef, cornerGesture],
  );

  /* ── 流区边缘拖动（Stage-2 定案：悬停边缘即拖拽态，无显式手柄条）── */
  const edgeGesture = useDragGesture({
    onMove: (_e, d) => {
      const cur = edgeDragRef.current;
      if (!cur) return;
      const v = viewRef.current;
      const nx = cur.ax + d.dx / v.zoom;
      const ny = cur.ay + d.dy / v.zoom;
      edgeDragLatestRef.current = { sessionId: cur.sessionId, x: nx, y: ny };
      setEdgeDragPos({ sessionId: cur.sessionId, x: nx, y: ny });
    },
    onEnd: () => {
      const d = edgeDragRef.current;
      const last = edgeDragLatestRef.current;
      edgeDragRef.current = null;
      edgeDragLatestRef.current = null;
      setEdgeDragPos(null);
      if (!d || !core) return;
      const canvas = getCanvasStore(core.panelId).getState();
      const cur = canvas.spread[d.sessionId];
      const x = last && last.sessionId === d.sessionId ? last.x : (cur?.anchorX ?? d.ax);
      const y = last && last.sessionId === d.sessionId ? last.y : (cur?.anchorY ?? d.ay);
      canvas.setRegion(d.sessionId, {
        anchorX: x,
        anchorY: y,
        width: cur?.width ?? STREAM_REGION.width,
      });
    },
    onCancel: () => {
      edgeDragRef.current = null;
      edgeDragLatestRef.current = null;
      setEdgeDragPos(null);
    },
  });

  const onRegionEdgePointerDown = useCallback(
    (e: React.PointerEvent, sessionId: string) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const region = regionsRef.current.find((r) => r.sessionId === sessionId);
      if (!region) return;
      edgeDragRef.current = {
        sessionId,
        sx: e.clientX,
        sy: e.clientY,
        ax: region.anchor.anchorX,
        ay: region.anchor.anchorY,
      };
      edgeGesture.begin(e);
    },
    [regionsRef, edgeGesture],
  );

  /* `canvasRef` 与旧实现一致地不再被读（位移按 zoom 折算，不需要画布矩形）——
   * 参数保留：装配根按同一张签名穿参。 */
  void canvasRef;

  return {
    edgeDragPos,
    regionCornerPos,
    onRegionEdgePointerDown,
    onRegionCornerPointerDown,
  };
}
