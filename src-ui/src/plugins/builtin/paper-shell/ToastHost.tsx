// plugins/builtin/paper-shell/ToastHost.tsx — 全局瞬时提示浮层（2026-08-31）。
//
// 贴黄拆迁后的 toast 通道宿主：顶中浮层，3.2s（error 6.4s）后淡出。
// 经 body portal 渲染——避开纸面 transform/filter 祖先的包含块。
// level 语义色走纸壳 token：info 墨纹 / warn 赭黄 / error 朱砂。
// 多行文本（goal 状态等命令输出）按行拆 div 渲染。

import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useToastStore } from '../../../state/toast-store';
import './ToastHost.css';

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const items = useMemo(() => toasts, [toasts]);
  if (items.length === 0) return null;
  return createPortal(
    <div className="pp-toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pp-toast pp-toast-${t.level}`}
          style={{ '--pp-toast-hold': `${t.holdMs}ms` } as CSSProperties}
        >
          {t.text.split('\n').map((line, i) => (
            <div className="pp-toast-line" key={i}>
              {line}
            </div>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  );
}