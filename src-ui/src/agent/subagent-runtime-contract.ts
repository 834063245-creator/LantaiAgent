// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子代理运行时**契约面**（批 7c-1，2026-09-24）：运行时实现（池 / 生命周期 / 派生 / merge 与
// discovery 工具族）归产物包 `plugins/builtin/subagent-in-process/`，契约住内核——
// 内核（blueprint 的 capability / workspace 与 runtime 的构造点 / subagent-spawn 的调用面）
// 引用本件即可，不反向依赖产物包。

import type { DiscoveryBoard } from './discovery-board';
import type { BoardEntry, TaskBoard } from './task-board';
import type { Tool, ToolExecutor } from './tool';

/** merge 工具族实现面（含编译门禁）。 */
export interface MergeToolsImplementation {
  createMergeTool(
    board: TaskBoard,
    getAgentId: () => string,
    exec?: ToolExecutor,
    options?: { projectPath: string },
  ): Tool;
  runCompileTest(
    entry: BoardEntry,
    options: { projectPath: string; compileCommand?: string; compileTimeoutMs?: number },
    exec?: ToolExecutor,
  ): Promise<MergeGateResult>;
}

/** 编译门禁结果（结构对齐包内 `GateResult`——内核只做结构约束，不 import 产物类型）。 */
export interface MergeGateResult {
  passed: boolean;
  quiet: boolean;
  report: string;
}

/** discovery 工具族实现面（agent_discover / agent_lookup）。 */
export interface DiscoveryToolsImplementation {
  createDiscoveryTools(board: DiscoveryBoard, getAgentId: () => string): Tool[];
}
