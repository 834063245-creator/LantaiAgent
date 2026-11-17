// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// useDragGesture — 拖拽手势的**唯一实现**（2026-11-17 交互原语收口批 C2）。
//
// 病灶（plan §0）：九份手势各自 `addEventListener('mousemove')` + 自行收尾，其中六份
// 不接 `useLostFocusCancel`——**窗外松手就留一份 in-flight 死状态**；下一次手势被
// 「有手势在途」的守卫静默吞掉，用户读作「莫名其妙失灵」（2026-10-29 抽纸条失灵批的
// 原话）。九份加起来的 1995 行里，真正属于「这个手势要做什么」的是少数，
// 大半在重复同一件事：**怎么开始、怎么收尾、失联了算谁的**。
//
// ── 为什么换 Pointer Events（不是换名字，是换掉病灶本身）──
//   · `setPointerCapture` 之后，指针移出元素、甚至移出窗口，`pointerup` **仍然送到
//     捕获者**——「窗外松手」从「要防的意外」变成「不会发生的事」；
//   · `pointercancel` 是浏览器免费给的失联信号（触控被系统接管 / 设备断开 / 窗口失焦），
//     比手写 `blur` + `visibilitychange` + `mouseleave` 三连更短也更准；
//   · 一条代码路径同时覆盖鼠标 / 触控 / 笔，不需要再写 `touchstart` 那一支。
//
// ── 三个能力位（按需开，不给就不发生）──
//   · `threshold`：起手阈值（px）。没过阈值就松手 = 一次点击，不算拖拽（`onEnd` 不调）。
//   · `cancelOnLostFocus`（缺省 **true**）：失联 = 取消，不提交任何结果（`onCancel`）。
//   · `clampToViewport`：窗外松手仍定夺（把指针夹回视口内再交出去），而不是取消——
//     拖纸条拖出窗口松手，用户的意思是「放到那边」，不是「我不要了」。
//
// ── 回退（plan C1 的验证项）──
// WebView2 的 pointer capture 若在某个元素上不生效（`setPointerCapture` 抛错或
// `hasPointerCapture` 仍为 false），本 hook **自动退回** window 监听 + `useLostFocusCancel`
// 兜底：行为与旧实现一致，只是失去「窗外松手仍交付」这一条。方案不塌。

import { useCallback, useEffect, useRef } from 'react';
import { useLostFocusCancel } from './lost-focus';

/** 一次手势的进行态（交给 onMove / onEnd 的第二个参数）。 */
export interface DragState {
  /** 起手点（client 坐标）。 */
  startX: number;
  startY: number;
  /** 当前点（client 坐标）。窗外松手时是**夹回视口后**的值（`clampToViewport`）。 */
  x: number;
  y: number;
  /** 相对起手点的位移。 */
  dx: number;
  dy: number;
  /** 是否已过阈值（没过 = 用户其实是在点，不是拖）。 */
  dragging: boolean;
  /** 松手点是否在窗口外（`clampToViewport` 时为 true 且 x/y 已夹回）。 */
  outsideViewport: boolean;
  /** 本次手势**是否真拿到了 pointer capture**。拿到时事件 `target` 恒是捕获元素
   *  （握把/手柄），判「松手落在哪个面上」必须改用 `document.elementFromPoint`；
   *  没拿到（回退路径）时 `target` 才是真正的落点元素。 */
  captured: boolean;
}

/** 取消的那个理由。「没过阈值就松手」也算取消（`click`）——它不是拖拽，是一次点击。 */
export type CancelReason = 'lost-focus' | 'pointercancel' | 'click' | 'escape' | 'manual';

export interface DragGestureOptions {
  /** 起手阈值（px，缺省 0 = 按下即拖）。 */
  threshold?: number;
  /** 失联即取消（缺省 true）。 */
  cancelOnLostFocus?: boolean;
  /** 窗外松手仍定夺（把点夹回视口内再交出去）。 */
  clampToViewport?: boolean;
  /** Esc 取消（缺省 true）——手势在途时才挂监听。 */
  cancelOnEscape?: boolean;
  /** 过了阈值的那一帧（只调一次）——起手动画/抬高态在这挂。 */
  onStart?: (e: PointerEvent, d: DragState) => void;
  /** 每帧（过阈值后）。 */
  onMove?: (e: PointerEvent, d: DragState) => void;
  /** 松手提交（过阈值才调）。 */
  onEnd?: (e: PointerEvent | null, d: DragState) => void;
  /** 取消（失联 / pointercancel / Esc / 没过阈值就松手）。**不提交任何结果。** */
  onCancel?: (reason: CancelReason) => void;
}

/** 手势本体（`begin` 挂在 onPointerDown 上）。 */
export interface DragGesture {
  begin: (e: React.PointerEvent) => void;
  /** 用户手写取消（Esc / 外部状态把这次手势作废）。 */
  cancel: () => void;
  /** 是否有手势在途（「有手势时别抢指针」的判据面）。 */
  isActive: () => boolean;
}

/** 指针是否在视口外（松手时用来决定夹不夹）。 */
function outside(clientX: number, clientY: number): boolean {
  return clientX < 0 || clientY < 0 || clientX > window.innerWidth || clientY > window.innerHeight;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 拖拽手势核心。`onPointerDown` 里调 `begin(e)`，其余全由 hook 接管。
 *
 * ⚠ **依赖表刻意不含回调**：九个手势域的回调大多随渲染重建（闭包读 store 现值），
 * 把它们放进依赖会让监听器每帧拆装一次——那正是旧实现「偶尔按下没反应」的另一种来路。
 * 回调走 ref 转发（同 `useLostFocusCancel` 的纪律）。
 */
export function useDragGesture(opts: DragGestureOptions): DragGesture {
  const { cancelOnLostFocus = true, cancelOnEscape = true } = opts;
  /* 其余选项一律走 `latest`（阈值/夹取/回调都随渲染变；读 ref 才不拆装监听器）。 */
  const latest = useRef(opts);
  latest.current = opts;
  const keyCancel = cancelOnEscape;
  /** 进行态（null = 无手势）。 */
  const state = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    dragging: boolean;
    captured: boolean;
    el: Element | null;
  } | null>(null);

  const detach = useRef<(() => void) | null>(null);

  const finish = useCallback((kind: 'end' | 'cancel', reason: CancelReason, e?: PointerEvent) => {
    const s = state.current;
    if (!s) return;
    state.current = null;
    detach.current?.();
    detach.current = null;
    /* 释放捕获：浏览器在 pointerup 后会自己释放，但**取消路径**（blur / pointercancel）
     * 不会，残留的捕获会让下一次按下直接落在老元素上。释放失败无所谓（元素已卸载）。 */
    try {
      const el = s.el as (Element & { releasePointerCapture?: (id: number) => void }) | null;
      if (s.captured && el?.releasePointerCapture) el.releasePointerCapture(s.pointerId);
    } catch {
      /* 元素已卸载 / 指针已消失：无需释放 */
    }

    const d: DragState = {
      startX: s.startX,
      startY: s.startY,
      x: s.lastX,
      y: s.lastY,
      dx: s.lastX - s.startX,
      dy: s.lastY - s.startY,
      dragging: s.dragging,
      outsideViewport: outside(s.lastX, s.lastY),
      captured: s.captured,
    };

    if (kind === 'cancel') {
      latest.current.onCancel?.(reason);
      return;
    }
    if (!s.dragging) {
      /* 没过阈值 = 一次点击：拖拽语义不成立，交回调用方当作「没发生」。
       * 不调 onEnd——调用方拿到的会是「位移 1px 的提交」，那是误触写库的来源。 */
      latest.current.onCancel?.('click');
      return;
    }
    let out = { ...d };
    if (latest.current.clampToViewport && out.outsideViewport) {
      const x = clamp(d.x, 0, window.innerWidth);
      const y = clamp(d.y, 0, window.innerHeight);
      out = { ...out, x, y, dx: x - d.startX, dy: y - d.startY };
    }
    latest.current.onEnd?.(e ?? null, out);
  }, []);

  const cancel = useCallback(() => finish('cancel', 'manual'), [finish]);

  const begin = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (state.current) {
        /* 上一把手势没收干净（旧实现的经典病灶）——先取消再开新的，
         * 否则第二个指针永远排不上队。 */
        finish('cancel', 'lost-focus');
      }
      const el = e.currentTarget as Element & {
        setPointerCapture?: (id: number) => void;
        hasPointerCapture?: (id: number) => boolean;
      };
      const pointerId = e.pointerId;
      let captured = false;
      try {
        el.setPointerCapture?.(pointerId);
        captured = el.hasPointerCapture?.(pointerId) ?? false;
      } catch {
        captured = false; // WebView2 / 合成事件：拿不到捕获就退回 window 面
      }
      state.current = {
        pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        dragging: false,
        captured,
        el,
      };

      const move = (ev: PointerEvent) => {
        const s = state.current;
        if (!s || ev.pointerId !== s.pointerId) return;
        s.lastX = ev.clientX;
        s.lastY = ev.clientY;
        if (!s.dragging) {
          const dist = Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY);
          if (dist < (latest.current.threshold ?? 0)) return;
          s.dragging = true;
          const d: DragState = {
            startX: s.startX,
            startY: s.startY,
            x: s.lastX,
            y: s.lastY,
            dx: s.lastX - s.startX,
            dy: s.lastY - s.startY,
            dragging: true,
            outsideViewport: outside(s.lastX, s.lastY),
            captured: s.captured,
          };
          latest.current.onStart?.(ev, d);
        }
        const d: DragState = {
          startX: s.startX,
          startY: s.startY,
          x: s.lastX,
          y: s.lastY,
          dx: s.lastX - s.startX,
          dy: s.lastY - s.startY,
          dragging: true,
          outsideViewport: outside(s.lastX, s.lastY),
          captured: s.captured,
        };
        latest.current.onMove?.(ev, d);
      };
      const up = (ev: PointerEvent) => {
        const s = state.current;
        if (!s || ev.pointerId !== s.pointerId) return;
        s.lastX = ev.clientX;
        s.lastY = ev.clientY;
        finish('end', 'click', ev);
      };
      const cancelled = () => finish('cancel', 'pointercancel');
      /* 捕获面：事件送到元素自己；没有捕获时退回 window（与旧实现同形）。 */
      const target: EventTarget = captured ? el : window;
      target.addEventListener('pointermove', move as EventListener);
      target.addEventListener('pointerup', up as EventListener);
      target.addEventListener('pointercancel', cancelled);
      detach.current = () => {
        target.removeEventListener('pointermove', move as EventListener);
        target.removeEventListener('pointerup', up as EventListener);
        target.removeEventListener('pointercancel', cancelled);
      };
    },
    [finish],
  );

  /* Esc = 取消（2026-11-17 批 C3）：原来归各域自己挂 window keydown（branch-drag /
   * 侧栏拖行各一份），现在收进核心——**只有手势在途时才挂**，不做常驻监听。 */
  useEffect(() => {
    if (!keyCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!state.current) return;
      finish('cancel', 'escape');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyCancel, finish]);

  /* 失联兜底：即使拿到捕获（WebView2 的边界仍在），窗口失焦/切走也要收。
   * 有捕获时这一条多半不会触发；没有捕获时它就是主路径（plan §2.1）。 */
  useLostFocusCancel(
    useCallback(() => {
      if (!cancelOnLostFocus) return;
      if (!state.current) return;
      finish('cancel', 'lost-focus');
    }, [cancelOnLostFocus, finish]),
  );

  /* 卸载即收：组件拆掉时手势必须作废，否则 in-flight 态活过组件寿命。 */
  useEffect(
    () => () => {
      if (state.current) finish('cancel', 'lost-focus');
    },
    [finish],
  );

  return {
    begin,
    cancel,
    isActive: () => state.current !== null,
  };
}
