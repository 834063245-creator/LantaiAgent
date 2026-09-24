// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// multiagent-comm · 宿主依赖面 · 构建产物域（与 host.ts 同形状镜像）。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[multiagent-comm/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const AgentNotFoundError = impl.AgentNotFoundError;
export const defineTool = impl.defineTool;
export const errText = impl.errText;
export const InboxFullError = impl.InboxFullError;
export const kernelCreateDirectory = impl.kernelCreateDirectory;
export const kernelDeleteFile = impl.kernelDeleteFile;
export const kernelListDirectory = impl.kernelListDirectory;
export const kernelReadFile = impl.kernelReadFile;
export const kernelWriteFile = impl.kernelWriteFile;
export const log = impl.log;
export const MessageNotFoundError = impl.MessageNotFoundError;
export const registerMultiagentComm = impl.registerMultiagentComm;
export const TopologyDeniedError = impl.TopologyDeniedError;

export type AgentAddress = import('./host').AgentAddress;
export type AgentMessage = import('./host').AgentMessage;
export type BackpressureStrategy = import('./host').BackpressureStrategy;
export type MessageBus = import('./host').MessageBus;
export type MessageFilter = import('./host').MessageFilter;
export type MessageStore = import('./host').MessageStore;
export type MessageTransport = import('./host').MessageTransport;
export type MultiagentCommImplementation = import('./host').MultiagentCommImplementation;
export type Tool = import('./host').Tool;
export type TopologyPolicy = import('./host').TopologyPolicy;
