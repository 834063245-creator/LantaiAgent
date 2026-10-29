// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 悬停提示宿主（tooltip · 2026-10-30）—— 全库单点，挂在 App 根。

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './tip.css';

/** 悬停出场延迟：原生 title 约 1000ms 太钝；<200ms 则扫过一排按钮每个都弹。 */
const HOVER_DELAY_MS = 320;
/** 键盘聚焦出场延迟：键盘用户是明确导航过去的，没有「扫过」问题。 */
const FOCUS_DELAY_MS = 150;
/** 离开宽限：移开后不立刻收，留一窗让「移到相邻件」撤销这次退场。
 *  没有它，两个按钮之间的 1px 间隙会触发 mouseout → 提示闪一下消失、再等 320ms 重出
 *  ——扫过一排按钮时的噪声全部来自这里（本文件的测试用例钉住了它）。 */
const LEAVE_GRACE_MS = 80;
/** 提示框与目标件的间隙（px）——给箭头留位。 */
const GAP = 9;
/** 提示框距视口边缘的最小内距（px）。 */
const VIEWPORT_PAD = 8;
/** 箭头尖角距提示框左右缘的最小距离（px）——防止尖角跑到圆角上。 */
const ARROW_INSET = 12;
/** 提示体 DOM id：显示期挂到锚点的 `aria-describedby` 上。 */
const TIP_BODY_ID = 'lt-tip-body';

interface TipTarget {
  el: HTMLElement;
  label: string;
  hint: string | null;
}

/** 从事件目标向上找最近的 `[data-tip]` 并读出两层文案。 */
function readTarget(node: EventTarget | null): TipTarget | null {
  const el = node instanceof Element ? (node.closest('[data-tip]') as HTMLElement | null) : null;
  if (!el) return null;
  const label = el.getAttribute('data-tip');
  if (!label) return null;
  return { el, label, hint: el.getAttribute('data-tip-hint') };
}

export function TipHost() {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  /** 离开宽限定时器（见 LEAVE_GRACE_MS）。 */
  const leaveTimerRef = useRef<number | null>(null);
  /** 当前是否处于显示态（事件回调读它决定「立即换」还是「等延迟」）。 */
  const shownRef = useRef(false);
  /** 当前目标（判断是否同一目标重复触发）。 */
  const targetRef = useRef<TipTarget | null>(null);

  const [target, setTarget] = useState<TipTarget | null>(null);
  const [on, setOn] = useState(false);

  // 最新值镜像：事件监听只注册一次，靠 ref 读当下状态（不重订阅）
  useEffect(() => {
    shownRef.current = on;
    targetRef.current = target;
  });

  // ── 事件委托（capture：先于任何 stopPropagation 拿到事件）──────────────────
  useEffect(() => {
    /** 撤销待播的出场与待收的退场（进入新目标时先调它）。 */
    const cancelPending = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (leaveTimerRef.current !== null) {
        window.clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
    };

    const arm = (t: TipTarget, delay: number) => {
      cancelPending();
      // 已在显示态切到相邻目标 → 立即换内容、不重播入场（扫过一排按钮不闪）
      const wait = shownRef.current ? 0 : delay;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setTarget(t);
        setOn(true);
      }, wait);
    };

    /** 立即收——只给「不可挽回」的场景（窗口失焦）。 */
    const disarm = () => {
      cancelPending();
      setOn(false);
    };

    /** 延迟收——留一个宽限窗，让「移到相邻件」把这次退场撤销掉。 */
    const disarmSoon = () => {
      cancelPending();
      leaveTimerRef.current = window.setTimeout(() => {
        leaveTimerRef.current = null;
        setOn(false);
      }, LEAVE_GRACE_MS);
    };

    const onOver = (ev: MouseEvent) => {
      // 按住鼠标（拖拽）时不出提示——纯干扰
      if (ev.buttons !== 0) {
        disarm();
        return;
      }
      const t = readTarget(ev.target);
      if (!t) return;
      // 在同一目标的子元素间移动（mouseover 会反复触发）→ 不动
      if (targetRef.current?.el === t.el && shownRef.current) return;
      arm(t, HOVER_DELAY_MS);
    };

    const onOut = (ev: MouseEvent) => {
      const from = readTarget(ev.target);
      if (!from) return;
      const to = ev.relatedTarget;
      // 移进自己的子元素不算离开
      if (to instanceof Node && from.el.contains(to)) return;
      disarmSoon();
    };

    const onFocusIn = (ev: FocusEvent) => {
      const t = readTarget(ev.target);
      if (t) arm(t, FOCUS_DELAY_MS);
    };

    const onFocusOut = (ev: FocusEvent) => {
      const from = readTarget(ev.target);
      if (!from) return;
      const to = ev.relatedTarget;
      if (to instanceof Node && from.el.contains(to)) return;
      disarmSoon();
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    // 窗口失焦（切到别的应用）时收掉——回来时鼠标位置已不可信
    window.addEventListener('blur', disarm);

    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      window.removeEventListener('blur', disarm);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
    };
  }, []);

  // ── 定位：上方优先 → 空间不足翻转下方 → 水平夹取进视口 ────────────────────
  useEffect(() => {
    if (!target) return;
    const box = boxRef.current;
    const anchor = target.el;
    if (!box) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      // 目标滚出视口 → 收掉（提示不跟着跑到屏外）
      if (a.bottom < 0 || a.top > window.innerHeight || a.right < 0 || a.left > window.innerWidth) {
        setOn(false);
        return;
      }
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      let side: 'top' | 'bottom' = 'top';
      let top = a.top - h - GAP;
      if (top < VIEWPORT_PAD) {
        side = 'bottom';
        top = a.bottom + GAP;
      }
      const center = a.left + a.width / 2;
      const left = Math.max(VIEWPORT_PAD, Math.min(center - w / 2, window.innerWidth - w - VIEWPORT_PAD));
      const arrowX = Math.max(ARROW_INSET, Math.min(center - left, w - ARROW_INSET));
      box.style.left = `${Math.round(left)}px`;
      box.style.top = `${Math.round(top)}px`;
      box.style.setProperty('--tip-arrow-x', `${Math.round(arrowX)}px`);
      box.dataset.side = side;
    };

    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [target]);

  // ── 无障碍：显示期把提示体挂到锚点的 aria-describedby ─────────────────────
  // 注意：提示**不得是唯一信息源**——纯图标按钮仍须自备 aria-label。
  useEffect(() => {
    const el = target?.el;
    if (!el) return;
    if (on) el.setAttribute('aria-describedby', TIP_BODY_ID);
    return () => el.removeAttribute('aria-describedby');
  }, [target, on]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={boxRef}
      id={TIP_BODY_ID}
      role="tooltip"
      aria-hidden={!on}
      className={`lt-tip${on ? ' is-on' : ''}`}
      data-side="top"
    >
      <span className="lt-tip-label">{target?.label ?? ''}</span>
      {target?.hint ? <span className="lt-tip-hint">{target.hint}</span> : null}
    </div>,
    document.body,
  );
}
