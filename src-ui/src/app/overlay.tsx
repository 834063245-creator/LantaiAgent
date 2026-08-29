// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 浮层原语（2026-08-29 frontend-overlay-a11y-plan 档位 A-1）。
//
// - useDialogEscape：全库单点的 Escape 关闭 hook（收编 9 处重复 document keydown）。
// - Overlay：统一浮层容器 —— 可选 createPortal 到 body（全局模态）、统一 Escape、
//   可选背景 inert（读屏器虚拟光标不可达背景）。
//
// 产品决策（档位 B）：面板内模态就地渲染（portal=false，视觉零变化）；全局模态
// 用 portal=true。二者共享 Escape/inert/遮罩点关语义。

import type { ReactNode } from 'react';
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

  if (!open) return null;
  const veil = (
    // biome-ignore lint/a11y/noStaticElementInteractions: 模态遮罩点击空白 = 关闭（明确对话框语义）
    <div
      ref={veilRef}
      className={className}
      onMouseDown={veilClose ? (e) => (e.target === e.currentTarget ? onClose() : undefined) : undefined}
    >
      {children}
    </div>
  );
  return portal ? createPortal(veil, document.body) : veil;
}
