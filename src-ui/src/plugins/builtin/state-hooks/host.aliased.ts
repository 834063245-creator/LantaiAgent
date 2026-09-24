// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state-hooks · 宿主依赖面 · 构建产物域（与 host.ts 同形状镜像；类型面以
// typeof import('./host') 对拍）。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[state-hooks/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const buildPreReadBlock = impl.buildPreReadBlock;
export const cacheBuildResult = impl.cacheBuildResult;
export const formatDiagnostics = impl.formatDiagnostics;
export const hasImageRefs = impl.hasImageRefs;
export const invalidateBlameEntry = impl.invalidateBlameEntry;
export const refreshGitBlame = impl.refreshGitBlame;
export const registerStateHooksImplementation = impl.registerStateHooksImplementation;

export type DiagnosticsSource = import('./host').DiagnosticsSource;
export type Hook = import('./host').Hook;
export type PreflightHook = import('./host').PreflightHook;
export type StateHooksImplementation = import('./host').StateHooksImplementation;
export type TaskBoard = import('./host').TaskBoard;
