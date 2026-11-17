// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-chrome — 创作坞剩下的两件**坞级态**（2026-11-17 P6 拆出；语义零新增）。
//
// 归组判据（施工单）：这组状态**随同一个事件变化**——都随「坞这件家具自己的界面态」，
// 与任何会话数据无关：
//   · 坞内提示（notice）：2026-11-12 起挂**坞上方瞬时浮层**（toast 通道的 composer 落位，
//     贴 `--composer-band` 坞顶线）——不占布局、自动消散、位置跟着坞走（坞浮起来也正确）。
//     旧形态 = 坞内一行 `.pp-local-notice` + 「知道了」按钮：**占布局**（坞高被撑高 ⇒
//     整个创作坞跳变一次、关掉再跳一次）+ 必须人点才走（用户原话：「感觉不舒服」）。
//     语义分层照旧：成功不播报（界面变化即反馈，见 toast-store 克制纪律），
//     只有被拦/失败/需要知情的警示才弹。
//   · 附图预览的开关（imagePreview）：大图浮层是**全局模态**（portal 到 body），
//     Escape 走 useDialogEscape（document capture 监听，与焦点无关）——旧实现把 onKeyDown
//     挂在那个不可聚焦的 div 上，焦点在缩略图按钮上时永远收不到（用户报「预览收不回」
//     的键盘那一半）。

import { useCallback, useState } from 'react';
import type { ChatImageRef } from '../host';
import { useDialogEscape, useToastStore } from '../host';

export function useComposerChrome() {
  const notice = useCallback((text: string, level: 'info' | 'warn' | 'error' = 'warn') => {
    useToastStore.getState().showToast(text, level, undefined, 'composer');
  }, []);

  /* ── 附图预览（B2）：大图浮层——点击缩略图开；关闭三路 = 点遮罩 / Esc。
   *    Esc 走 useDialogEscape（document capture 监听，**与焦点无关**）。 ── */
  const [imagePreview, setImagePreview] = useState<ChatImageRef | null>(null);
  useDialogEscape(() => setImagePreview(null), { enabled: imagePreview !== null });

  /** 历史眉批的**判据**（一次性提示：有历史且从未提示过时，首次聚焦浮现 6s；
   *  localStorage 旗标，毒化容忍）。自散计时归 use-composer-layers（它持有 histHint）。 */
  const armHistHintIfDue = useCallback((inputHistoryLength: number, histHintKey: string): boolean => {
    let seen = true;
    try {
      seen = localStorage.getItem(histHintKey) === '1';
    } catch {
      seen = true; // 存储不可用 = 不提示（宁缺勿噪）
    }
    if (seen) return false;
    if (inputHistoryLength === 0) return false;
    try {
      localStorage.setItem(histHintKey, '1');
    } catch {
      // 写不进也照提示一次——本次会话内不再重复（histHint 态兜底）
    }
    return true;
  }, []);

  return { notice, imagePreview, setImagePreview, armHistHintIfDue };
}
