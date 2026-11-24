// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// pointer-shield — 宿主按住期间把 iframe 从命中面摘掉（2026-11-24 指针穿透批）。
//
// 病灶：iframe 是**独立 document**。宿主在画布上按住拖动、指针经过插件窗 / HTML 卡时，
// pointermove / pointerup 被投递进 iframe，父文档一个都收不到——画布平移当场停摆；
// 若松手落在 iframe 上，父文档连 pointerup 都没有 ⇒ panningRef / pointer claim 永久
// 留在在途态，之后任意 pointermove 都继续拖画布，其它手势则被 claim 静默拒绝
//（用户读作「画布操作失灵」）。React 层的 stopPropagation 管不到跨 document 的投递，
// 旧防线在这里是空的。
//
// 裁决：**宿主自己按下期间，iframe 一律不吃指针**（CSS 见 foundation.css 的
// `html[data-pointer-held] iframe`）。iframe 内起手时父文档收不到 pointerdown
//（浏览器把事件送进子文档），所以窗内交互不受影响；松手 / 失焦 / 指针离开即摘标记。
// 与 useDragGesture 的 pointer capture 互补：capture 保单个手势，盾保所有没走
// capture 的手势（拖选自动滚屏、纸条起手）以及 capture 失效的宿主。

import { useEffect } from 'react';

/** 标记落在 <html> 上——CSS 以此统一摘掉所有 iframe 的命中（插件窗 / HTML 卡 / 架阁卡）。 */
export const POINTER_HELD_ATTR = 'data-pointer-held';

/** OS 原生拖动热区：press 后进入系统模态循环，mouseup 不回页面——别挂盾（见 app/window-drag.ts）。 */
const NATIVE_DRAG_SELECTOR = '.pp-chrome, .sh-head, .rz-zone';

/** 挂一次（App 根）：宿主按住期间维护标记，卸载 / 失焦时清干净。 */
export function usePointerShield(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const root = document.documentElement;
    /** 按 pointerId 记账：多指同时按下时，抬起一根不能把盾收了。 */
    const held = new Set<number>();
    const sync = (): void => {
      if (held.size > 0) root.setAttribute(POINTER_HELD_ATTR, '');
      else root.removeAttribute(POINTER_HELD_ATTR);
    };
    const down = (e: PointerEvent): void => {
      // 只认主键（鼠标左键 / 触控笔尖 / 单指）。右键菜单与中键滚动不接管。
      if (e.button !== 0) return;
      /* iframe 内的按下父文档本来看不见；万一宿主拿到的是 iframe 本体（某些宿主 /
       * 合成事件），也绝不能在这一刻把它关掉——那会把窗内交互掐死。原生窗口拖动
       * 热区同理：那一下进入 OS 模态循环，mouseup 不回页面，盾会等不到 up。 */
      const target = e.target;
      if (target instanceof Element && (target.closest('iframe') || target.closest(NATIVE_DRAG_SELECTOR))) return;
      held.add(e.pointerId);
      sync();
    };
    const up = (e: PointerEvent): void => {
      if (!held.delete(e.pointerId)) return;
      sync();
    };
    /** 失联（窗口失焦 / 切走 / 指针离开文档）：下一次 pointerup 不会来，整账清零。 */
    const clear = (): void => {
      if (held.size === 0) return;
      held.clear();
      sync();
    };
    /* 兜底：OS 拖动 / 在窗外松手等丢 up 的路径之后，第一帧「无按键」的移动即摘盾。
     * 指针都松开了还挂着盾 = iframe 永远点不动，比提前收盾危险。 */
    const move = (e: PointerEvent): void => {
      if (held.size > 0 && e.buttons === 0) clear();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') clear();
    };
    /* 捕获面：帧内 / 浮层可能在 React 层 stopPropagation，冒泡面收不到。 */
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('mouseleave', clear);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('mouseleave', clear);
      held.clear();
      root.removeAttribute(POINTER_HELD_ATTR);
    };
  }, []);
}
