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
  /* 两处落位（2026-11-12 用户「坞内提示导致整坞跳变、还要点知道了」）：
   *   top      = 全局顶中（系统级结果/错误，原有面）
   *   composer = **创作坞上方**——坞内动作的反馈挂在动作发生处，但走**浮层**：
   *              不占布局行（旧 .pp-local-notice 会把整坞撑高、跳变）、自动消散
   *              （旧形态要用户点「知道了」才走）。
   * 两根按 anchor 分桶；同一屏最多各 3 条（store 侧已按锚分桶截断）。 */
  const buckets = [
    // `?? 'top'`：产物可热更、内核 store 在 exe 里——旧 exe 的 toast 条目没有 anchor 字段，
    // 不兜底就两桶皆空（**全部 toast 静默消失**）。热更边界上必须容缺读。
    {
      anchor: 'top' as const,
      cls: 'pp-toast-host',
      items: toasts.filter((t) => (t.anchor ?? 'top') === 'top'),
    },
    {
      anchor: 'composer' as const,
      cls: 'pp-toast-host pp-toast-host-composer',
      items: toasts.filter((t) => t.anchor === 'composer'),
    },
  ].filter((b) => b.items.length > 0);
  return createPortal(
    <>
      {buckets.map((bucket) => (
        <div key={bucket.anchor} className={bucket.cls} role="status" aria-live="polite">
          {bucket.items.map((t) => (
            <div
              key={t.id}
              className={`pp-toast pp-toast-${t.level}`}
              style={{ '--pp-toast-hold': `${t.holdMs}ms` } as CSSProperties}
            >
              {t.text}
            </div>
          ))}
        </div>
      ))}
    </>,
    document.body,
  );
}
