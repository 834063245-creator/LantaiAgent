// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 拖块/钉住域（paper-panel-split C4）——D-R2-1 拖出钉住（2026-09-05 松手定夺
// 改造）：阈值起纯预览 → 全程跟手 → 松手定夺（带外落钉 / 带内取消回槽）。
// 眉批撕出族（instant）复用同一机制——首动即建钉。拖动渲染态（draggingId/
// dragPos/dragSource/bandSessionId/settleId）是 regions memo 与拖拽/纸条两域
// 的共读输入，由装配根持有穿参进来。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RegionView, SourcedBlock } from './host';
import { ANCHOR, getCanvasStore, screenToWorld, snapshotFromBlock } from './host';
import type { PaperCore } from './use-paper-sessions';

/** 拖动阈值（px）：超过即视为拖块（区分点击）——纸条拖拽同款（本域导出）。 */
export const DRAG_THRESHOLD = 6;
/** 眉批快照钉宽（P5：独立夹注快照落纸宽度） */
const SIDECAR_PIN_W = 320;
/** 钉住可发现性一次性眉批的 localStorage 旗标（毒化容忍——读写全包 try，
 * 命名同创作坞 lantai.hint.historySeen 族）。 */
const PIN_HINT_KEY = 'lantai.hint.pinDragSeen';

/** 拖块/钉住域（paper-panel-split C4，自 PaperPanel 1814-1969 + 1998-2021 +
 *  2649-2692 域内原样搬入）。 */
export function usePaperDrag(params: {
  core: PaperCore | null;
  view: { zoom: number; panX: number; panY: number };
  canvasRef: MutableRefObject<HTMLDivElement | null>;
  viewRef: MutableRefObject<{ zoom: number; panX: number; panY: number }>;
  regionsRef: MutableRefObject<RegionView[]>;
  blockSessionRef: MutableRefObject<Map<string, string>>;
  sessionsCount: number;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  setDragPos: (pos: { x: number; y: number } | null) => void;
  setDragSource: (src: { sessionId: string | undefined; wasFlow: boolean } | null) => void;
  setBandSessionId: (id: string | null) => void;
  setSettleId: (id: string | null | ((cur: string | null) => string | null)) => void;
}) {
  const {
    core,
    view,
    canvasRef,
    viewRef,
    regionsRef,
    blockSessionRef,
    sessionsCount,
    setDraggingId,
    setDragPos,
    setDragSource,
    setBandSessionId,
    setSettleId,
  } = params;

  const dragRef = useRef<{
    id: string;
    sessionId: string | undefined;
    sx: number;
    sy: number;
    moved: boolean;
    wasFlow: boolean;
    /** instant = 首动即建钉（眉批撕出族——携带预览依赖孤儿钉渲染，纯预览
     *  会全程无像；取消端 = up 里 commitPinned(null) 拔钉还原）。 */
    instant: boolean;
    bw: number;
    offX: number;
    offY: number;
    block: SourcedBlock | null;
  } | null>(null);

  const onBlockMouseDown = useCallback(
    (e: React.MouseEvent, block: SourcedBlock) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // 不触发画布平移/流区激活
      e.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sessionId = blockSessionRef.current.get(block.id);
      const region = sessionId ? regionsRef.current.find((r) => r.sessionId === sessionId) : undefined;
      const v = viewRef.current;
      const w = screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top);
      const lay = region?.layout;
      const rx = block.state === 'flow' ? (lay?.get(block.id)?.x ?? block.x) : block.x;
      const ry = block.state === 'flow' ? (lay?.get(block.id)?.y ?? block.y) : block.y;
      dragRef.current = {
        id: block.id,
        sessionId,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        wasFlow: block.state === 'flow',
        instant: false, // 整块拖出 = 松手定夺（纯预览 → 带外落钉/带内取消）
        bw: block.w,
        offX: w.x - rx,
        offY: w.y - ry,
        block,
      };
    },
    [canvasRef, viewRef, regionsRef, blockSessionRef],
  );

  /** 落定钉住：新钉 = 捕获快照 + 活引用源；已钉 = 移位置；pos null = 收回
   *  （眉批 instant 路径的取消端）。源会话缺省（孤儿钉）= 只移动既有钉，不新建。 */
  const commitPinned = useCallback(
    (
      sessionId: string | undefined,
      blockId: string,
      pos: { x: number; y: number } | null,
      block?: SourcedBlock | null,
    ) => {
      if (!core) return;
      const canvas = getCanvasStore(core.panelId).getState();
      if (!pos) {
        canvas.unpin(blockId);
        return;
      }
      const existing = canvas.pins[blockId];
      if (existing) {
        canvas.movePin(blockId, pos.x, pos.y);
        return;
      }
      if (!block) return;
      canvas.setPin(blockId, {
        x: pos.x,
        y: pos.y,
        w: block.w,
        source: sessionId ? { sessionId: Number(sessionId), blockId } : undefined,
        snapshot: snapshotFromBlock(block),
      });
    },
    [core],
  );

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      if (!d.moved) {
        d.moved = true;
        setDraggingId(d.id);
        setDragSource({ sessionId: d.sessionId, wasFlow: d.wasFlow });
        setBandSessionId(d.sessionId ?? null);
        // 眉批 instant 族：首动即建钉（携带预览 = 孤儿钉跟手，眉批位同帧
        // 换「已移出」占位）——撕出批注的揭起手感，与抽纸条 lift mask 同族。
        if (d.instant) {
          commitPinned(d.sessionId, d.id, { x: w.x - d.offX, y: w.y - d.offY }, d.block);
        }
      }
      setDragPos({ x: w.x - d.offX, y: w.y - d.offY });
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDraggingId(null);
      setDragSource(null);
      setBandSessionId(null);
      setDragPos(null);
      if (!d?.moved) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      const fx = w.x - d.offX;
      const fy = w.y - d.offY;
      const region = d.sessionId ? regionsRef.current.find((r) => r.sessionId === d.sessionId) : undefined;
      const bandCenter = region?.anchor.anchorX ?? 0;
      // 松手定夺（2026-09-05）：带外落钉（新钉 = 快照 + 活引用源；已钉 =
      // 移位置）；带内且原为 flow → 取消回槽——非 instant 族纯预览结束，无
      // 状态变更（不建钉、不挖洞、流布局全程未动）；instant 族（眉批）首动
      // 已建钉，取消端 = 拔钉还原占位。孤儿钉无来源带，恒落钉。
      if (d.wasFlow && d.sessionId && Math.abs(fx - bandCenter) <= ANCHOR.bandHalfWidth) {
        if (d.instant) commitPinned(d.sessionId, d.id, null);
        return;
      }
      commitPinned(d.sessionId, d.id, { x: fx, y: fy }, d.block);
      if (!d.instant) {
        setSettleId(d.id);
        window.setTimeout(() => setSettleId((cur) => (cur === d.id ? null : cur)), 400);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [
    view,
    commitPinned,
    canvasRef,
    regionsRef,
    setDraggingId,
    setDragPos,
    setDragSource,
    setBandSessionId,
    setSettleId,
  ]);

  /* 收回（即时手势，双向对称）：钉从纸上拔掉（回到流/或孤儿钉直接消失） */
  const onUnpin = useCallback(
    (id: string) => {
      if (!core) return;
      getCanvasStore(core.panelId).getState().unpin(id);
    },
    [core],
  );
  const onGhostClick = onUnpin;

  /* 眉批恢复（P5 → 2026-08-31 移出语义）：拔掉 `${blockId}:sc` 快照钉——
   * 眉批栏「已移出」占位还原为夹注全文（与流内 ghost 点击恢复同一手势语言） */
  const onSidecarRestore = useCallback((b: SourcedBlock) => onUnpin(`${b.id}:sc`), [onUnpin]);

  /* ── 眉批拖出钉画布（P5 → 2026-08-31 移出语义修订）：复用整块拖拽机制
   * （D-R2-1 同款手势语言）——首动即建钉：快照从眉批栏原位跟手揭起（offX/offY
   * 锚在眉批栏世界位），流内眉批位同帧换「已移出」占位（sidecarOutOf），
   * 拖回流带松手 = 取消（占位还原）；快照仍是拷贝语义公共物。
   * 点击（未过阈值）= 无操作，与整块拖拽一致。 ── */
  const onSidecarPinMouseDown = useCallback(
    (e: React.MouseEvent, block: SourcedBlock) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const sidecar = (block.payload as { sidecar?: { text: string } }).sidecar;
      if (!sidecar?.text) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const v = viewRef.current;
      const grab = screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top);
      // 起拖锚点 = 眉批栏左上角世界坐标——快照起拖位与原位重合（「揭起」非跳到光标）
      const asideEl = (e.currentTarget as HTMLElement).closest('.pp-marginalia');
      const anchor = asideEl
        ? screenToWorld(
            v,
            asideEl.getBoundingClientRect().left - rect.left,
            asideEl.getBoundingClientRect().top - rect.top,
          )
        : grab;
      dragRef.current = {
        id: `${block.id}:sc`,
        sessionId: blockSessionRef.current.get(block.id),
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        wasFlow: true, // 回带取消端 = up 拔钉还原占位（见拖块 effect 注）
        instant: true, // 眉批撕出族：携带预览 = 孤儿钉跟手（见拖块 effect 注）
        bw: SIDECAR_PIN_W,
        offX: grab.x - anchor.x,
        offY: grab.y - anchor.y,
        block: {
          id: `${block.id}:sc`,
          kind: 'reasoning',
          payload: { text: sidecar.text },
          state: 'flow',
          x: anchor.x,
          y: anchor.y,
          w: SIDECAR_PIN_W,
          source: block.source,
        },
      };
    },
    [canvasRef, viewRef, blockSessionRef],
  );

  /* ── 钉住可发现性（一次性眉批，2026-09-05）：有摊开卷且从未提示过 →
   * 浮现 6s（localStorage 旗标，毒化容忍——创作坞历史眉批同款范式）。
   * 提示长在功能所在处：文类签 = 块左缘拖出把手。 ── */
  const [pinHint, setPinHint] = useState(false);
  const pinHintShownRef = useRef(false);
  useEffect(() => {
    if (sessionsCount === 0 || pinHintShownRef.current) return;
    pinHintShownRef.current = true;
    let seen = true;
    try {
      seen = localStorage.getItem(PIN_HINT_KEY) === '1';
    } catch {
      seen = true; // 存储不可用 = 不提示（宁缺勿噪）
    }
    if (seen) return;
    try {
      localStorage.setItem(PIN_HINT_KEY, '1');
    } catch {
      // 写不进也照提示一次（ref 兜底本会话不再重复）
    }
    setPinHint(true);
    window.setTimeout(() => setPinHint(false), 6000);
  }, [sessionsCount]);

  return {
    dragRef,
    onBlockMouseDown,
    onUnpin,
    onGhostClick,
    onSidecarRestore,
    onSidecarPinMouseDown,
    pinHint,
  };
}
