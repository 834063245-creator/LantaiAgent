// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal-mode · 宿主依赖面 · 构建产物域（与 host.ts 同形状镜像；类型面以
// typeof import('./host') 对拍）。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[goal-mode/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const EventKind = impl.EventKind;
export const registerGoalImplementation = impl.registerGoalImplementation;
export const errText = impl.errText;
export const defineTool = impl.defineTool;

export type AgentEvent = import('./host').AgentEvent;
export type AgentUINotifier = import('./host').AgentUINotifier;
export type ExecStateInstance = import('./host').ExecStateInstance;
export type GoalLoopHost = import('./host').GoalLoopHost;
export type GoalManager = import('./host').GoalManager;
export type GoalModeImplementation = import('./host').GoalModeImplementation;
export type GoalRecord = import('./host').GoalRecord;
export type GoalRunResult = import('./host').GoalRunResult;
export type Message = import('./host').Message;
export type SessionResetReason = import('./host').SessionResetReason;
export type Tool = import('./host').Tool;
export type ToolRegistry = import('./host').ToolRegistry;
