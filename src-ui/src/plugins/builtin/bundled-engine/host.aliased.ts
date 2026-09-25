// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[bundled-engine/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
// 批 10 部件三：锚点形态 `<标识符>.mods.faceDeps` 拆两步写（构建期提取器按它认键）。
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');
export const isBundledEngineEnabled = impl.isBundledEngineEnabled;
export const probeBundledEngine = impl.probeBundledEngine;
export const ASSEMBLY_READY_WAIT_MS = impl.ASSEMBLY_READY_WAIT_MS;
export const registerMcpServerTools = impl.registerMcpServerTools;
export const waitWithin = impl.waitWithin;
export const createTauriProcIO = impl.createTauriProcIO;
export const useShellStore = impl.useShellStore;
export const useBundledEngineStore = impl.useBundledEngineStore;
