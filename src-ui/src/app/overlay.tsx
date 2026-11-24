// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 浮层原语（2026-08-29 frontend-overlay-a11y-plan 档位 A-1）。
//
// - useDialogEscape / useOutsideClose：已拆到 `app/overlay-hooks.ts`（2026-11-24 架阁批）——
//   产物域只别名 react、不别名 react-dom，钩子与 createPortal 容器分家后，内置插件
//   产物可以直接复用同一份实现。本文件原样 re-export，旧调用点零改动。
// - Overlay：统一浮层容器 —— 可选 createPortal 到 body（全局模态）、统一 Escape、
//   可选背景 inert（读屏器虚拟光标不可达背景）。
//
// 产品决策（档位 B）：面板内模态就地渲染（portal=false，视觉零变化）；全局模态
// 用 portal=true。二者共享 Escape/inert/遮罩点关语义。

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialogEscape, useOutsideClose } from './overlay-hooks';

export type { DialogEscapeOptions, OutsideCloseOptions } from './overlay-hooks';
export { useDialogEscape, useOutsideClose } from './overlay-hooks';

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
