// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 5（hologram/shell-keyguard）：浏览器快捷键抑制（capture 阶段拦截
// 浏览器默认行为，防 F5/Ctrl+R 刷新打断应用态）。
// 自 main.ts 517-574 机械迁移（IIFE → boot 函数体）。

export function bootKeyguard(): void {
  const isEditing = () => {
    const el = document.activeElement;
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
  };
  const APP_CTRL_KEYS = new Set(['l', 'd', 'e']);
  const APP_CTRL_KEYS_EXTRA = new Set(['`', ',']);
  window.addEventListener(
    'keydown',
    (e) => {
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;
      if (isEditing()) {
        if (mod && !shift && !alt && new Set(['c', 'v', 'x', 'z', 'y', 'a']).has(key)) return;
        if (mod && !alt && ['r', 'p', 's', 'u', 'o', 'n'].includes(key)) {
          e.preventDefault();
          return;
        }
        if (key === 'f5' || key === 'f12') {
          e.preventDefault();
          return;
        }
        if (alt && (key === 'arrowleft' || key === 'arrowright')) {
          e.preventDefault();
          return;
        }
        return;
      }
      // 应用专属快捷键
      if (mod && !shift && !alt && APP_CTRL_KEYS.has(key)) return;
      if (mod && !shift && !alt && APP_CTRL_KEYS_EXTRA.has(key)) return;
      // 放行：标准浏览器复制/粘贴/全选/撤销/重做
      if (mod && !shift && !alt && new Set(['c', 'v', 'x', 'a', 'z', 'y']).has(key)) return;
      if (!mod && !alt && !shift && (key === 'f' || key === 'escape' || key === 'b')) return;
      if (['f1', 'f3', 'f4', 'f5', 'f6', 'f7', 'f10', 'f11', 'f12'].includes(key)) {
        e.preventDefault();
        return;
      }
      if (mod && !alt) {
        e.preventDefault();
        return;
      }
      if (alt) {
        e.preventDefault();
        return;
      }
      if (key === 'backspace') {
        e.preventDefault();
        return;
      }
    },
    { capture: true },
  );
}
