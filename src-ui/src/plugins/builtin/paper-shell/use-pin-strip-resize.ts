// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 宽度手调域（paper-panel-split C4）——P2b：钉住块/纸条右缘 resize 面——hover
// 即拖拽态（同流区边缘范式）。live 预览走本地态，松手一次性写 canvas-store；
// prepare 与宽度无关 → 高度重测零 reflow，拖动全程 60fps。钉住块 x 是左缘
//（世界坐标唯一真相），右缘拖拽只改宽不改位。
//
// 2026-11-17 交互原语批 C3（2/9）：手势骨架换成 `useDragGesture`。这一份是最小的
// 一份手势（76 行），也是**先验样本**——`setPointerCapture` 在本机 WebView2 上能不能
// 用，先在这条最不容易出事的路径上验；拿不到捕获时核心自动退回 window 监听 +
// 失联即收，与旧实现行为一致（plan §2.1 的回退约定）。

import type { MutableRefObject } from 'react';
import { useCallback, useRef, useState } from 'react';
import { getCanvasStore, STREAM_REGION } from './host';
import { USER_SHRINK_MIN_W } from './measure';
import { useDragGesture } from './use-drag-gesture';
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

  const clear = useCallback(() => {
    resizeRef.current = null;
    resizeLatestRef.current = null;
    setResizePreview(null);
  }, []);

  const gesture = useDragGesture({
    onMove: (_e, d) => {
      const cur = resizeRef.current;
      if (!cur) return;
      const dx = d.dx / viewRef.current.zoom;
      const w = Math.min(STREAM_REGION.width, Math.max(USER_SHRINK_MIN_W, Math.round(cur.startW + dx)));
      resizeLatestRef.current = { id: cur.id, w };
      setResizePreview({ id: cur.id, w });
    },
    onEnd: () => {
      const d = resizeRef.current;
      const last = resizeLatestRef.current;
      clear();
      if (!d || !last || last.id !== d.id || !core) return;
      const canvas = getCanvasStore(core.panelId).getState();
      if (d.kind === 'pin') canvas.resizePin(d.id, last.w);
      else canvas.resizeStrip(d.id, last.w);
    },
    /* 取消（失联 / Esc / 窗外失联）：预览一并撤，**不写回**——失联 = 无事发生。
     * 旧实现靠 `useLostFocusCancel` 单独接一次；现在核心内置，这份 hook 不再自己挂。 */
    onCancel: clear,
  });

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent, id: string, kind: 'pin' | 'strip', startW: number) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      resizeRef.current = { id, kind, startX: e.clientX, startW };
      gesture.begin(e);
    },
    [gesture],
  );

  /* `canvasRef` 在本域不再被读（宽度换算用位移 / zoom，不需要画布矩形）——
   * 但参数保留：装配根按同一张签名穿参，去掉会让调用点长出一条特例。 */
  void canvasRef;

  return { resizeRef, resizePreview, onResizePointerDown };
}
