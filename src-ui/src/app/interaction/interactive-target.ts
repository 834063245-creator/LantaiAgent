// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// app/interaction/interactive-target — 「这一下归它自己，不归拖拽/长按」判据。
//
// 病灶（2026-11-21 用户报「画布上钉住的卡片，右上角点击回到出处位置失效」）：
// **指针捕获会改掉 click 的目标**。`useDragGesture.begin` 一拍就
// `setPointerCapture(e.currentTarget)`，此后 pointerup 与合成的 click 一律送到
// 捕获元素（实测：捕获元素收到 click，按钮自己的 click 一次都不触发）。
// 块把手（.pp-kind）里嵌着出处行按钮（.pp-prov / 「摘自 卷名」），
// 于是按下那一刻点击就被交给了把手 —— 按钮的 onClick 永不运行。
//
// 旧防法为什么失效：出处行过去在 `onMouseDown` 上停传（拦把手 mousedown 起拖）。
// 批 C3（2026-11-17）把手从 mousedown 换到 pointerdown，**pointerdown 之后浏览器
// 不再派发 mousedown**，停传一场空 —— 这正是「曾经能用、某天开始没反应」的由来。
// （同机理先例：use-quote-hold-canvas 头注 ①，块根长按引用那次是同一台手术。）
//
// 判据 = 事件源落在交互件里 ⇒ 拖拽 / 长按一律不起手（它们各有自己的 click）。
// 单一真源：块拖出、块长按引用、将来新入口共用这一张表。
// 长按引用那张表 = 本表 + 拖拽把手（长按连把手也不归它管），见 use-quote-hold-canvas。
export const INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"], [contenteditable="true"]';

/** 事件源（或其祖先）是否落在交互件里。 */
export function isInteractiveTarget(target: EventTarget | null | undefined): boolean {
  const el = target as Element | null;
  return typeof el?.closest === 'function' && el.closest(INTERACTIVE_SELECTOR) !== null;
}
