// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-shell/lost-focus — 「失联即收」的**手势态**那一半（2026-10-29 抽纸条失灵批）。
//
// 为什么需要：拖拽族的收手只认 `mouseup`。窗口失焦、在窗外松手、切走应用 ⇒ mouseup
// 永远不来，各域的 in-flight ref（`dragRef` / `stripDragRef` / `resizeRef` / `liftRef`）
// 就永久留在在途态。帧循环那一半早在 `edge-scroll.ts` 收口（「不自己滚」），**手势
// 本身**仍挂着（docs/landmine-map.md V2「未修的一半」）——用户看不见的状态里，下一次
// 抽纸条按在选区上会被「有手势在途」的守卫静默吞掉，读作「抽纸条莫名其妙失灵」。
//
// 纪律：信号只有一处（blur / visibilitychange(hidden) / document.mouseleave），
// 三个手势域各自清自己的 ref 与预览态，**不提交任何结果**（失联 = 取消，无事发生）。
// 帧循环同族的三条监听在 `useEdgeAutoScroll` 里，两处判据刻意同源（可同生共死）。

import { useEffect, useRef } from 'react';

/** 注册一次、回调永远读最新闭包（各域状态都在 ref / store 里，无须重订阅——
 *  重订阅会在每次渲染的提交期留下一个监听器空窗，正是「偶尔按下没反应」的另一种来路）。 */
export function useLostFocusCancel(cancel: () => void): void {
  const latest = useRef(cancel);
  latest.current = cancel;
  useEffect(() => {
    const lost = (): void => latest.current();
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') lost();
    };
    window.addEventListener('blur', lost);
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('mouseleave', lost);
    return () => {
      window.removeEventListener('blur', lost);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('mouseleave', lost);
    };
  }, []);
}
