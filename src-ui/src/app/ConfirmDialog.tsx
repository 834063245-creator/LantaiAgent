// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 面板内确认弹窗 — 替换原生 alert/confirm，与纸面面板视觉统一。
// tone="danger" 用于删除/放弃未保存更改等不可逆操作。
// 键盘：Esc = 取消 / Enter = 确认（2026-08 UI 大清扫——此前只有鼠标路径，
// 且 Esc 会穿透到 useGlobalKeys 的 esc-layer 误关整个 settings 面板）。
// Enter 只在弹层自身持有焦点时生效（avoid 文本输入中的 Enter 提交表单）。
//
// 2026-08-29 frontend-overlay-a11y-plan 档位 A-1：Escape/遮罩点关/背景 inert 收编到
// Overlay 原语（统一语义），本件只保留焦点环 + Enter 确认。

import type React from 'react';
import { useEffect, useId, useRef } from 'react';
import { mountDialogFocus } from './dialog-focus';
import { Overlay } from './overlay';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  // 焦点圈定 + 开启即聚焦取消键（danger 弹层的保守默认：误按 Enter 不至于触发
  // 危险操作）+ 关闭归还焦点给打开者（2026-08-29 走查：此前 Tab 可逃逸弹层）
  useEffect(() => {
    if (!open || !sheetRef.current) return;
    return mountDialogFocus(sheetRef.current, { initial: cancelRef.current });
  }, [open]);

  // Enter = 确认（弹层内焦点时）；stopPropagation 防 esc-layer 穿透（Esc 已归 Overlay）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const inSheet = sheetRef.current?.contains(document.activeElement);
      const inInput =
        document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      // 焦点在弹层按钮上（非输入框）才走 Enter 确认
      if (inSheet && !inInput) {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      }
    };
    document.addEventListener('keydown', onKey, true); // capture：先于 useGlobalKeys（window 冒泡）
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onConfirm]);

  return (
    <Overlay open={open} onClose={onCancel} className="cd-overlay" inertBackground>
      <div
        ref={sheetRef}
        className={`cd-sheet${tone === 'danger' ? ' cd-danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="cd-hd">
          <span id={titleId} className="cd-title">
            {title}
          </span>
          <button type="button" className="cd-close" onClick={onCancel} title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <div className="cd-body">{message}</div>
        <div className="cd-actions">
          <button ref={cancelRef} type="button" className="sp-btn sp-btn-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'cd-btn-danger' : 'sp-btn sp-btn-save'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
