// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plan-mode · 宿主依赖面 · 构建产物域（与 host.ts 同形状镜像；类型面以
// typeof import('./host') 对拍）。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[plan-mode/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const EventKind = impl.EventKind;
export const registerPlanImplementation = impl.registerPlanImplementation;
export const defineTool = impl.defineTool;
export const kernelReadFile = impl.kernelReadFile;

export type EventSink = import('./host').EventSink;
export type PlanApprovalResponse = import('./host').PlanApprovalResponse;
export type PlanModeImplementation = import('./host').PlanModeImplementation;
export type PlanOptionOutcome = import('./host').PlanOptionOutcome;
export type PlanReminderInjector = import('./host').PlanReminderInjector;
export type PlanReviewRequest = import('./host').PlanReviewRequest;
export type PlanState = import('./host').PlanState;
export type PlanStateManager = import('./host').PlanStateManager;
export type Tool = import('./host').Tool;
