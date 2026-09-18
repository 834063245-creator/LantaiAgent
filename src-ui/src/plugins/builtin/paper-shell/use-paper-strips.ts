// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸条/选区域（paper-panel-split C4）——抽纸条（A 按住已有选区拖出 +
// B 选中浮钮）、lift 遮罩手感、划词朱线、纸条拖动/两击销毁。Stage-5：纸条
// = 工作区级公共物（拷贝语义快照，独立宿主，不挂会话）——落点相对来源流区
// 计算，但数据本身不再随流区归属。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEdgeAutoScroll } from './edge-scroll';
import type { MaskRect, PaperStrip, RegionView, SourcedBlock } from './host';
import {
  ANCHOR,
  classifyDropZone,
  getCanvasStore,
  makeStrip,
  mergeSelectionLines,
  screenToWorld,
  selectionMaskRects,
  selInkPaths,
  selSeedOf,
  stashStripPositionAt,
  useCanvasViewStore,
} from './host';
import { DRAG_THRESHOLD } from './use-paper-drag';
import type { PaperCore } from './use-paper-sessions';

/** 按点是否落在选区几何矩形内（±4px 容差盖住行间边缘）。 */
function pointInSelectionRects(range: Range, x: number, y: number): boolean {
  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) return true;
  }
  return false;
}

/** 输入面判据——**选区消费面共用**：选区落在可编辑控件里 = 用户在自己写字，
 *  不是划纸面正文。块内也长着这些面（准奏卡的「修改意见」textarea、卡内输入件），
 *  单靠「在 .pp-block 内」认不出来：在自己的输入框里选一段，纸上就会冒出抽纸条
 *  浮钮、还落一道划词朱线（2026-09-17 收口）。
 *  正文块本身**不是**输入面（`.pp-block` 不可编辑），故本判据不影响纸面划词。 */
export function isEditableSurface(node: Node | null | undefined): boolean {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return !!el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

/** 选区起手面判据（选区消费面共用的第二层）：按下点是否落在纸面正文里。
 *  **为什么必须有这一层**：`user-select: none` 只挡「从该面起选」，挡不住
 *  「按住家具再扫进纸面」——浏览器把选区锚点**夹到最近的可选内容**（块内文字），
 *  于是从目次带/坞/侧栏/题条起手的拖拽在锚点上与真划词无法区分，浮钮照弹
 *  （同族实测见 paper-minimap 的 preventDefault 注：拖小地图会选中画布文字）。
 *  故按下的那一刻就记下起手面，本次按住期间的选区一律按起手面算。
 *  代价（明账）：纯键盘造出的选区（Ctrl+A / Shift+方向键）沿用「上一次按下的面」
 *  ——先在块里点过一下即照常认，冷启动直接 Ctrl+A 不认（那是全选不是划词）。 */
function pressedInProse(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  return !!el?.closest('.pp-block');
}

/** 纸条/选区域（paper-panel-split C4，自 PaperPanel 2264-2602 + 2810-2820
 *  域内原样搬入）。A 拖拽路径的手势守卫读块拖拽/resize 的在途 ref（跨域
 * 握着东西不抢活跃——显式穿参）。 */
export function usePaperStrips(params: {
  core: PaperCore | null;
  view: { zoom: number; panX: number; panY: number };
  canvasRef: MutableRefObject<HTMLDivElement | null>;
  viewRef: MutableRefObject<{ zoom: number; panX: number; panY: number }>;
  regionsRef: MutableRefObject<RegionView[]>;
  canvasStrips: PaperStrip[];
  setBandSessionId: (id: string | null) => void;
  setSettleId: (id: string | null | ((cur: string | null) => string | null)) => void;
  dragRef: MutableRefObject<{
    id: string;
    sessionId: string | undefined;
    sx: number;
    sy: number;
    moved: boolean;
    wasFlow: boolean;
    instant: boolean;
    bw: number;
    offX: number;
    offY: number;
    block: SourcedBlock | null;
  } | null>;
  resizeRef: MutableRefObject<{ id: string; kind: 'pin' | 'strip'; startX: number; startW: number } | null>;
}) {
  const {
    core,
    view,
    canvasRef,
    viewRef,
    regionsRef,
    canvasStrips,
    setBandSessionId,
    setSettleId,
    dragRef,
    resizeRef,
  } = params;

  /* 边缘滚动子系统（开关/灵敏度/曲线/帧循环全在 edge-scroll.ts）：抽纸条（lift）
   * 与拖纸条两族手势共用同一实例——同一时刻只有一个手势在途。 */
  const { start: startEdgeScroll, stop: stopEdgeScroll } = useEdgeAutoScroll(canvasRef);

  const stripDragRef = useRef<{
    id: string;
    sx: number;
    sy: number;
    moved: boolean;
    offX: number;
    offY: number;
    /** 指针最新位（client）：边缘滚动帧据此复位纸条影（指针静止时也要跟手） */
    lastX: number;
    lastY: number;
  } | null>(null);
  const liftRef = useRef<{
    text: string;
    messageId: string | undefined;
    sessionId: string | undefined;
    rect: DOMRect | null;
    /** 指针最新位（client）：边缘滚动帧据此重算 ghost（指针静止时也要跟手） */
    lastX: number;
    lastY: number;
  } | null>(null);
  /** 本次按住是否起于纸面正文（见 pressedInProse 注；capture 面登记，恒在
   *  selectionchange 之前落值）。初值 false = 冷启动就 Ctrl+A 不算划词。 */
  const pressInProseRef = useRef(false);
  const [ghost, setGhost] = useState<{ x: number; y: number; zone: 'flow' | 'strip' } | null>(null);

  /* 起手面登记：唯一写点（选区消费面共用读点）。capture 是刻意的——家具上的
   * 拖拽手势多在 React 层 stopPropagation，冒泡面收不到，与本仓既有的
   * 「捕获面先行」纪律同源（见 use-paper-viewport 拖选自动滚屏注）。 */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      pressInProseRef.current = pressedInProse(e.target);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, []);

  /* ── lift 遮罩（P1 抽纸条手感 2026-08-30）：拖出选区时原地「被揭起」占位。
   * rects = 捕获时刻选区的世界矩形快照（世界层渲染，随视口变换跟手）；
   * done = 成条后的淡出态。取消路径即时移除（选区原样恢复 = 无事发生）。 */
  const [liftMask, setLiftMask] = useState<{ rects: MaskRect[]; done: boolean } | null>(null);
  const liftFadeTimerRef = useRef(0);
  const showLiftMask = useCallback((rects: MaskRect[]) => {
    window.clearTimeout(liftFadeTimerRef.current);
    setLiftMask({ rects, done: false });
  }, []);
  const completeLiftMask = useCallback(() => {
    window.clearTimeout(liftFadeTimerRef.current);
    setLiftMask((prev) => (prev ? { ...prev, done: true } : null));
    liftFadeTimerRef.current = window.setTimeout(() => setLiftMask(null), 220);
  }, []);
  const clearLiftMask = useCallback(() => {
    window.clearTimeout(liftFadeTimerRef.current);
    setLiftMask(null);
  }, []);
  useEffect(() => () => window.clearTimeout(liftFadeTimerRef.current), []);

  const spawnStrip = useCallback(
    (sessionId: string, text: string, messageId: string | undefined, x: number, y: number) => {
      const trimmed = text.trim();
      if (!trimmed || !core) return;
      void sessionId; // 纸条 = 工作区级公共物（Stage-5），源会话只作溯源展示
      const strip = makeStrip(trimmed, x, y, 480, messageId ? { messageId } : undefined);
      getCanvasStore(core.panelId).getState().addStrip(strip);
      setSettleId(strip.id); // 成条落定「放下」手感（刀3）
      window.setTimeout(() => setSettleId((cur) => (cur === strip.id ? null : cur)), 400);
    },
    [core, setSettleId],
  );

  const toWorldInCanvas = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return null;
      /* ⚠ 读 **store 现值** view：本手势与边缘滚动同场（滚屏每帧改 pan），用闭包
       *  旧 view 会算出虚构世界点——ghost 脱手、松手成条位置错位（同族病灶见
       *  use-paper-drag 的 syncPreview 注）。 */
      return screenToWorld(useCanvasViewStore.getState().view, sx, sy);
    },
    [canvasRef],
  );

  /** 选区快照（块内才认）：{ 文本, 来源块 messageId, 来源流区 sessionId } | null。
   *  两道守卫缺一不可：起手面（按住才起于正文——挡家具扫入）+ 输入面（挡块内输入件）。 */
  const snapshotBlockSelection = useCallback((): {
    text: string;
    messageId: string | undefined;
    sessionId: string | undefined;
  } | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    if (!pressInProseRef.current) return null; // 起手不在正文：扫入的选区不算划纸
    const anchorNode = sel.anchorNode;
    if (isEditableSurface(anchorNode)) return null; // 输入面选区不是划纸
    const anchorEl = anchorNode instanceof Element ? anchorNode : (anchorNode?.parentElement ?? null);
    const blockEl = anchorEl?.closest('.pp-block') ?? null;
    if (!blockEl) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    return {
      text,
      messageId: blockEl.getAttribute('data-message-id') ?? undefined,
      sessionId: blockEl.getAttribute('data-session-id') ?? undefined,
    };
  }, []);

  const restoreSelectionByRect = useCallback((rect: DOMRect) => {
    if (rect.width === 0 || rect.height === 0) return;
    const lineProbe = Math.min(rect.height, 22) / 2;
    const a = document.caretRangeFromPoint(rect.left + 1, rect.top + lineProbe);
    const b = document.caretRangeFromPoint(rect.right - 1, rect.bottom - lineProbe);
    if (!a || !b) return;
    const range = document.createRange();
    try {
      if (a.compareBoundaryPoints(Range.START_TO_START, b) <= 0) {
        range.setStart(a.startContainer, a.startOffset);
        range.setEnd(b.startContainer, b.startOffset);
      } else {
        range.setStart(b.startContainer, b.startOffset);
        range.setEnd(a.startContainer, a.startOffset);
      }
    } catch {
      return;
    }
    if (range.collapsed) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  /* 流区窄带中心（幽灵/落点判据的带中心 = 来源流区中轴） */
  const bandCenterOf = useCallback(
    (sessionId: string | undefined): number => {
      if (sessionId == null) return 0;
      return regionsRef.current.find((r) => r.sessionId === sessionId)?.anchor.anchorX ?? 0;
    },
    [regionsRef],
  );

  /* A：拖拽路径（mousedown/mousemove/mouseup 全局通道）。2026-09-05 路径 B
   * 退役（plan：pin-strip-rework §0 用户拍板）：拖选跨带松手不再成条——拖选
   * 只做选择（划大段字复制绝无误触）；抽纸条唯二入口 = 按住已有选区拖出
   *（本路径）+ 选中浮钮（B 段）。拖选幽灵同步效果一并退役（它只服务路径 B）。 */
  useEffect(() => {
    /** ghost 跟手一帧（mousemove 与边缘滚动帧共用）：按最新指针 + store 现值 view
     *  重算落点/带判据——滚屏期间指针静止也要复位，否则 ghost 脱手。 */
    const syncGhost = (clientX: number, clientY: number): void => {
      const lift = liftRef.current;
      const w = toWorldInCanvas(clientX, clientY);
      if (!w || !lift) {
        setGhost(null);
        return;
      }
      const center = bandCenterOf(lift.sessionId);
      const zone = classifyDropZone(w.x - center, ANCHOR.bandHalfWidth);
      setGhost({ x: w.x, y: w.y, zone });
    };

    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (dragRef.current || stripDragRef.current || resizeRef.current) {
        liftRef.current = null;
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const snap = snapshotBlockSelection();
      if (!snap) return;
      const range = sel.getRangeAt(0);
      if (!pointInSelectionRects(range, e.clientX, e.clientY)) return;
      // 原地遮罩矩形在清选区前捕获（世界坐标快照——渲染层随视口变换跟手）
      const cr = canvasRef.current?.getBoundingClientRect();
      const worldRects = cr
        ? selectionMaskRects(range.getClientRects(), viewRef.current, { x: cr.left, y: cr.top })
        : [];
      liftRef.current = {
        text: snap.text,
        messageId: snap.messageId,
        sessionId: snap.sessionId,
        rect: range.getBoundingClientRect(),
        lastX: e.clientX,
        lastY: e.clientY,
      };
      if (worldRects.length > 0) showLiftMask(worldRects);
      setBandSessionId(snap.sessionId ?? null); // 带显形：揭起即亮来源流区
      sel.removeAllRanges();
      e.preventDefault();
      // 揭起即成手势：指针贴缘 → 视口自动滚屏，ghost 同帧复位（拖到很远也跟手）
      startEdgeScroll(() => {
        const cur = liftRef.current;
        if (!cur) return null; // 手势已收
        return { x: cur.lastX, y: cur.lastY, afterPan: () => syncGhost(cur.lastX, cur.lastY) };
      });
    };

    const move = (e: MouseEvent) => {
      const lift = liftRef.current;
      if (!lift) return; // 非 lift 手势（本通道只服务 A 路）
      lift.lastX = e.clientX;
      lift.lastY = e.clientY;
      syncGhost(e.clientX, e.clientY);
    };

    const up = (e: MouseEvent) => {
      stopEdgeScroll();
      setGhost(null);
      setBandSessionId(null);
      const lift = liftRef.current;
      liftRef.current = null;
      if (!lift) return;
      const w = toWorldInCanvas(e.clientX, e.clientY);
      const center = bandCenterOf(lift.sessionId);
      if (w && lift.sessionId && classifyDropZone(w.x - center, ANCHOR.bandHalfWidth) === 'strip') {
        spawnStrip(lift.sessionId, lift.text, lift.messageId, w.x, w.y);
        completeLiftMask(); // 成条：原地遮罩淡出（揭走动作完成）
      } else if (lift.rect) {
        restoreSelectionByRect(lift.rect);
        clearLiftMask(); // 取消：选区原样恢复，遮罩即撤（无事发生）
      }
    };

    window.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      stopEdgeScroll();
    };
  }, [
    spawnStrip,
    snapshotBlockSelection,
    toWorldInCanvas,
    restoreSelectionByRect,
    bandCenterOf,
    showLiftMask,
    completeLiftMask,
    clearLiftMask,
    startEdgeScroll,
    stopEdgeScroll,
    dragRef,
    resizeRef,
    canvasRef,
    viewRef,
    setBandSessionId,
  ]);

  /* B：选中浮钮（selectionchange 监听——选区出现在块内时浮钮现身） */
  const [selAnchor, setSelAnchor] = useState<{
    range: Range;
    text: string;
    messageId: string | undefined;
    sessionId: string | undefined;
  } | null>(null);
  /* 划词朱线（2026-09-02 视觉迭代）：选区在画布内即记录（不限块级——跨块选区也要有线）；
   * Range 存活期随 DOM 变化自刷新矩形，渲染期现取（同 fabPos 范式）。
   * 折叠/画布外（composer、菜单）清线——原生洗底只在流区外保留。
   * 输入面同样清线：块内输入件（准奏卡修改意见框）里的选区是写字不是划纸
   * （2026-09-17 收口——共用 isEditableSurface，与浮钮同一把尺子）；
   * 起手面同样管：从家具扫进纸面的选区不落线（共用 pressInProseRef）。 */
  const [selInk, setSelInk] = useState<Range | null>(null);
  useEffect(() => {
    const onSelChange = () => {
      const selAll = window.getSelection();
      const live = selAll && selAll.rangeCount > 0 ? selAll.getRangeAt(0) : null;
      const anc = live?.commonAncestorContainer;
      const ancEl = anc instanceof Element ? anc : (anc?.parentElement ?? null);
      const inCanvas = !!(ancEl && canvasRef.current?.contains(ancEl)) && !isEditableSurface(anc);
      setSelInk(inCanvas && pressInProseRef.current && live && !live.collapsed ? live.cloneRange() : null);
      const snap = snapshotBlockSelection();
      if (!snap) {
        setSelAnchor(null);
        return;
      }
      const sel = window.getSelection();
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      if (!range || !rect || rect.width === 0) {
        setSelAnchor(null);
        return;
      }
      setSelAnchor({
        range: range.cloneRange(),
        text: snap.text,
        messageId: snap.messageId,
        sessionId: snap.sessionId,
      });
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [snapshotBlockSelection, canvasRef]);

  let fabPos: { left: number; top: number } | null = null;
  if (selAnchor) {
    const fr = selAnchor.range.getBoundingClientRect();
    if (fr.width > 0) fabPos = { left: fr.right + 8, top: fr.top - 30 };
  }

  const onStripButton = useCallback(() => {
    if (!selAnchor?.sessionId) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const selRect = selAnchor.range.getBoundingClientRect();
    if (!rect || selRect.width === 0) {
      setSelAnchor(null);
      return;
    }
    const worldMidY = screenToWorld(view, 0, selRect.top + selRect.height / 2 - rect.top).y;
    const region = regionsRef.current.find((r) => r.sessionId === selAnchor.sessionId);
    const centerX = region?.anchor.anchorX ?? 0;
    const pos = stashStripPositionAt(worldMidY, canvasStrips, ANCHOR.bandHalfWidth, centerX);
    spawnStrip(selAnchor.sessionId, selAnchor.text, selAnchor.messageId, pos.x, pos.y);
    window.getSelection()?.removeAllRanges();
    setSelAnchor(null);
  }, [selAnchor, view, spawnStrip, canvasStrips, canvasRef, regionsRef]);

  /* 拖纸条：与拖块同款阈值手势——超阈才跟动，松手一次性写 canvas-store；
   * 边缘滚动同款（拖到很远也跟手，循环归 edge-scroll.ts）。 */
  const [dragStripId, setDragStripId] = useState<string | null>(null);
  const [stripDragPos, setStripDragPos] = useState<{ x: number; y: number } | null>(null);
  const onStripMouseDown = useCallback(
    (e: React.MouseEvent, s: PaperStrip) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(useCanvasViewStore.getState().view, e.clientX - rect.left, e.clientY - rect.top);
      stripDragRef.current = {
        id: s.id,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        lastX: e.clientX,
        lastY: e.clientY,
        offX: w.x - s.x,
        offY: w.y - s.y,
      };
    },
    [canvasRef],
  );
  useEffect(() => {
    /** 跟手一帧（mousemove 与边缘滚动帧共用；读 store 现值 view，滚屏不脱手）。 */
    const syncPreview = (d: NonNullable<typeof stripDragRef.current>): void => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(useCanvasViewStore.getState().view, d.lastX - rect.left, d.lastY - rect.top);
      setStripDragPos({ x: w.x - d.offX, y: w.y - d.offY });
    };
    const move = (e: MouseEvent) => {
      const d = stripDragRef.current;
      if (!d) return;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        setDragStripId(d.id);
        startEdgeScroll(() => {
          const cur = stripDragRef.current;
          if (!cur?.moved) return null; // 手势已收
          return { x: cur.lastX, y: cur.lastY, afterPan: () => syncPreview(cur) };
        });
      }
      syncPreview(d);
    };
    const up = (e: MouseEvent) => {
      const d = stripDragRef.current;
      stripDragRef.current = null;
      stopEdgeScroll();
      setDragStripId(null);
      setStripDragPos(null);
      if (!d?.moved || !core) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      // 落点读 store 现值 view：与块影/纸条影同一把尺子（见 syncPreview 注）
      const w = screenToWorld(useCanvasViewStore.getState().view, e.clientX - rect.left, e.clientY - rect.top);
      getCanvasStore(core.panelId)
        .getState()
        .moveStrip(d.id, w.x - d.offX, w.y - d.offY);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      stopEdgeScroll();
    };
  }, [core, canvasRef, startEdgeScroll, stopEdgeScroll]);

  /* 纸条销毁两击确认（2026-09-05，plan §1.2）：快照语义删了即没了——首击
   * 进确认态（按钮变「确认？」），3s 超时回退，再击才真删。 */
  const [stripConfirmId, setStripConfirmId] = useState<string | null>(null);
  const stripConfirmTimerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(stripConfirmTimerRef.current), []);
  const onRemoveStrip = useCallback(
    (id: string) => {
      if (stripConfirmId !== id) {
        setStripConfirmId(id);
        window.clearTimeout(stripConfirmTimerRef.current);
        stripConfirmTimerRef.current = window.setTimeout(() => setStripConfirmId(null), 3000);
        return;
      }
      window.clearTimeout(stripConfirmTimerRef.current);
      setStripConfirmId(null);
      if (!core) return;
      getCanvasStore(core.panelId).getState().removeStrip(id);
    },
    [stripConfirmId, core],
  );

  /* 划词朱线（2026-09-02 视觉迭代）：行合并 + 手写路径渲染期现算——
   * Range 活矩形随视口刷新（同 fabPos 范式）；种子 = 选区文本 hash（同选区恒同线）。
   * 行数封顶 400：超大选区只画前 400 行（SVG 路径量护栏，选区监视不拖垮渲染）。 */
  let selInkArt: { mains: string[]; echoes: string[] } | null = null;
  if (selInk) {
    const inkLines = mergeSelectionLines(selInk.getClientRects());
    if (inkLines.length > 0 && inkLines.length <= 400) selInkArt = selInkPaths(inkLines, selSeedOf(selInk.toString()));
  }

  return {
    ghost,
    liftMask,
    selAnchor,
    selInkArt,
    fabPos,
    onStripButton,
    dragStripId,
    stripDragPos,
    stripConfirmId,
    onRemoveStrip,
    onStripMouseDown,
  };
}
