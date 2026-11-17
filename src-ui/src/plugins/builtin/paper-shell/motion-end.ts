// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// motion-end — **「这段动效什么时候播完」的唯一问法**（2026-11-17 交互原语收口批 B）。
//
// 病灶：全库 0 处 `transitionend` / `animationend`（立项时 grep 空结果），所有「窗」
// 都靠 `setTimeout(…, 260)` 估——而 260 是 `--m-sheet` 的**当前值**，改一次要同步
// 五处；改漏一处，动画播完了壳层还留着窗（或多留一帧空白）。
//
// 通则（plan §2.4）：`setTimeout()` 的毫秒数只允许出现在「元素即将消失、没有事件
// 可听」的位置。元素还在盘上，就有事件可听——那就听事件，`fallbackMs` 只作保险。
//
// 三条纪律：
//   ① **第一次结束即收**：`transitionend` 会为元素上**每一条**过渡各发一次（纸的
//      opacity 与墨的 translate 不同时收尾），靠 `settled` 短路，不靠事件次数；
//   ② **只认自己的**：`e.target !== el` 一律忽略——子元素的过渡会冒泡上来，认了就会
//      提前摘窗（卷首/块的墨比纸先落完，那是另一件事）；
//   ③ **兜底是保险不是主路径**：`prefers-reduced-motion` / 元素不可见 / 过渡被中途
//      摘掉时事件可能永不到来，兜底窗保证窗不会永久开着（漏窗 = 离场卷不卸载）。

/** 一次「等动效播完」的凭据：`cancel()` 之后 `done` 永不触发（重开/重排时用）。 */
export type MotionEndCancel = () => void;

/** 兜底窗长（ms）。**不是**任何一档 token：它只覆盖「事件没来」的意外。
 *  `--m-scene`（最长档 380ms）+ 编排错峰（`pp-drop-in` 的 0.1s）+ 两拍余量 ≈ 640。 */
export const MOTION_END_FALLBACK_MS = 640;

/**
 * 元素上**这一批**过渡/动画全部收尾时调用 `done`（只调一次）。
 * 第一次 `transitionend`/`animationend` 即认；超时走兜底。
 */
export function waitMotionEnd(el: Element, done: () => void): MotionEndCancel {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const detach = (): void => {
    el.removeEventListener('transitionend', onEnd);
    el.removeEventListener('animationend', onEnd);
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const fire = (): void => {
    if (settled) return;
    settled = true;
    detach();
    done();
  };
  const onEnd = (e: Event): void => {
    if (e.target !== el) return; // 纪律②：子元素的过渡不算
    fire();
  };
  el.addEventListener('transitionend', onEnd);
  el.addEventListener('animationend', onEnd);
  timer = setTimeout(fire, MOTION_END_FALLBACK_MS);
  return () => {
    settled = true;
    detach();
  };
}
