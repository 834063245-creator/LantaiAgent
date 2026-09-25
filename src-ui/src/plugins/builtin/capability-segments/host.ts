// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// capability-segments 产物 · 宿主依赖面 · 开发/测试/编译域（批 9h-1，2026-09-26）。
//
// 内容表（`segments.ts`）只做**组合**：把内核登记表里的实现（plan / 通信 / discovery /
// merge / 子 Agent / compaction / state-hooks / task 工具族）与内核工具工厂接到
// `ctx.capabilities` 的贡献行上。全部取用面都是**无状态读面/工厂**：
//   - 登记表读面（批 6/7 落地的「内核登记表 + 产物登记实现」）：`activePlanImplementation` /
//     `activeDiscoveryTools` / `activeMergeTools` / `activeSubAgentTools` /
//     `activeStateHooksImplementation` / `requireMultiagentComm`（缺实现 = 缺那族工具）；
//   - 内核工具工厂与域折叠表：`createCodeExecutionTool` / `createTaskTools` / `TaskManager` /
//     `createBoardStatusTool` / `registerCompactionTools` / `convergeRegistry`。
// 状态本体都在内核（Agent / runtime / 登记表 / TaskManager 实例）⇒ 一律经宿主桥取真实例。
//
// 形状（`AgentCapability` / `BlueprintScope`）留内核 `agent/blueprint.ts`——组合机制真源
// （`AgentBlueprint` 类 + 装配视图），本包只提供内容。

export type { Agent } from '../../../agent/agent';
export type { AgentCapability, BlueprintScope } from '../../../agent/blueprint';
export { createCodeExecutionTool } from '../../../agent/code-run/code-execution-tool';
export type { CodeBindingSpec } from '../../../agent/code-run/host';
export { requireMultiagentComm } from '../../../agent/multiagent-impl';
export { activePlanImplementation } from '../../../agent/plan/plan-impl';
export { registerCompactionTools } from '../../../agent/runtime/agent-builder';
export { activeStateHooksImplementation } from '../../../agent/state-hooks-impl';
export { activeDiscoveryTools, activeMergeTools } from '../../../agent/subagent-runtime-impl';
export { activeSubAgentTools } from '../../../agent/subagent-tools-impl';
export { createTaskTools, TaskManager } from '../../../agent/task';
export { createBoardStatusTool } from '../../../agent/tools/board-status';
export { convergeRegistry } from '../../../agent/tools/domains';
