// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 流区移位域（paper-panel-split C3）——拖流区边缘移动整个流区（Stage-2 定案：
// 悬停边缘即拖拽态，无显式手柄条）+ 四角横向缩放（P6 宽度自由）。拖动中 local
// state 覆盖锚点（不逐帧写 store）；松手一次性落定。edgeDragPos/regionCornerPos
// 是 regions memo 的拖动态锚点覆盖输入（装配根穿参）。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

  const onRegionCornerMouseDown = useCallback(
    (e: React.MouseEvent, sessionId: string, corner: 'nw' | 'ne' | 'sw' | 'se') => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const region = regionsRef.current.find((r) => r.sessionId === sessionId);
      if (!region) return;
      regionCornerRef.current = { sessionId, corner, sx: e.clientX, orig: { ...region.anchor } };
    },
    [regionsRef],
  );

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = regionCornerRef.current;
      if (!d) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = (e.clientX - d.sx) / viewRef.current.zoom;
      const east = d.corner === 'ne' || d.corner === 'se';
      const newW = clampRegionW(east ? d.orig.width + dx : d.orig.width - dx);
      // 对缘锚定：东角动 → 左缘固定；西角动 → 右缘固定
      const leftEdge = d.orig.anchorX - d.orig.width / 2;
      const rightEdge = d.orig.anchorX + d.orig.width / 2;
      const anchorX = east ? leftEdge + newW / 2 : rightEdge - newW / 2;
      regionCornerLatestRef.current = { sessionId: d.sessionId, x: anchorX, width: newW };
      setRegionCornerPos({ sessionId: d.sessionId, x: anchorX, width: newW });
    };
    const up = () => {
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
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core, canvasRef, viewRef]);

  /* ── 流区边缘拖动（Stage-2 定案：悬停边缘即拖拽态，无显式手柄条）── */
  const onRegionEdgeMouseDown = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
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
    },
    [regionsRef],
  );
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = edgeDragRef.current;
      if (!d) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const v = viewRef.current;
      const dx = (e.clientX - d.sx) / v.zoom;
      const dy = (e.clientY - d.sy) / v.zoom;
      const nx = d.ax + dx;
      const ny = d.ay + dy;
      edgeDragLatestRef.current = { sessionId: d.sessionId, x: nx, y: ny };
      setEdgeDragPos({ sessionId: d.sessionId, x: nx, y: ny });
    };
    const up = () => {
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
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core, canvasRef, viewRef]);

  return {
    edgeDragPos,
    regionCornerPos,
    onRegionEdgeMouseDown,
    onRegionCornerMouseDown,
  };
}
