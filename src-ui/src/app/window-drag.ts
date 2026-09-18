// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// window-drag — decorations:false 窗口的标题栏交互（拖拽 / 双击最大化）。
//
// **app-region 全面退役（2026-09-14 事故立法）**：Windows 下 WebView2 把页面的
// `-webkit-app-region` 拖动区**光栅化成一叠薄子窗**（实测 44 个 `Chrome_WidgetWin_0`，
// y 0-12/12-14/…/56-58/58-63/63-88），且**只在宿主初始化那一刻按当时的页面算一次、
// 永不重算**——启动落在首页就按首页 `.sh-head`（~88px 高）算，进了画布视图于是：
//   ① 多出一条 88px「幽灵标题栏」压在画布顶缘与目次带最上方 → 在那段里拖内容＝挪窗口
//      （用户三报，并直接点出「问题是出在标题栏的触发范围上」）；
//   ② 浮件里应用自绘的按钮（缩放/设置/回放/窗口钮）按**首页布局**被 caption 吃掉
//      （实机：真点缩放钮无任何反应）。
// 页面侧的 `no-drag` 挖除只对拖动元素的后代生效（窗口钮正是如此），对兄弟元素无效；
// 给浮件以下各面加 no-drag 挖不动那条带，删掉 app-region 又会让窗口钮一起被吃掉。
//
// **修法**：页面**不再声明任何 app-region**（首页 + 画布两处都不声明 → 根本不产生行窗），
// 标题栏交互改由应用自己判定：画布顶部浮件/首页顶栏接 pointerdown → Tauri 原生
// `plugin:window|start_dragging`（命中面恰好是该元素），双击 → `toggle_maximize`。
// 壳层另有兜底（`src-tauri/src/window_drag_band.rs`：万一出现 caption，一律降为 client）。
// **2026-09-17 标题栏拆除批**：画布视图的书眉布局行退役 ⇒ 画布铺满整窗（顶缘 = 屏缘，
// 边缘滚动的「指针甩到屏顶」才成立）；窗口拖动热区 = 顶部浮件本身（其非交互件：
// `画布` 二字与件间空白），画布视图不再留整条拖动带。
//
// **2026-09-18 双击回归根治**：09-14 那批把「双击最大化」建在 DOM `dblclick` 上，
// 实机不成立——`pointerdown` 一响就把窗口交给 **OS 模态移动循环**
// （tao `drag_window`：`ReleaseCapture()` + `PostMessage(WM_NCLBUTTONDOWN, HTCAPTION)`），
// 这一次点击的 mouseup 再也不进页面（旁证：tao 自己在 `WM_EXITSIZEMOVE` 里补发一枚
// 合成 `WM_LBUTTONUP`）。两次点击各开一次循环、两枚 mouseup 全被吃掉 ⇒ Blink 永远
// 凑不齐一次完整 click ⇒ **`dblclick` 一次都不产生**（09-14 验收清单逐条都是拖动，
// 唯独没有双击——回归因此潜伏四天）。
// 现在的判据：**双击由 pointerdown 自己数**（同点位 + 双击窗口内的第二下 = 双击），
// 且第二下**不再进 OS 拖动循环**（否则拖动会与最大化互相打架）；`onTopbarDoubleClick`
// 保留为「页面收得到 dblclick 的平台」的同一对点击去重兜底——两条路只算一次。

interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } };
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

/** 标题栏手势事件的最小形状（React 的 PointerEvent / MouseEvent 都满足）。 */
export interface TitlebarGestureEvent {
  target: EventTarget | null;
  clientX: number;
  clientY: number;
}

/** 双击窗口（ms）——与 OS 默认 500ms 同量级；慢于此 = 两次独立单击。 */
const DOUBLE_CLICK_MS = 450;

/** 双击容差（px）——两次按下之间允许的手抖位移；超过即视为「点一下、再点别处」。
 *  与 OS 判双击用的 `SM_CXDOUBLECLK`（默认 4px）同量级。 */
const DOUBLE_CLICK_SLOP_PX = 6;

/** 最近一次标题栏按下 + 最近一次「已由 pointerdown 判为双击」的时刻。
 *  **进程级单例（CONVENTIONS §1.10 第 3 类）**：单窗口单一指针的手势瞬态，
 *  既非业务状态也无跨面板消费者，故不进 store。 */
let lastDown: { at: number; x: number; y: number } | null = null;
let lastPointerDownDoubleClickAt = Number.NEGATIVE_INFINITY;

function tauri(): TauriInternals | undefined {
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
}

function winLabel(): string {
  return tauri()?.metadata?.currentWindow?.label || 'main';
}

/** 标题栏热区内的「交互件」——命中它们不做窗口拖拽/最大化（自己接手势）。 */
export function isTopbarInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('button, input, kbd, a, select, textarea, [role="button"], .wc-btns, .sl-root') !== null;
}

/** 开始拖动窗口（Tauri 原生通道；无 Tauri 运行时 = no-op，纯浏览器预览不炸）。 */
export function startWindowDrag(): void {
  const ta = tauri();
  if (!ta?.invoke) return;
  void ta.invoke('plugin:window|start_dragging', { label: winLabel() }).catch((e: unknown) => {
    console.warn('[window] start_dragging 失败:', e);
  });
}

/** 双击标题栏 → 最大化/还原（Tauri 原生通道）。 */
export function toggleWindowMaximize(): void {
  const ta = tauri();
  if (!ta?.invoke) return;
  void ta.invoke('plugin:window|toggle_maximize', { label: winLabel() }).catch((e: unknown) => {
    console.warn('[window] toggle_maximize 失败:', e);
  });
}

/** 标题栏 pointerdown 处理器（画布顶部浮件/首页顶栏共用）：交互件除外；
 *  **同一位置、双击窗口内的第二次按下 = 双击 → 最大化/还原**（第二下不进 OS
 *  拖动循环）；其余情况交原生拖拽。 */
export function onTopbarPointerDown(e: TitlebarGestureEvent): void {
  if (isTopbarInteractiveTarget(e.target)) return;
  const now = Date.now();
  const doubled =
    lastDown !== null &&
    now - lastDown.at <= DOUBLE_CLICK_MS &&
    Math.abs(e.clientX - lastDown.x) <= DOUBLE_CLICK_SLOP_PX &&
    Math.abs(e.clientY - lastDown.y) <= DOUBLE_CLICK_SLOP_PX;
  // 判据是「一对点击」：判为双击即消费掉，三击的第三下重新从「第一下」起算
  lastDown = doubled ? null : { at: now, x: e.clientX, y: e.clientY };
  if (!doubled) {
    startWindowDrag();
    return;
  }
  lastPointerDownDoubleClickAt = now;
  toggleWindowMaximize();
}

/** 标题栏双击处理器（同一热区共用）：页面收得到 `dblclick` 的平台走这条；
 *  pointerdown 已判过同一对点击时让路（两条路只算一次，否则最大化后立刻还原）。 */
export function onTopbarDoubleClick(e: TitlebarGestureEvent): void {
  if (isTopbarInteractiveTarget(e.target)) return;
  if (Date.now() - lastPointerDownDoubleClickAt <= DOUBLE_CLICK_MS) return;
  toggleWindowMaximize();
}
