// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent-loop-service · 宿主依赖面（产物域）——逐符号取宿主桥 faceDeps 的真实例。
//
// 形态纪律（批 4c-3 实测病灶）：必须写成两步（`const host = requireHost();` +
// `const impl = host.mods.faceDeps;`）——构建期提取器的锚点是 `<标识符>.mods.faceDeps`，
// 单行链式写法会被判成「零需求」，保险丝 a 静默失效。
// jsx / jsxs / Fragment：本包无 JSX（注册表 + 循环实现皆 .ts），故不导出注入面。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[agent-loop-service/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');
export const ContributionChannel = impl.ContributionChannel;
export const Service = impl.Service;
export const setActiveAgentLoop = impl.setActiveAgentLoop;
export const kernelReadFile = impl.kernelReadFile;
export const typedRpcWithTimeout = impl.typedRpcWithTimeout;
export const EventKind = impl.EventKind;
export const log = impl.log;
export const finishReasonMessage = impl.finishReasonMessage;
export const parseFilePathArg = impl.parseFilePathArg;
export const StreamingToolExecutor = impl.StreamingToolExecutor;
export const resolveGuardToolName = impl.resolveGuardToolName;
export type AgentEvent = import('./host').AgentEvent;
export type AgentLoop = import('./host').AgentLoop;
export type AgentLoopHost = import('./host').AgentLoopHost;
