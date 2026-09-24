// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 进程内子代理 provider · 宿主依赖面 · 开发/测试域。
//
// 批 7c-1 起本包**同时承载运行时工具族**（merge / discovery）：原先桥的
// `spawnSubAgentImpl` 将在 7c-2 随运行时进包（届时本面翻面成「桥它仍住内核的依赖面」）。
// 当前它仍住内核 ⇒ 继续桥；新增工具族的内核依赖逐符号桥。

export type { DiscoveryBoard } from '../../../agent/discovery-board';
export { enqueueIsolationOp } from '../../../agent/isolation-queue';
export { errText } from '../../../agent/loop-helpers';
export { execStreamedShell } from '../../../agent/runtime/queued-shell';
export { parseIsolationDiff } from '../../../agent/spill';
export type {
  DiscoveryToolsImplementation,
  MergeToolsImplementation,
} from '../../../agent/subagent-runtime-contract';
export { registerSubagentRuntime } from '../../../agent/subagent-runtime-impl';
export { spawnSubAgentImpl } from '../../../agent/subagent-spawn';
export type { BoardEntry, TaskBoard } from '../../../agent/task-board';
export type { Tool, ToolExecutor } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
