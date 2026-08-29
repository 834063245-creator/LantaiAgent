// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 后台失败警报（R5 D5，2026-08-29 拍板 C）——静默重试类后台失败
// （画布状态落盘 / 摊开集恢复）的唯一可见出口：
//   - StatusLine 常驻警告档（失败态期间持续显示，成功解除才消失）；
//   - 每次进入失败态弹一次提示条（「知道了」只收提示条，警告档仍在）。
// app 级单例（同 update-store 模式）；失败源用 id 区分，同 id 失败态
// 延续不重复弹——成功清除后再失败才重新弹。

import { create } from 'zustand';

export interface BgAlert {
  /** 失败源标识（如 'canvas-save' / 'restore-open'） */
  id: string;
  msg: string;
}

interface BgAlertState {
  bgAlert: BgAlert | null;
  /** 进入失败态（同 id 已在警则保持现状） */
  pushBgAlert: (id: string, msg: string) => void;
  /** 失败解除（成功恢复）后清除 */
  clearBgAlert: (id: string) => void;
}

export const useBgAlertStore = create<BgAlertState>((set) => ({
  bgAlert: null,
  pushBgAlert: (id, msg) => set((st) => (st.bgAlert?.id === id ? st : { bgAlert: { id, msg } })),
  clearBgAlert: (id) => set((st) => (st.bgAlert?.id === id ? { bgAlert: null } : st)),
}));
