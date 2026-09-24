// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 进程内子代理 provider · 宿主依赖面 · 构建产物域。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}

function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) {
    throw new Error('[subagent-in-process/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  }
  return host;
}

const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const Agent = impl.Agent;
export const EventKind = impl.EventKind;
export const FileOwnership = impl.FileOwnership;
export const HookRegistry = impl.HookRegistry;
export const SubAgentStatus = impl.SubAgentStatus;
export const ToolRegistry = impl.ToolRegistry;
export const WRITE_TOOLS = impl.WRITE_TOOLS;
export const activeStateHooksImplementation = impl.activeStateHooksImplementation;
export const buildOutputSchemaInstruction = impl.buildOutputSchemaInstruction;
export const convergeRegistry = impl.convergeRegistry;
export const createExecState = impl.createExecState;
export const defineTool = impl.defineTool;
export const enqueueIsolationOp = impl.enqueueIsolationOp;
export const errText = impl.errText;
export const execStreamedShell = impl.execStreamedShell;
export const extractFilePath = impl.extractFilePath;
export const log = impl.log;
export const once = impl.once;
export const parseIsolationDiff = impl.parseIsolationDiff;
export const planRegistry = impl.planRegistry;
export const registerSubagentRuntime = impl.registerSubagentRuntime;
export const removeSubAgentActivity = impl.removeSubAgentActivity;
export const wrapSubAgentSink = impl.wrapSubAgentSink;

export type BoardEntry = import('./host').BoardEntry;
export type DiscoveryBoard = import('./host').DiscoveryBoard;
export type DiscoveryToolsImplementation = import('./host').DiscoveryToolsImplementation;
export type MergeToolsImplementation = import('./host').MergeToolsImplementation;
export type SubAgentSpawnHost = import('./host').SubAgentSpawnHost;
export type TaskBoard = import('./host').TaskBoard;
export type Tool = import('./host').Tool;
export type ToolExecutor = import('./host').ToolExecutor;
