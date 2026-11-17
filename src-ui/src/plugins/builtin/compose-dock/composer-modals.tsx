// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composer-modals — 创作坞的**两处全局模态**（2026-11-17 上帝文件治理 P6 拆出；语义零新增）。
//
// 为什么是 portal 而不是就地渲染：坞槽 `.pp-composer-slot` 带 `transform: translateX(-50%)`
// （版心居中）——transform 让该元素成为 `position: fixed` 后代的**包含块**，于是 `inset: 0`
// 量的是坞的盒子而不是视口；坞槽同时是 `z-index: 6` 的层叠上下文（坞内 `z-index: 95`
// 只在坞里排序，出不去）。就地渲染的「全局模态」于是被关进坞里 —— 附图预览那一批的
// 用户报障（「点开图整个创作坞被图糊住，撤回不了」）就是这条几何的直接后果。
// 归位成它本来的身份（CONVENTIONS 浮层政策「全局模态用 portal=true」）：portal 到 body。
//
// ⚠ 为什么是裸 `createPortal` 而不是 app/overlay 的 Overlay 原语：**产物域装不下它**
// ——构建用 `--jsx-import-source=./host`，插件目录之外的 JSX 文件会被 esbuild 按它
// 自己的相对路径解析 `./host/jsx-runtime`（该处没有此文件 ⇒ 构建直接红）；
// 而把 Overlay 加进 host.ts ⇒ 撞 host-modules 的 FaceBridgeSeal ⇒ 宿主面指纹变 ⇒
// 产物不能热更、须重建 exe。故只取 react-dom（esbuild 内联，不涉 JSX）。
//
// Escape 不在这里：它是 document 级监听，跟宿主（坞）同一份 `useDialogEscape`，
// 留在调用方（同一次订阅，两处模态共用同一把尺子）。遮罩点关语义就地写在本件。

import { createPortal } from 'react-dom';
import type { ChatImageRef } from './host';
import { MODE_DESCRIPTIONS, previewUrlFor } from './host';

/** 附图大图预览（B2）——点击缩略图开；关闭三路 = 点遮罩 / Esc（Esc 在调用方）。 */
export function ImagePreviewModal({ preview, onClose }: { preview: ChatImageRef | null; onClose: () => void }) {
  if (preview === null) return null;
  return createPortal(
    <div
      className="pp-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="附图预览"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <img src={previewUrlFor(preview.id)} alt={preview.name ?? '附图'} />
      <div className="pp-image-lightbox-meta">
        {preview.name ?? preview.id.slice(0, 12)} · {preview.width}×{preview.height}
      </div>
    </div>,
    document.body,
  );
}

/** rework P2-3 / P0-1：全放（yolo）二次确认 = 独立居中模态（不内嵌创作坞，避免高度/关窗竞态）。 */
export function YoloConfirmModal({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: 模态遮罩点击空白 = 取消（明确对话框语义）
    <div
      className="pp-mode-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="pp-mode-dialog" role="dialog" aria-modal="true" aria-label="确认全放模式">
        <div className="pp-mode-dialog-title">切换到全放模式</div>
        <div className="pp-mode-dialog-body">{MODE_DESCRIPTIONS.yolo}</div>
        <div className="pp-mode-dialog-actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="primary" onClick={onConfirm}>
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
