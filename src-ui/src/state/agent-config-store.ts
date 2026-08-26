// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent-config-store — Agent 配置变更信号（P1b：替代 bus 'agent:config-changed' 事件；
// 见 docs/plans/ui-react-island-retirement-plan.md）。
// 发射点：SettingsPanel / compose-store / ChatFooter（协作模式按钮）。
// 唯一消费者：shell/rows/persistence.ts 单一订阅 → Workspace.applyAgentConfig
// 热切换（不重建 Agent）。雷区地图 #25 的根治设计原样保留：信号与 saveSettings
// 解耦，权限模式不发信号。
//
// 方案甲（2026-08-27 创作坞体检）：model-switched / thinking-changed 携带
// sessionId——变更只作用于该会话（会话覆盖制），不再全量轰炸所有活句柄。
// settings-saved 仍不带 sessionId（全局默认变更 → 逐会话重解析）。

import { create } from 'zustand';

/** 触发 agent 配置热切换的原因。所有原因都由 Workspace.applyAgentConfig
 *  热切换处理，不重建 Agent。 */
export type AgentConfigChangeReason = 'settings-saved' | 'collaboration-mode' | 'model-switched' | 'thinking-changed';

export const useAgentConfigStore = create<{
  seq: number;
  reason: AgentConfigChangeReason | null;
  /** 方案甲：会话级变更的目标会话（model-switched / thinking-changed 携带；
   *  全局原因（settings-saved / collaboration-mode）为 null。 */
  sessionId: number | null;
}>(() => ({
  seq: 0,
  reason: null,
  sessionId: null,
}));

/** 发射配置变更信号（seq 递增保证同 reason 连发也能触发订阅者）。
 *  sessionId：会话级变更（创作坞切模型/思考）携带目标会话 id。 */
export function notifyAgentConfigChanged(reason: AgentConfigChangeReason, sessionId?: number): void {
  useAgentConfigStore.setState((s) => ({ seq: s.seq + 1, reason, sessionId: sessionId ?? null }));
}
