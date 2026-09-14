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
//   ② 书眉里应用自绘的按钮（缩放/设置/回放/窗口钮）按**首页布局**被 caption 吃掉
//      （实机：真点缩放钮无任何反应）。
// 页面侧的 `no-drag` 挖除只对拖动元素的后代生效（窗口钮正是如此），对兄弟元素无效；
// 给书眉以下各面加 no-drag 挖不动那条带，删掉 app-region 又会让窗口钮一起被吃掉。
//
// **修法**：页面**不再声明任何 app-region**（首页 + 画布两处都不声明 → 根本不产生行窗），
// 标题栏交互改由应用自己判定：书眉/首页顶栏接 pointerdown → Tauri 原生
// `plugin:window|start_dragging`（命中面恰好是该元素），双击 → `toggle_maximize`。
// 壳层另有兜底（`src-tauri/src/window_drag_band.rs`：万一出现 caption，一律降为 client）。

interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } };
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

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

/** 标题栏 pointerdown 处理器（书眉/首页顶栏共用）：交互件除外 → 原生拖拽。 */
export function onTopbarPointerDown(e: { target: EventTarget | null }): void {
  if (isTopbarInteractiveTarget(e.target)) return;
  startWindowDrag();
}

/** 标题栏双击处理器（同上）：交互件除外 → 最大化/还原。 */
export function onTopbarDoubleClick(e: { target: EventTarget | null }): void {
  if (isTopbarInteractiveTarget(e.target)) return;
  toggleWindowMaximize();
}
