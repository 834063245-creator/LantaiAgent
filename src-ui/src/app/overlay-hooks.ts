// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 浮层交互原语（hooks 面）——`useDialogEscape` / `useOutsideClose` 的唯一实现。
//
// 2026-11-24 架阁全量迭代批从 `app/overlay.tsx` **原样拆出**：overlay.tsx 同时含
// `<Overlay>` 容器（import react-dom 的 createPortal），而**产物域**（内置插件产物）
// 的构建只把 `react` 别名到宿主桥、不别名 react-dom——产物一旦 import overlay.tsx
// 就会内联第二份 react-dom。钩子本身只依赖 react，拆成独立模块后壳层与产物域
// 共用同一份实现（「单一门」不破，也不必在产物里再写一个外点关闭）。
//
// 语义与纪律与拆分前逐字一致（`overlay.tsx` 仍 re-export，旧调用点零改动）：
// - useDialogEscape：capture 阶段监听，先于 useGlobalKeys 的 window 冒泡；默认
//   preventDefault + stopPropagation（面板内模态防穿透 esc-layer）。
// - useOutsideClose：capture 缺省；不 preventDefault（只观察这次点击，被点的
//   东西照常干活）；ref 未挂 = 不判；「点自身算不算外」由调用点用 isOutside 显式给。

import type { RefObject } from 'react';
import { useEffect } from 'react';

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
