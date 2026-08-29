// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 模态弹层焦点管理（2026-08-29 UI 走查批）。
// 打开时焦点移入弹层、Tab 圈定在弹层内、卸载时归还焦点给打开者。
// 消费者：ConfirmDialog / AddProviderSheet / CommandPalette。
// Escape 与遮罩关闭仍由各组件自持（本件只管焦点进出与 Tab 环游）。

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

function firstFocusable(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(FOCUSABLE);
}

/** 可见性判定不用 offsetParent——fixed 定位祖先下 offsetParent 恒为 null。 */
function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

/**
 * 挂载弹层焦点环。返回清理函数：移除监听 + 焦点归还打开者。
 * 用法：useEffect(() => (open && root ? mountDialogFocus(root, { initial }) : undefined), [open]);
 */
export function mountDialogFocus(root: HTMLElement, opts?: { initial?: HTMLElement | null }): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  (opts?.initial ?? firstFocusable(root))?.focus();

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && root.contains(active);
    if (e.shiftKey && (!inside || active === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  };
  root.addEventListener('keydown', onKey);
  return () => {
    root.removeEventListener('keydown', onKey);
    opener?.focus();
  };
}
