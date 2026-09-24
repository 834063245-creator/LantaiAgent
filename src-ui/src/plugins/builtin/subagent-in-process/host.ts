// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 进程内子代理 provider · 宿主依赖面 · 开发/测试域。
//
// 批 7c-2 起本包**自持子代理运行时**（池 / 生命周期 / 派生 / merge / discovery），
// 本面翻面成**桥它仍住内核的依赖面**：宿主 Agent 类（子 Agent 实例化用）· 执行态 ·
// hook 注册表 · plan 门禁 · 输出 schema 指令 · 状态 hook 实现 · 子代理活动账 ·
// 文件归属 · 隔离队列 · 流式 shell 腰 · 契约面类型。

export { Agent } from '../../../agent/agent';
export type { AgentStore } from '../../../agent/agent-store';
export type { AgentUINotifier, EventSink } from '../../../agent/agent-types';
export { EventKind } from '../../../agent/agent-types';
export type { AgentContext } from '../../../agent/context';
export type { DiscoveryBoard } from '../../../agent/discovery-board';
export { createExecState } from '../../../agent/execution-state';
export { extractFilePath, FileOwnership, WRITE_TOOLS } from '../../../agent/file-ownership';
export { HookRegistry } from '../../../agent/hooks';
export { enqueueIsolationOp } from '../../../agent/isolation-queue';
export type { Disposer } from '../../../agent/lifecycle';
export { once } from '../../../agent/lifecycle';
export { log } from '../../../agent/logger';
export { errText } from '../../../agent/loop-helpers';
export type { MessageBus } from '../../../agent/message-contract';
export { planRegistry } from '../../../agent/plan/plan-registry';
export type { PlanStateManager } from '../../../agent/plan/plan-state';
export { execStreamedShell } from '../../../agent/runtime/queued-shell';
export { buildOutputSchemaInstruction } from '../../../agent/schema-validate';
export { parseIsolationDiff } from '../../../agent/spill';
export { activeStateHooksImplementation } from '../../../agent/state-hooks-impl';
export { removeSubAgentActivity, wrapSubAgentSink } from '../../../agent/subagent-activity';
export type {
  AgentLifecycleManager,
  DiscoveryToolsImplementation,
  MergeGateResult,
  MergeToolsImplementation,
  SpawnedAgent,
  SpawnSubAgentFn,
  SubAgentHandle,
  SubAgentPool,
  SubAgentRunFn,
  SubAgentSpawnHost,
  SubagentRuntimeImplementation,
} from '../../../agent/subagent-runtime-contract';
export { SubAgentStatus } from '../../../agent/subagent-runtime-contract';
export { registerSubagentRuntime } from '../../../agent/subagent-runtime-impl';
export type { BoardEntry, TaskBoard } from '../../../agent/task-board';
export type { Tool, ToolExecutor } from '../../../agent/tool';
export { ToolRegistry } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
export { convergeRegistry } from '../../../agent/tools/domains';
export type { Provider } from '../../../provider/types';
