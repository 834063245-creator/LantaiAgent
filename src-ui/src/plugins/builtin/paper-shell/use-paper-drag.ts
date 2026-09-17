// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 拖块/钉住域（paper-panel-split C4）——D-R2-1 拖出钉住（2026-09-05 松手定夺
// 改造）：阈值起纯预览 → 全程跟手 → 松手定夺（带外落钉 / 带内取消回槽）。
// 眉批撕出族（instant）复用同一机制——首动即建钉。拖动渲染态（draggingId/
// dragPos/dragSource/bandSessionId/settleId）是 regions memo 与拖拽/纸条两域
// 的共读输入，由装配根持有穿参进来。
//
// 边缘自动滚屏（2026-09-17 手感批，用户「拖一下→滚→再拖」病灶）：拖块时指针
// 贴视口四缘 → 视口持续自动滚动（RTS 缘滚同族：入带起滚、越深越快、越出画布
// 封顶），块影每帧钉回指针下——一次手势即可把块送到画布任意远处。曲线复用
// canvas-math 的 autoPanVector（拖选自动滚屏同一真源，禁另立参数）。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RegionView, SourcedBlock } from './host';
import {
  ANCHOR,
  autoPanVector,
  getCanvasStore,
  panBy,
  screenToWorld,
  snapshotFromBlock,
  useCanvasViewStore,
} from './host';
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
  canvasRef: MutableRefObject<HTMLDivElement | null>;
  viewRef: MutableRefObject<{ zoom: number; panX: number; panY: number }>;
  regionsRef: MutableRefObject<RegionView[]>;
  blockSessionRef: MutableRefObject<Map<string, string>>;
  sessionsCount: number;
  /** 手动接管视口（取消在途定位飞行 + 清挂起定位）：拖块 = 用户接管摄像机，
   *  与滚轮/拖画布/缩放同纪律（由装配根持 focusRaf/focusFlight 穿参下来）。 */
  takeOverViewport: () => void;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  setDragPos: (pos: { x: number; y: number } | null) => void;
  setDragSource: (src: { sessionId: string | undefined; wasFlow: boolean } | null) => void;
  setBandSessionId: (id: string | null) => void;
  setSettleId: (id: string | null | ((cur: string | null) => string | null)) => void;
}) {
  const {
    core,
    canvasRef,
    viewRef,
    regionsRef,
    blockSessionRef,
    sessionsCount,
    takeOverViewport,
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
    /** 指针最新位（client 坐标）：边缘滚屏的 rAF 帧据此现算入带深度——
     *  手势期间指针可静止，只有移动事件到不了帧里。 */
    lastX: number;
    lastY: number;
    /** 上次落下的预览位（世界坐标）：同值短路，静止帧不产生重渲染。 */
    lastPos: { x: number; y: number } | null;
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
        lastX: e.clientX,
        lastY: e.clientY,
        lastPos: null,
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

  /* 边缘自动滚屏的帧载体（拖块手势期常驻 rAF；松手/卸载即撤）。 */
  const panRafRef = useRef(0);

  useEffect(() => {
    /* ── 跟手一帧（mousemove 与滚屏帧共用）──
     * 预览位 = 最新指针 − 抓取偏移，读 **store 现值** view：手势期间 pan 会被
     * 边缘滚屏/滚轮改动，用闭包旧 view 算的块影会脱离指针（松手落点随之错位）。
     * 同值短路（lastPos）：指针静止且 pan 未动的帧零重渲染。 */
    const syncPreview = (d: NonNullable<typeof dragRef.current>): void => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(useCanvasViewStore.getState().view, d.lastX - rect.left, d.lastY - rect.top);
      const nx = w.x - d.offX;
      const ny = w.y - d.offY;
      if (d.lastPos && d.lastPos.x === nx && d.lastPos.y === ny) return;
      d.lastPos = { x: nx, y: ny };
      setDragPos({ x: nx, y: ny });
    };

    /* ── 边缘自动滚屏帧（RTS 缘滚同族）──
     * 指针在视口四缘的感应带内（含越出画布：autoPanVector 封顶 1.5×）→ 每帧
     * 推一记 panBy，块影同帧钉回指针下。指针静止在带内也持续滚（mousemove 到
     * 不了帧里的那一路靠常驻循环），回带内自然停摆。 */
    const tick = (): void => {
      panRafRef.current = 0;
      const d = dragRef.current;
      if (!d?.moved) return; // 手势已收
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const v = autoPanVector(d.lastX - rect.left, d.lastY - rect.top, rect.width, rect.height);
        if (v.dx !== 0 || v.dy !== 0) {
          useCanvasViewStore.getState().setView((cur) => panBy(cur, v.dx, v.dy));
        }
        syncPreview(d);
      }
      panRafRef.current = requestAnimationFrame(tick);
    };

    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        takeOverViewport(); // 拖块 = 手动接管视口（否则在途定位飞行跟手抢 pan）
        setDraggingId(d.id);
        setDragSource({ sessionId: d.sessionId, wasFlow: d.wasFlow });
        setBandSessionId(d.sessionId ?? null);
        // 眉批 instant 族：首动即建钉（携带预览 = 孤儿钉跟手，眉批位同帧
        // 换「已移出」占位）——撕出批注的揭起手感，与抽纸条 lift mask 同族。
        if (d.instant) {
          const rect = canvasRef.current?.getBoundingClientRect();
          if (rect) {
            const w = screenToWorld(useCanvasViewStore.getState().view, d.lastX - rect.left, d.lastY - rect.top);
            commitPinned(d.sessionId, d.id, { x: w.x - d.offX, y: w.y - d.offY }, d.block);
          }
        }
        panRafRef.current = requestAnimationFrame(tick);
      }
      syncPreview(d);
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (panRafRef.current) {
        cancelAnimationFrame(panRafRef.current);
        panRafRef.current = 0;
      }
      setDraggingId(null);
      setDragSource(null);
      setBandSessionId(null);
      setDragPos(null);
      if (!d?.moved) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      // 落点读 store 现值 view：边缘滚屏的最后一帧 pan 未必已进闭包快照——
      // 落点与块影（上一帧按现值算的预览位）必须同一把尺子，否则钉跳位。
      const w = screenToWorld(useCanvasViewStore.getState().view, e.clientX - rect.left, e.clientY - rect.top);
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
      if (panRafRef.current) cancelAnimationFrame(panRafRef.current);
    };
    /* ⚠ 依赖表刻意不含 view：平移每帧换值 → 每帧重建 effect（监听器拆装 +
     *  滚屏循环被 cleanup 掐断）。本域一律读 store 现值 view（见 syncPreview
     *  注）——与视口域「拖拽回调零依赖稳定」同源纪律。 */
  }, [
    commitPinned,
    canvasRef,
    regionsRef,
    takeOverViewport,
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
        lastX: e.clientX,
        lastY: e.clientY,
        lastPos: null,
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
