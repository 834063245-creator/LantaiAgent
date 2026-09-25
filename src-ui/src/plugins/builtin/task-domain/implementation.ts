// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// task-domain 实现面（批 9h-5，2026-09-26）——登记进内核 `agent/task-impl.ts` 的
// 唯一实现对象（形状 = 契约 `agent/task-contract.ts` 的 `TaskImplementation`）。
//
// 三个类本体与两族工具工厂都在本包内（`task.ts` / `task-board.ts` / `board-status.ts`）；
// 本文件只做「按契约面组装工厂」，不含任何逻辑——内核与其它产物经内核门面取用，
// 实例仍由调用方持有（板 = `runtime.ts` 每会话一块，管理器 = `workspace.ts` 每卷一个）。

import type { TaskImplementation } from '../../../agent/task-contract';
import { createBoardStatusTool } from './board-status';
import { createTaskTools, TaskManager } from './task';
import { TaskBoard, TaskBoardProxy } from './task-board';

export const taskImplementation: TaskImplementation = {
  createTaskManager: () => new TaskManager(),
  createTaskBoard: (projectPath, sessionId) => new TaskBoard(projectPath, sessionId),
  createTaskBoardProxy: (target) => new TaskBoardProxy(target),
  createTaskTools,
  createBoardStatusTool,
};
