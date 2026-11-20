// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// quote-drop — **长按把夹签递给另一卷**（docs/plans/card-quote-plan.md §2.2 态二 / §6.2）。
//
// 语义（方案 §2.3 的归属模型）：拖到 B 卷松手 = 写进 **B 卷的草稿槽**，
// 不切活跃卷、不抢输入焦点——用户还在 A 卷干活，只是把卡递给了 B。
// 落在空白 = 什么都没发生（§6.2「松手（无效）」）。
//
// 三件判据：
//   ① **长按 320ms** 才起手（`pointerdown` 起计时）——轻点仍走既有那条「引用到本卷」的快路；
//      位移超过 8px 取消长按、转正常滚动（方案 §2.2 原文）。
//   ② 卷命中用 `document.elementFromPoint`（pointer capture 下事件 target 恒是捕获元素，
//      判「落在哪一卷」必须换命中测试——同 `use-drag-gesture` 的 DragState.captured 注）。
//   ③ 只有**别的卷**可投放：落回自己那一卷 = 无操作（它本来就在这份槽里）。
//
// ⚠ 手势本体**收编进 `useDragGesture`**（交互原语守卫 E1：指针监听只许出现在登记表内）：
//   本件只加两层语义——「按住 320ms 才有效」的起手闸，与「落在哪一卷」的命中测试。
//   Esc 取消 / 失联即收 / 捕获回退全部由核心给（此前手写 window 三件套是另一份实现）。
//
// 可视态（§6.2）只做两件在本件里有因果的：**起手抬起**（夹签离纸、跟手）与**卷描线浮现**
// （可投放态）。两者都靠 DOM 打标消费——`html.pp-quote-dropping`（可投放态）与
// `.pp-region[data-quote-drop="1"]`（指针下那一卷），先例 = use-composer-float 的
// `pp-composer-dragging`：**CSS 是唯一消费面，DOM 就是两个产物之间本来的共享面**，
// 不为一次手势新增跨产物 store、不动 faceDeps。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDragGesture } from '../../../app/interaction/use-drag-gesture';

/** 长按阈值（方案 §2.2：320ms）。 */
export const LONG_PRESS_MS = 320;
/** 位移容差（方案 §2.2：超过 8px 取消长按、转正常滚动）。同时是手势核心的起手阈值。 */
export const LONG_PRESS_SLOP = 8;

/** 指针下的卷号（`data-session-id`）；空白返回 null。 */
export function regionAtPoint(x: number, y: number): string | null {
  if (typeof document === 'undefined') return null;
  const el = document.elementFromPoint(x, y);
  const region = el?.closest<HTMLElement>('.pp-region[data-session-id]');
  return region?.dataset.sessionId ?? null;
}

export interface QuoteHoldState {
  /** 正在按住、还没起手（进度环要跟着走）。 */
  holding: boolean;
  /** 已起手（夹签浮起、卷进入可投放态）。 */
  dragging: boolean;
  /** 指针下的目标卷（null = 空白或本卷 = 无有效落点）。 */
  dropTarget: string | null;
}

export interface QuoteHoldOptions {
  /** 这一枚夹签**原本属于哪一卷**（`s:<id>` → `"<id>"`）；空串 = 纸期/无卷。 */
  ownSession: string;
  /** 起手（长按满 320ms）。 */
  onArm?: () => void;
  /** 松手落在**别的卷**上：把夹签递给它。 */
  onDrop: (targetSession: string) => void;
  /** 无效落点（空白 / 本卷 / Esc / 位移超限）。 */
  onAbandon?: () => void;
}

/** 摘掉可投放态的 DOM 打标（幂等：没打标时什么都不做）。 */
function clearDomMarks(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.remove('pp-quote-dropping');
  for (const el of document.querySelectorAll('[data-quote-drop]')) el.removeAttribute('data-quote-drop');
}

/**
 * 长按拖拽把夹签递给另一卷。返回 `state` 与 `begin`（挂在夹签轨那枚的 onPointerDown 上）。
 *
 * ⚠ 没起手（320ms 内松手 / 位移超限）时**什么都不做**——轻点仍走既有快路（引用到本卷），
 *   本 hook 不许吞掉它（方案 §2.2：两个入口并存，不是替换）。
 */
export function useQuoteHold({ ownSession, onArm, onDrop, onAbandon }: QuoteHoldOptions) {
  const [state, setState] = useState<QuoteHoldState>({ holding: false, dragging: false, dropTarget: null });
  /** 长按计时器与「已起手」标记（ref：手势回调里要读最新值，state 会滞后一帧）。 */
  const timer = useRef<number | null>(null);
  const armed = useRef(false);
  const latest = useRef({ ownSession, onArm, onDrop, onAbandon });
  latest.current = { ownSession, onArm, onDrop, onAbandon };

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /** 可投放态挂**根元素 class**（不是跨产物 store、不是新 faceDeps 键）——
   *  先例 = use-composer-float 的 pp-composer-dragging：CSS 是唯一消费面。 */
  const arm = useCallback(() => {
    timer.current = null;
    armed.current = true;
    if (typeof document !== 'undefined') document.documentElement.classList.add('pp-quote-dropping');
    setState({ holding: false, dragging: true, dropTarget: null });
    latest.current.onArm?.();
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    armed.current = false;
    clearDomMarks();
    setState({ holding: false, dragging: false, dropTarget: null });
  }, [clearTimer]);

  /** 收尾（只在**起手过**时提交结果；没起手 = 轻点/滚动，交回快路）。 */
  const finish = useCallback(
    (target: string | null) => {
      const wasArmed = armed.current;
      reset();
      if (!wasArmed) return;
      const own = latest.current.ownSession;
      if (target && target !== own) latest.current.onDrop(target);
      else latest.current.onAbandon?.();
    },
    [reset],
  );

  /** 目标卷打标（§6.2「悬停的卷：描线加粗 + 底色加深」）——旧目标先摘。 */
  const markTarget = useCallback((target: string | null) => {
    if (typeof document === 'undefined') return;
    for (const el of document.querySelectorAll('[data-quote-drop]')) el.removeAttribute('data-quote-drop');
    if (target) {
      document
        .querySelector<HTMLElement>(`.pp-region[data-session-id="${target}"]`)
        ?.setAttribute('data-quote-drop', '1');
    }
    setState((prev) => (prev.dropTarget === target ? prev : { ...prev, dropTarget: target }));
  }, []);

  /* 手势核心（E1：指针监听只许出现在登记表内）。阈值 = 长按容差：位移超限即「用户在滚动」，
   * 核心会走 onStart——那一支里把长按作废（起手之后才允许移动，那才是拖）。 */
  const gesture = useDragGesture({
    threshold: LONG_PRESS_SLOP,
    onStart: () => {
      // 未起手就过阈值 = 滚动/点选：长按作废，别吞用户的滚动
      if (!armed.current) reset();
    },
    onMove: (_e, d) => {
      if (!armed.current) return;
      markTarget(regionAtPoint(d.x, d.y));
    },
    onEnd: (_e, d) => {
      if (!armed.current) return;
      finish(regionAtPoint(d.x, d.y));
    },
    onCancel: () => {
      // Esc / 失联 / 没过阈值就松手：起手过 ⇒ 一次「放弃」；没起手 ⇒ 交回快路
      finish(null);
    },
  });

  /** 挂在夹签本体的 onPointerDown 上：起手计时 + 交给手势核心。 */
  const begin = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      setState({ holding: true, dragging: false, dropTarget: null });
      clearTimer();
      timer.current = window.setTimeout(arm, LONG_PRESS_MS);
      gesture.begin(e);
    },
    [arm, clearTimer, gesture],
  );

  // 卸载即清计时器与 DOM 打标（工作区级资源不留在窗口/根元素上）
  useEffect(
    () => () => {
      clearTimer();
      clearDomMarks();
    },
    [clearTimer],
  );

  return { state, begin, cancel: () => finish(null) };
}
