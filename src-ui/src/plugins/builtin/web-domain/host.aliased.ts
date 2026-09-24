// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// web-domain · 宿主依赖面 · 构建产物域（与 host.ts 同形状镜像；类型面以
// typeof import('./host') 对拍）。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[web-domain/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
const impl = requireHost().mods.faceDeps as unknown as typeof import('./host');

export const toInputJsonSchema = impl.toInputJsonSchema;

export type Tool = import('./host').Tool;
export type ToolExecutor = import('./host').ToolExecutor;
