// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal-mode · 宿主依赖面 · 构建产物域（与 host.ts 同形状镜像；类型面以
// typeof import('./host') 对拍——漏键在装载期被 face.json 键集闸拦下）。

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

export const blockGoal = impl.blockGoal;
export const completeGoal = impl.completeGoal;
export const createGoal = impl.createGoal;
export const DEFAULT_BLOCKED_MIN_ROUNDS = impl.DEFAULT_BLOCKED_MIN_ROUNDS;
export const defineTool = impl.defineTool;
export const editGoal = impl.editGoal;
export const GoalError = impl.GoalError;
export const goalHostOf = impl.goalHostOf;
export const isTopLevelHost = impl.isTopLevelHost;
export const pauseGoal = impl.pauseGoal;
export const readGoal = impl.readGoal;
export const resumeGoal = impl.resumeGoal;

export type GoalHost = import('./host').GoalHost;
export type GoalView = import('./host').GoalView;
export type Tool = import('./host').Tool;
