// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 全局快捷键 — 从 main.ts 的 window keydown 监听器平移而来（P1），
// V5 拆除（2026-08-22）后收敛到纸壳时代快捷键面。
// 只分发动作；具体实现由 actions 注册表（actions 壳行）注入。

import { useEffect } from 'react';
import { useDockStore } from '../state/dock-store';
import { runAction } from './actions';
import { useShellStore } from './shell-store';

function isEditing(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useShellStore.getState();
      const dock = useDockStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Ctrl+K 命令面板 — 编辑中也可用。
      // settings 面板开着时不开（z:400 会把面板整个盖住 = 按了没反应的假死观感）；
      // settings 自己的弹层（cd-overlay）有 Esc 处理，这里不抢。
      if (mod && !e.shiftKey && !e.altKey && key === 'k') {
        if (dock.isOpen('settings')) return;
        e.preventDefault();
        st.setPaletteOpen(!st.paletteOpen);
        return;
      }
      // 面板打开时其余按键交给面板自身处理（仅兜底 Esc）
      if (st.paletteOpen) {
        if (e.key === 'Escape') st.setPaletteOpen(false);
        return;
      }
      if (isEditing()) return;

      if (mod && !e.shiftKey && !e.altKey && key === 'p') {
        // 纸视图开合（关 = 回案卷首页；拦截浏览器打印——本应用无打印场景）
        e.preventDefault();
        runAction('toggle-paper');
      } else if (mod && !e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault();
        runAction('toggle-settings');
      } else if (e.key === 'Escape') {
        runAction('esc-layer');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
