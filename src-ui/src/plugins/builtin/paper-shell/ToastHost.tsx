// plugins/builtin/paper-shell/ToastHost.tsx — 全局瞬时提示浮层（2026-08-31）。
//
// 贴黄拆迁后的 toast 通道宿主：顶中浮层，3.2s（error 6.4s）后淡出。
// 经 body portal 渲染——避开纸面 transform/filter 祖先的包含块。
// level 语义色走纸壳 token：info 墨纹 / warn 赭黄 / error 朱砂。
// 换行由 .pp-toast 的 white-space: pre-line 承载（多行命令输出不拆 DOM）。

import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
// ⚡ 2026-09-28（A4 销账第一笔）：本件是 toast 通道的**唯一渲染器**，而全部生产者
//   （chat-core / chat-session / chat-stream / workspace / session-branch …）都在内核侧
//   ——原先直引内核路径 `../../../state/toast-store` 会被产物构建内联成**第二份
//   zustand store**：生产者写内核那份、本件读产物这份 ⇒ 打包态 toast 一条都不显示
//   （开发/测试域单实例，所以单测全绿也看不出来）。改走宿主桥 = 内核同一实例。
import { useToastStore } from './host';
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
