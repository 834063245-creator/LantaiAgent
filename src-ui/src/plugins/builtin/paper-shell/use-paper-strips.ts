// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸条/选区域（paper-panel-split C4）——抽纸条（A 按住已有选区拖出 +
// B 选中浮钮）、lift 遮罩手感、划词朱线、纸条拖动/两击销毁。Stage-5：纸条
// = 工作区级公共物（拷贝语义快照，独立宿主，不挂会话）——落点相对来源流区
// 计算，但数据本身不再随流区归属。
//
// 2026-10-29「抽纸条莫名其妙失灵」批（用户报）：三处确定性病灶一起收——
//   ① **命中带**：A 路的 mousedown 探针原按逐碎片矩形 ±4px 判，浏览器给的是字面盒
//      （16px/1.75 下 20px 行盒 + 8px 行距）⇒ 按住「明明选中的那一块」偶发没反应。
//      改「按行合并 + 行间空档填满」（selection.ts::selectionHitBands，纯函数可测）。
//   ② **钉住的公共物**：孤儿钉的块没有 data-session-id（源卷已不摊开/已删），
//      浮钮照弹但点击 `!selAnchor.sessionId` 直接 return、拖出也因 `!lift.sessionId`
//      静默恢复选区——**看起来有入口、做了却什么都不发生**。现按卡片自身几何判
//      「拖出卡片即成条」，浮钮落点挪到选区右缘（纸条是工作区级物件，不需要流带）。
//   ③ **失联即收**：窗口失焦/窗外松手后 mouseup 永不到，in-flight ref 留在在途态，
//      下一次抽纸条被「有手势在途」的守卫吞掉。手势态清理见 lost-focus.ts。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaperStrip } from '../../../paper/selection-contract';
import { volumeDisplayName } from '../../../state/volume-name';
import { useEdgeAutoScroll } from './edge-scroll';
import type { RegionView, SourcedBlock } from './host';
import { ANCHOR, getCanvasStore, screenToWorld, useCanvasViewStore } from './host';
import { useLostFocusCancel } from './lost-focus';
import { mergeSelectionLines, selInkPaths, selSeedOf } from './sel-ink';
import {
  classifyDropZone,
  type MaskRect,
  makeStrip,
  pointInHitBands,
  pointInWorldRect,
  selectionHitBands,
  selectionMaskRects,
  stashStripBesideRight,
  stashStripPositionAt,
} from './selection';
import { DRAG_THRESHOLD } from './use-paper-drag';
import type { PaperCore } from './use-paper-sessions';

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

/** 选区快照（块内才认）：抽出那一刻的文本 + 来源身份 + 判据几何。
 *  两道守卫缺一不可：起手面（按住才起于正文——挡家具扫入）+ 输入面（挡块内输入件）。 */
interface SelectionSnapshot {
  text: string;
  /** 源消息（钉住的公共物快照没有消息锚——`data-message-id` 缺席） */
  messageId: string | undefined;
  /** 源流区（孤儿钉没有——源卷已不摊开/已删） */
  sessionId: string | undefined;
  /** 源卷显示名快照（孤儿钉从 `data-source-label` 读；流区块由 regionsRef 现取） */
  label: string | undefined;
  /** 源块是否钉住（**钉住的公共物不按流带判据**——它不在任何流带里） */
  pinned: boolean;
  /** 选区屏幕矩形（取消端恢复选区；浮钮零矩形时的落位兜底） */
  rect: DOMRect | null;
  /** 源块矩形的世界几何（钉住块的「拖出卡片」判据；流带块不用） */
  blockWorldRect: MaskRect | null;
}

/** 纸条/选区域（paper-panel-split C4，自 PaperPanel 2264-2602 + 2810-2820
 *  域内原样搬入）。A 拖拽路径的手势守卫读块拖拽/resize 的在途 ref（跨域
 *  握着东西不抢活跃——显式穿参）。 */
export function usePaperStrips(params: {
  core: PaperCore | null;
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
  const { core, canvasRef, viewRef, regionsRef, canvasStrips, setBandSessionId, setSettleId, dragRef, resizeRef } =
    params;

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
    label: string | undefined;
    /** 源块钉住 = 不看流带、看卡片矩形（见 zoneAt） */
    pinned: boolean;
    /** 源块世界矩形（钉住块的「出卡成条」判据；world 坐标 ⇒ 滚屏不漂） */
    blockWorldRect: MaskRect | null;
    /** 选区屏幕矩形（取消端恢复选区） */
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
    (params: {
      sessionId: string | undefined;
      text: string;
      messageId: string | undefined;
      /** 源卷名快照（钉住的公共物在 DOM 上没有活流区，只能读 `data-source-label`） */
      label: string | undefined;
      x: number;
      y: number;
    }) => {
      const trimmed = params.text.trim();
      if (!trimmed || !core) return;
      /* 纸条 = 工作区级公共物（Stage-5），源会话只作溯源展示：报头的卷名在此
       * **拍快照**（拷贝语义——源卷改名不追改；取自流区显示名，无名卷走
       * volumeDisplayName 的档号兜底，禁在调用点散写 label || …）。 */
      const region = params.sessionId ? regionsRef.current.find((r) => r.sessionId === params.sessionId) : undefined;
      const label = params.label ?? (region ? volumeDisplayName(region.label, region.sessionNum) : undefined);
      const source =
        params.messageId || label
          ? {
              ...(params.messageId ? { messageId: params.messageId } : {}),
              ...(label ? { label } : {}),
            }
          : undefined;
      const strip = makeStrip(trimmed, params.x, params.y, 480, source);
      getCanvasStore(core.panelId).getState().addStrip(strip);
      setSettleId(strip.id); // 成条落定「放下」手感（刀3）
      window.setTimeout(() => setSettleId((cur) => (cur === strip.id ? null : cur)), 400);
    },
    [core, regionsRef, setSettleId],
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

  /** 屏幕矩形 → 世界矩形（判据用；滚屏期间不漂）。 */
  const toWorldRect = useCallback(
    (rect: DOMRect | null): MaskRect | null => {
      const cr = canvasRef.current?.getBoundingClientRect();
      if (!cr || !rect || rect.width <= 0 || rect.height <= 0) return null;
      return selectionMaskRects([rect], useCanvasViewStore.getState().view, { x: cr.left, y: cr.top })[0] ?? null;
    },
    [canvasRef],
  );

  const snapshotBlockSelection = useCallback((): SelectionSnapshot | null => {
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
    const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect() ?? null;
    return {
      text,
      messageId: blockEl.getAttribute('data-message-id') ?? undefined,
      sessionId: blockEl.getAttribute('data-session-id') ?? undefined,
      label: blockEl.getAttribute('data-source-label') ?? undefined,
      pinned: blockEl.getAttribute('data-block-state') === 'pinned',
      rect: rect && rect.width > 0 ? rect : null,
      blockWorldRect: toWorldRect(blockEl.getBoundingClientRect()),
    };
  }, [toWorldRect]);

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
    (sessionId: string | undefined): number | null => {
      if (sessionId == null) return null;
      return regionsRef.current.find((r) => r.sessionId === sessionId)?.anchor.anchorX ?? null;
    },
    [regionsRef],
  );

  /** 落点分寸（单一真源，ghost 与松手共用同一把尺子）：
   *  - 流带里的块：|落点 − 流区中轴| > 半带宽 ⇒ 成条（既有带判据，不动）；
   *  - **钉住的公共物**（不在任何流带里）：离开卡片矩形即成条——按带算会把
   *    纸条判成「永远在带内」（孤儿钉没有 region ⇒ 中心 0），用户读作点了没反应。
   *  返回 null = 指针不在画布内（落点无意义）。 */
  const zoneAt = useCallback(
    (lift: NonNullable<typeof liftRef.current>, clientX: number, clientY: number): 'flow' | 'strip' | null => {
      const w = toWorldInCanvas(clientX, clientY);
      if (!w) return null;
      const center = lift.pinned ? null : bandCenterOf(lift.sessionId);
      if (center != null) return classifyDropZone(w.x - center, ANCHOR.bandHalfWidth);
      /* 量不到卡片几何（卸载中/无画布矩形）⇒ 判「不成条」：宁可不抽，也不误抽
       * ——落点判据立不住时不能静默把一次点击变成纸条。 */
      if (!lift.blockWorldRect) return 'flow';
      return pointInWorldRect(lift.blockWorldRect, w.x, w.y, 2) ? 'flow' : 'strip';
    },
    [bandCenterOf, toWorldInCanvas],
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
      if (!lift) {
        setGhost(null);
        return;
      }
      const w = toWorldInCanvas(clientX, clientY);
      const zone = zoneAt(lift, clientX, clientY);
      if (!w || zone == null) {
        setGhost(null);
        return;
      }
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
      /* 命中带判据（2026-10-29）：同一选区的行盒合并 + 行间空档填满——按住行距
       * 中段或行尾空白也算抓住选区（旧逐矩形 ±4px 在这些位置是死区）。 */
      if (!pointInHitBands(selectionHitBands(range.getClientRects()), e.clientX, e.clientY)) return;
      // 原地遮罩矩形在清选区前捕获（世界坐标快照——渲染层随视口变换跟手）
      const cr = canvasRef.current?.getBoundingClientRect();
      const worldRects = cr
        ? selectionMaskRects(range.getClientRects(), viewRef.current, { x: cr.left, y: cr.top })
        : [];
      liftRef.current = {
        text: snap.text,
        messageId: snap.messageId,
        sessionId: snap.sessionId,
        label: snap.label,
        pinned: snap.pinned,
        blockWorldRect: snap.blockWorldRect,
        rect: snap.rect,
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
      if (zoneAt(lift, e.clientX, e.clientY) === 'strip') {
        const w = toWorldInCanvas(e.clientX, e.clientY);
        if (w) {
          spawnStrip({
            sessionId: lift.sessionId,
            text: lift.text,
            messageId: lift.messageId,
            label: lift.label,
            x: w.x,
            y: w.y,
          });
          completeLiftMask(); // 成条：原地遮罩淡出（揭走动作完成）
          return;
        }
      }
      if (lift.rect) restoreSelectionByRect(lift.rect);
      clearLiftMask(); // 取消：选区原样恢复，遮罩即撤（无事发生）
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
    zoneAt,
    restoreSelectionByRect,
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
    label: string | undefined;
    pinned: boolean;
    /** 快照时刻的选区矩形（Range 与 DOM 脱钩时的落位兜底——见 fabPos） */
    rect: DOMRect | null;
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
      if (!range) {
        setSelAnchor(null);
        return;
      }
      const rect = snap.rect ?? range.getBoundingClientRect();
      if (rect.width === 0) {
        setSelAnchor(null);
        return;
      }
      setSelAnchor({
        range: range.cloneRange(),
        text: snap.text,
        messageId: snap.messageId,
        sessionId: snap.sessionId,
        label: snap.label,
        pinned: snap.pinned,
        rect,
      });
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [snapshotBlockSelection, canvasRef]);

  let fabPos: { left: number; top: number } | null = null;
  if (selAnchor) {
    /* 落位优先读**活 Range**（选区随视口刷新——平移帧里按钮跟着字走）；Range 与 DOM
     * 脱钩（流式改写把文本节点换掉）时退回快照矩形：按钮宁可差几像素，也不能因为
     * 拿不到矩形就整枚消失（用户读作「抽纸条按钮不见了」）。 */
    const live = selAnchor.range.getBoundingClientRect();
    const fr = live.width > 0 ? live : selAnchor.rect;
    if (fr && fr.width > 0) fabPos = { left: fr.right + 8, top: fr.top - 30 };
  }

  const onStripButton = useCallback(() => {
    const anchor = selAnchor;
    if (!anchor) return;
    const cr = canvasRef.current?.getBoundingClientRect();
    if (!cr) {
      setSelAnchor(null);
      return;
    }
    const live = anchor.range.getBoundingClientRect();
    const selRect = live.width > 0 ? live : anchor.rect;
    if (!selRect) {
      setSelAnchor(null);
      return;
    }
    const viewNow = useCanvasViewStore.getState().view;
    const worldMidY = screenToWorld(viewNow, 0, selRect.top + selRect.height / 2 - cr.top).y;
    const region = anchor.sessionId ? regionsRef.current.find((r) => r.sessionId === anchor.sessionId) : undefined;
    /* 流带块落「流区右侧第一档」；钉住的公共物落「选区右缘第一档」——后者不在
     * 任何流带里（孤儿钉没有 region），按带算会把纸条丢到纸外（点击看着没反应）。 */
    const pos =
      !anchor.pinned && region
        ? stashStripPositionAt(worldMidY, canvasStrips, ANCHOR.bandHalfWidth, region.anchor.anchorX)
        : stashStripBesideRight(screenToWorld(viewNow, selRect.right - cr.left, 0).x, worldMidY, canvasStrips);
    spawnStrip({
      sessionId: anchor.sessionId,
      text: anchor.text,
      messageId: anchor.messageId,
      label: anchor.label,
      x: pos.x,
      y: pos.y,
    });
    window.getSelection()?.removeAllRanges();
    setSelAnchor(null);
  }, [selAnchor, spawnStrip, canvasStrips, canvasRef, regionsRef]);

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

  /* 失联即收（2026-10-29 抽纸条失灵批见文件头注 ③）：窗口失焦 / 页面隐藏 /
   * 指针离开文档 ⇒ lift 与拖纸条双双回退到「无事发生」。不清的话，一次窗外松手
   * 就把 in-flight ref 留在在途态，下一次抽纸条被 down 的守卫静默吞掉。 */
  useLostFocusCancel(
    useCallback(() => {
      const lift = liftRef.current;
      if (lift) {
        liftRef.current = null;
        stopEdgeScroll();
        setGhost(null);
        setBandSessionId(null);
        clearLiftMask();
        if (lift.rect) restoreSelectionByRect(lift.rect); // 取消端语义同 mouseup 的取消路
      }
      if (stripDragRef.current) {
        stripDragRef.current = null;
        stopEdgeScroll();
        setDragStripId(null);
        setStripDragPos(null);
      }
    }, [stopEdgeScroll, setBandSessionId, clearLiftMask, restoreSelectionByRect]),
  );

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
