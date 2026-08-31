// plugins/builtin/paper-shell/ToastHost.tsx — 全局瞬时提示浮层（2026-08-31）。
//
// 贴黄拆迁后的 toast 通道宿主：顶中浮层，3.2s（error 6.4s）后淡出。
// 经 body portal 渲染——避开纸面 transform/filter 祖先的包含块。
// level 语义色走纸壳 token：info 墨纹 / warn 赭黄 / error 朱砂。
// 换行由 .pp-toast 的 white-space: pre-line 承载（多行命令输出不拆 DOM）。

import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useToastStore } from '../../../state/toast-store';
import './ToastHost.css';

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="pp-toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pp-toast pp-toast-${t.level}`}
          style={{ '--pp-toast-hold': `${t.holdMs}ms` } as CSSProperties}
        >
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
  );
}
