// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// WinControls — 自定义窗口控制（decorations:false）。
// V5 拆除（2026-08-22）：自 CommandBar 抽出——CommandBar 随旧观测台 chrome
// 退役，窗口控制在纸壳顶部浮件（PaperPanel，2026-09-17 前为书眉）与案卷
// 首页（SessionsHome）继续承载。沿用 __TAURI_INTERNALS__ 直调 IPC
//（不引 @tauri-apps/api 依赖面）。

import { useCallback, useEffect, useRef, useState } from 'react';

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
function winCmd(c: string): void {
  const p = tauri()?.invoke(`plugin:window|${c}`, { label: winLabel() });
  if (p && typeof p.catch === 'function') p.catch((e: unknown) => console.error(`[win] ${c}:`, e));
}

export function WinControls() {
  const [maximized, setMaximized] = useState(false);
  // 最大化按钮点击后的延迟同步 timer（2026-09-01 审计：此前不受清理，卸载后可触发 setState）
  const syncTimerRef = useRef<number | undefined>(undefined);
  const sync = useCallback(async () => {
    try {
      const ok = await tauri()?.invoke('plugin:window|is_maximized', { label: winLabel() });
      setMaximized(!!ok);
    } catch {
      /* best-effort */
    }
  }, []);
  useEffect(() => {
    void sync(); // 初始状态（最大化启动/Snap 布局下按钮图标正确）
    let timer = 0;
    const onResize = () => {
      clearTimeout(timer);
      timer = window.setTimeout(sync, 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(timer);
      clearTimeout(syncTimerRef.current);
    };
  }, [sync]);
  return (
    <span className="wc-btns">
      <button type="button" className="wc-btn" title="最小化" onClick={() => winCmd('minimize')}>
        ─
      </button>
      <button
        type="button"
        className="wc-btn"
        title={maximized ? '还原' : '最大化'}
        onClick={() => {
          winCmd('toggle_maximize');
          clearTimeout(syncTimerRef.current);
          syncTimerRef.current = window.setTimeout(sync, 200); // 等窗口动画完成
        }}
      >
        {maximized ? '❐' : '□'}
      </button>
      <button type="button" className="wc-btn wc-btn-close" title="关闭" onClick={() => winCmd('close')}>
        ✕
      </button>
    </span>
  );
}
