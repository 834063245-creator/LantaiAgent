// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state-hooks **契约面**（批 6c，2026-09-24）：出厂 hook 实现在产物包
// `plugins/builtin/state-hooks/`，接口住内核——内核 blueprint 的两条 capability
// （state-hooks / board-tracking-hook）与本接口对接，不反向依赖产物包。

import type { Hook, PreflightHook } from './hooks';
import type { DiagnosticsSource } from './state-inject';
import type { TaskBoard } from './task-board';

/** 出厂 hook 实现面——产物包在 apply 期经 `registerStateHooksImplementation` 登记。 */
export interface StateHooksImplementation {
  createStateReadHook(projectPath: string, diagSource: DiagnosticsSource): Hook;
  createStatePreflightHook(diagSource: DiagnosticsSource): PreflightHook;
  createBuildResultHook(): Hook;
  createBoardTrackingHook(agentId: string, board: TaskBoard): Hook;
}
