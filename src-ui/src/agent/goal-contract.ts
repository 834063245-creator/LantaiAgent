// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Goal 模式**契约面**（批 6b，2026-09-24 从 goal-loop.ts 上收）：循环实现在产物包
// `plugins/builtin/goal-mode/`，契约住内核——Agent 类（宿主本体）与 chat-agent-handle
// 引用本件即可，**不必反向依赖产物包**（宿主→插件禁反）。
//
// 三条边界：
//   - GoalLoopHost = 循环对宿主 Agent 的最小状态面（成员与 Agent 类声明逐字对齐）；
//   - GoalRunResult = 循环终态（chat-agent-handle 曾自持一份同形声明，批 6b 起单一真源在此）；
//   - GoalModeImplementation = 产物包经登记表（agent/goal-impl.ts）提供的实现面。

import type { Message } from '../provider/types';
import type { AgentEvent, AgentUINotifier } from './agent-types';
import type { ExecStateInstance } from './execution-state';
import type { GoalManager } from './goal-manager';
import type { SessionResetReason } from './session-log';
import type { ToolRegistry } from './tool';

/** Goal 循环对宿主 Agent 的最小状态面（成员与 Agent 类声明逐字对齐）。 */
export interface GoalLoopHost {
  readonly goalManager: GoalManager | null;
  readonly tools: ToolRegistry;
  /** UI 通知端口（workspace 注入；headless 时为空操作）。 */
  readonly _ui: AgentUINotifier;
  readonly _execState: ExecStateInstance;
  _sink: (ev: AgentEvent) => void;
  getSession(): Message[];
  _appendMessage(kind: 'user/message' | 'assistant/text' | 'tool/result', message: Message): void;
  _replaceSession(messages: Message[], reason: SessionResetReason): void;
  _retractSessionRange(fromIndex: number, toIndex: number): void;
  runLoop(signal: AbortSignal): Promise<void>;
}

export type GoalRunResult = {
  status: 'completed' | 'failed' | 'blocked' | 'aborted' | 'paused';
  summary: string;
};

/** goal 模式实现面——产物包 `hologram/goal-mode` 在 apply 期经
 *  `registerGoalImplementation` 登记；内核 `Agent.runGoal/resumeGoal` 查表取用。 */
export interface GoalModeImplementation {
  runGoal(host: GoalLoopHost, signal: AbortSignal, goal: string): Promise<GoalRunResult>;
  resumeGoal(host: GoalLoopHost, signal: AbortSignal, id?: string): Promise<GoalRunResult>;
}
