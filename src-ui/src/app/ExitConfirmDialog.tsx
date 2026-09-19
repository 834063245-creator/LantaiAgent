// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// ExitConfirmDialog — 退出确认弹层（2026-09-19 用户拍板）。
//
// 关窗时若有会话正在运行，persistence 行拦下本次关闭并升起本弹层（判据与语义
// 见 state/exit-guard-store 头注）。确认 → 退出落盘 → destroy；取消 → 窗口留着。
//
// 复用面板确认弹层（ConfirmDialog）：同一套牒卡语言 + 键盘语义（Esc 取消 /
// Enter 确认 / 焦点圈定 / 遮罩点关）。与「回首页」的确认是同一族动作，文案与
// 键位刻意对齐（那边是 leaveToHome，这边是 quit）。
//
// 位置：App 根直接子元素 = 全局模态（定位与层级见 exit-confirm.css——面板内模态
// 的 .cd-overlay 只争面板内部，盖不住纸壳）。

import { useExitGuardStore } from '../state/exit-guard-store';
import { ConfirmDialog } from './panels/settings/ConfirmDialog';
import './exit-confirm.css';

export function ExitConfirmDialog() {
  const pending = useExitGuardStore((s) => s.pending);
  const confirmExit = useExitGuardStore((s) => s.confirmExit);
  const cancelExit = useExitGuardStore((s) => s.cancelExit);
  return (
    <ConfirmDialog
      open={pending !== null}
      title="退出兰台？"
      message={
        pending ? `有 ${pending.running} 卷正在运行——退出会中断正在跑的轮次（会话与画布会自动保存）。确定退出？` : ''
      }
      confirmLabel="退出兰台"
      cancelLabel="留在兰台"
      tone="danger"
      onConfirm={confirmExit}
      onCancel={cancelExit}
    />
  );
}
