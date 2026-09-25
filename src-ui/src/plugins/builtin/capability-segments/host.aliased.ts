// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// capability-segments · 宿主依赖面（产物域）——逐符号取宿主桥 faceDeps 的真实例。
//
// 形态纪律（批 4c-3 实测病灶）：必须写成两步（`const host = requireHost();` +
// `const impl = host.mods.faceDeps;`）——构建期提取器的锚点是 `<标识符>.mods.faceDeps`，
// 单行链式写法会被判成「零需求」，保险丝 a 静默失效。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[capability-segments/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');
export const createCodeExecutionTool = impl.createCodeExecutionTool;
export const requireMultiagentComm = impl.requireMultiagentComm;
export const activePlanImplementation = impl.activePlanImplementation;
export const registerCompactionTools = impl.registerCompactionTools;
export const activeStateHooksImplementation = impl.activeStateHooksImplementation;
export const activeDiscoveryTools = impl.activeDiscoveryTools;
export const activeMergeTools = impl.activeMergeTools;
export const activeSubAgentTools = impl.activeSubAgentTools;
export const createTaskTools = impl.createTaskTools;
export const TaskManager = impl.TaskManager;
export const createBoardStatusTool = impl.createBoardStatusTool;
export const convergeRegistry = impl.convergeRegistry;
export type Agent = import('./host').Agent;
export type AgentCapability = import('./host').AgentCapability;
export type BlueprintScope = import('./host').BlueprintScope;
export type CodeBindingSpec = import('./host').CodeBindingSpec;
