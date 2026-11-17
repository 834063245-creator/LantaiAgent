// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 浮层原语（2026-08-29 frontend-overlay-a11y-plan 档位 A-1）。
//
// - useDialogEscape：全库单点的 Escape 关闭 hook（收编 9 处重复 document keydown）。
// - useOutsideClose：全库单点的**外点关闭** hook（2026-11-17 交互原语收口批 A；
//   收编 CommandPalette / SessionSidebar / ModelSelector / StatusLine 四处
//   document mousedown + Overlay 自己的遮罩——见 docs/plans/interaction-primitive-plan.md §2.2）。
// - Overlay：统一浮层容器 —— 可选 createPortal 到 body（全局模态）、统一 Escape、
//   可选背景 inert（读屏器虚拟光标不可达背景）。
//
// 产品决策（档位 B）：面板内模态就地渲染（portal=false，视觉零变化）；全局模态
// 用 portal=true。二者共享 Escape/inert/遮罩点关语义。

import type { ReactNode, RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface DialogEscapeOptions {
  /** 监听是否生效（浮层 open 时才注册）；缺省 true */
  enabled?: boolean;
  /** capture 阶段监听（先于 useGlobalKeys 的 window 冒泡）；缺省 true */
  capture?: boolean;
  /** Escape 时 preventDefault + stopPropagation（面板内模态防穿透 esc-layer）；缺省 true */
  blockPropagation?: boolean;
}

/** 单点 Escape hook：浮层开启期间按 Esc → onClose。
 *  capture 先于 useGlobalKeys（window 冒泡），blockPropagation 阻止穿透关闭底层面板。 */
export function useDialogEscape(onClose: () => void, opts?: DialogEscapeOptions): void {
  const { enabled = true, capture = true, blockPropagation = true } = opts ?? {};
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (blockPropagation) {
        e.preventDefault();
        e.stopPropagation();
      }
      onClose();
    };
    document.addEventListener('keydown', onKey, capture);
    return () => document.removeEventListener('keydown', onKey, capture);
  }, [enabled, capture, blockPropagation, onClose]);
}

export interface OutsideCloseOptions {
  /** 监听是否生效（浮层 open 时才注册）；缺省 true */
  enabled?: boolean;
  /** capture 阶段监听（画布在冒泡阶段 preventDefault 吃掉 mousedown，冒泡收不到）；缺省 true */
  capture?: boolean;
  /** 判「这一下算不算落在外面」；缺省 = 元素不含事件源。差异口径必须在调用点显式写出，
   *  不许静默统一（四处原判据本来就不完全一样，见 plan §3 批 A 表）。 */
  isOutside?: (e: MouseEvent, el: HTMLElement) => boolean;
  /** 监听面；缺省 'mousedown'（与收编前的四处一致：按下即判，不等抬起） */
  event?: 'mousedown' | 'pointerdown';
}

/** 单点外点关闭 hook：在 ref 元素**外面**按下 → onOutside。
 *
 *  三条纪律（与 useDialogEscape 同源，见 plan §2.2）：
 *   ① **capture 缺省**：画布在冒泡阶段 `preventDefault`（平移手势），冒泡面收不到；
 *   ② **不 `preventDefault`**：外点关闭只观察这次点击，不消费它——被点的那个东西照常干活；
 *   ③ **ref 未挂 = 不判**：元素还没渲染出来时猜「外」会误关（首帧/动画中）。
 *  元素自己的「点自身算不算外」由调用点用 `isOutside` 显式给。 */
export function useOutsideClose(
  ref: RefObject<HTMLElement | null>,
  onOutside: (e: MouseEvent) => void,
  opts?: OutsideCloseOptions,
): void {
  const { enabled = true, capture = true, isOutside, event = 'mousedown' } = opts ?? {};
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      const out = isOutside ? isOutside(e, el) : !el.contains(e.target as Node);
      if (out) onOutside(e);
    };
    document.addEventListener(event, onDown, capture);
    return () => document.removeEventListener(event, onDown, capture);
  }, [enabled, capture, isOutside, event, onOutside, ref]);
}

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  /** 渲染到 document.body（全局模态）；缺省 false = 就地渲染（面板内模态） */
  portal?: boolean;
  /** 背景 inert：模态开启时把遮罩兄弟子树 inert（读屏器虚拟光标不可达背景） */
  inertBackground?: boolean;
  /** 遮罩容器类名（面板内模态沿用 .cd-overlay） */
  className?: string;
  /** 遮罩点击空白关闭（缺省 true） */
  veilClose?: boolean;
  children: ReactNode;
}

export function Overlay({
  open,
  onClose,
  portal = false,
  inertBackground = false,
  className = 'cd-overlay',
  veilClose = true,
  children,
}: OverlayProps) {
  const veilRef = useRef<HTMLDivElement | null>(null);

  useDialogEscape(onClose, { enabled: open });

  // 背景 inert：把遮罩的兄弟子树 inert（面板内模态 = 面板的 header/tabs/content 等），
  // 关闭时还原 —— aria-modal 语义的硬保障（读屏器虚拟光标无法穿透）。
  useEffect(() => {
    if (!open || !inertBackground) return;
    const veil = veilRef.current;
    if (!veil?.parentElement) return;
    const siblings = Array.from(veil.parentElement.children).filter((el) => el !== veil);
    const prev = siblings.map((el) => (el as HTMLElement).inert);
    for (const el of siblings) {
      (el as HTMLElement).inert = true;
    }
    return () => {
      siblings.forEach((el, i) => {
        (el as HTMLElement).inert = prev[i] ?? false;
      });
    };
  }, [open, inertBackground]);

  // 遮罩点空白 = 关闭（2026-11-17 批 A 收编）：原先是 JSX 上的 onMouseDown，
  // 与四处文档级外点关闭是同一次「点空白」的两个半场（Escape 已收编、外点未收编）；
  // 现改走同一条 useOutsideClose，判据显式写成「事件源就是遮罩本身」。
  useOutsideClose(veilRef, onClose, {
    enabled: open && veilClose,
    isOutside: (e, el) => e.target === el,
  });

  if (!open) return null;
  const veil = (
    <div ref={veilRef} className={className}>
      {children}
    </div>
  );
  return portal ? createPortal(veil, document.body) : veil;
}
