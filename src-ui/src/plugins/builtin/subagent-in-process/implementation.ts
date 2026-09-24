// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子代理运行时实现对象（批 7c-1 / 7c-2）：池 · 生命周期 · 派生 + merge / discovery 两工具族
// 折成内核契约面 `SubagentRuntimeImplementation`，由 index.ts 在 apply 期登记进
// `agent/subagent-runtime-impl.ts`。

import { SubAgentPool } from './coordinator';
import { createDiscoveryTools } from './discovery-tools';
import type { SubagentRuntimeImplementation } from './host';
import { AgentLifecycleManager } from './lifecycle-manager';
import { runCompileTest } from './merge-gate';
import { createMergeTool } from './merge-tools';
import { spawnSubAgentImpl } from './subagent-spawn';

export const subagentRuntimeImplementation: SubagentRuntimeImplementation = {
  createPool: (maxConcurrent?: number, defaultTimeoutMs?: number) => new SubAgentPool(maxConcurrent, defaultTimeoutMs),
  createLifecycleManager: (pool, board, bus, exec, sink) => new AgentLifecycleManager(pool, board, bus, exec, sink),
  spawnSubAgent: spawnSubAgentImpl,
  mergeTools: { createMergeTool, runCompileTest },
  discoveryTools: { createDiscoveryTools },
};

// 兼容导出：7c-1 曾把两族实现对象单独导出（index.ts 现统一走本文件的运行时对象）。
export const mergeToolsImplementation = subagentRuntimeImplementation.mergeTools;
export const discoveryToolsImplementation = subagentRuntimeImplementation.discoveryTools;
