// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 宽度手调域（paper-panel-split C4）——P2b：钉住块/纸条右缘 resize 面——hover
// 即拖拽态（同流区边缘范式）。live 预览走本地态，松手一次性写 canvas-store；
// prepare 与宽度无关 → 高度重测零 reflow，拖动全程 60fps。钉住块 x 是左缘
//（世界坐标唯一真相），右缘拖拽只改宽不改位。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCanvasStore, STREAM_REGION } from './host';
import { USER_SHRINK_MIN_W } from './measure';
import type { PaperCore } from './use-paper-sessions';

/** 宽度手调域（paper-panel-split C4，自 PaperPanel 2603-2648 域内原样搬入）。 */
export function usePinStripResize(params: {
  core: PaperCore | null;
  canvasRef: MutableRefObject<HTMLDivElement | null>;
  viewRef: MutableRefObject<{ zoom: number; panX: number; panY: number }>;
}) {
  const { core, canvasRef, viewRef } = params;

  const resizeRef = useRef<{ id: string; kind: 'pin' | 'strip'; startX: number; startW: number } | null>(null);
  const resizeLatestRef = useRef<{ id: string; w: number } | null>(null);
  const [resizePreview, setResizePreview] = useState<{ id: string; w: number } | null>(null);

  const onResizeMouseDown = useCallback((e: React.MouseEvent, id: string, kind: 'pin' | 'strip', startW: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    resizeRef.current = { id, kind, startX: e.clientX, startW };
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = resizeRef.current;
      if (!d) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = (e.clientX - d.startX) / viewRef.current.zoom;
      const w = Math.min(STREAM_REGION.width, Math.max(USER_SHRINK_MIN_W, Math.round(d.startW + dx)));
      resizeLatestRef.current = { id: d.id, w };
      setResizePreview({ id: d.id, w });
    };
    const up = () => {
      const d = resizeRef.current;
      const last = resizeLatestRef.current;
      resizeRef.current = null;
      resizeLatestRef.current = null;
      setResizePreview(null);
      if (!d || !last || last.id !== d.id || !core) return;
      const canvas = getCanvasStore(core.panelId).getState();
      if (d.kind === 'pin') canvas.resizePin(d.id, last.w);
      else canvas.resizeStrip(d.id, last.w);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core, canvasRef, viewRef]);

  return { resizeRef, resizePreview, onResizeMouseDown };
}
