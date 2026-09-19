// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// exit-guard-store — 退出守卫（2026-09-19 用户拍板）。
//
// 病灶：回首页有确认（PaperPanel 的关闭守卫 → ConfirmDialog），而**紧挨着它**的
// 窗口 ✕ 没有——关窗路径（shell/rows/persistence 的 watchWindowClose）只做
// 「退出落盘 → destroy」，正在跑的那一轮被直接掐死且用户零感知。手一抖点到 ✕，
// 应用就没了。
//
// 语义（用户拍板：只有会话正在跑时才拦）：空闲关窗 = 直接退（会话与画布本来
// 就会自动落盘，弹层只是多一次点击）；有卷在跑才升起确认——真正不可挽回的
// 只有「跑着的一轮被终止」这一件事。
//
// 单一权威：待确认请求只此一处；唯一消费面 = App 根的 ExitConfirmDialog。
// proceed 由关窗事件的持有者（persistence 行）注入——它握有该次事件的
// preventDefault/destroy 句柄；本 store 不碰窗口、不碰 RPC、不碰落盘。

import { create } from 'zustand';

export interface PendingExit {
  /** 正在运行的卷数（弹层文案用——升层那一刻的快照） */
  running: number;
  /** 确认后的收尾：退出落盘（flush）→ destroy 窗口 */
  proceed: () => void;
}

interface ExitGuardState {
  /** 待确认的退出请求（null = 无弹层） */
  pending: PendingExit | null;
  /** 拦下一次关窗并升起确认弹层（关窗路径调用；调用前窗口已被 preventDefault） */
  requestExit: (running: number, proceed: () => void) => void;
  /** 确认退出：先清态再执行 proceed（proceed 里的 destroy 会带走整棵树） */
  confirmExit: () => void;
  /** 取消退出：只清态——窗口留着，本次关窗作废（下次点 ✕ 重新走一遍） */
  cancelExit: () => void;
}

export const useExitGuardStore = create<ExitGuardState>((set, get) => ({
  pending: null,
  requestExit: (running, proceed) => set({ pending: { running, proceed } }),
  confirmExit: () => {
    const p = get().pending;
    if (!p) return;
    set({ pending: null });
    p.proceed();
  },
  cancelExit: () => set({ pending: null }),
}));
