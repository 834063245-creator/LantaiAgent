// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// turn-done-store — 聊天轮次完成信号（P1 事件归零：替代 bus 'chat:turn-done' 事件；
// 见 docs/plans/eventbus-zero-and-ui-split-plan.md）。
// 发射点：chat-core（_runAgentTurn / sendMessage 的 finally）。
// 消费者：shell/rows/persistence（订阅 tick — 防抖全量 scheduleAutoSave +
// 后台卷 saveSessionById）。
// workspace-session-ownership-rework（2026-08-27）：NDJSON 增量持久化已拆
// （appendLastMessage/session_append 退役），唯一存储路径 = 工作区会话根全量快照。
// L2（session-ledger）：tick 携带 doneSid（本轮跑完的会话 id）——持久化
// 「谁跑完存谁」，后台卷跑完立即落盘自己的卷，不再只存当前翻开的卷。

import { create } from 'zustand';

interface TurnDoneState {
  turnDoneTick: number;
  /** 最近一次完成轮次的会话 id（F3：后台卷落盘窗口期的闭合依据）。 */
  lastDoneSid: number | null;
}

export const useTurnDoneStore = create<TurnDoneState>(() => ({
  turnDoneTick: 0,
  lastDoneSid: null,
}));

/** 通知聊天轮次已结束（成功/失败/中止皆算）。
 *  sid = 本轮运行的会话 id（「跑完的那卷」——流式目标卷，非当前翻开卷）。 */
export function bumpTurnDone(sid?: number): void {
  useTurnDoneStore.setState((s) => ({ turnDoneTick: s.turnDoneTick + 1, lastDoneSid: sid ?? null }));
}
