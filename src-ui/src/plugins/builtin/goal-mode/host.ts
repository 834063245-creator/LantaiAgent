// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal-mode · 宿主依赖面 · 开发/测试域。
//
// 本包**不自持内核实现**：状态容器（`agent/goal-manager.ts`）与宿主类方法
// （`Agent.runGoal/resumeGoal`）留内核，循环算法归本包。内核依赖逐符号桥：
// 登记表 + errText + defineTool + 事件枚举 + 类型面（契约 / 宿主状态 / 会话 / 工具）。

export type { AgentEvent, AgentUINotifier } from '../../../agent/agent-types';
export { EventKind } from '../../../agent/agent-types';
export type { ExecStateInstance } from '../../../agent/execution-state';
export type { GoalLoopHost, GoalModeImplementation, GoalRunResult } from '../../../agent/goal-contract';
export { registerGoalImplementation } from '../../../agent/goal-impl';
export type { GoalManager, GoalRecord } from '../../../agent/goal-manager';
export { errText } from '../../../agent/loop-helpers';
export type { SessionResetReason } from '../../../agent/session-log';
export type { Tool, ToolRegistry } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
export type { Message } from '../../../provider/types';
