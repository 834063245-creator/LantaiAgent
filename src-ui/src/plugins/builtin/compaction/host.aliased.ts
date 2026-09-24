// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// compaction · 宿主依赖面 · 构建产物域（与 host.ts 同形状镜像；类型面以
// typeof import('./host') 对拍）。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[compaction/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const buildCompactedSummaryMessage = impl.buildCompactedSummaryMessage;
export const ChunkType = impl.ChunkType;
export const COMPACTION_NOTICE_MARK = impl.COMPACTION_NOTICE_MARK;
export const countMessage = impl.countMessage;
export const countMessages = impl.countMessages;
export const countText = impl.countText;
export const DEFAULT_C_IN = impl.DEFAULT_C_IN;
export const DEFAULT_C_OUT = impl.DEFAULT_C_OUT;
export const DEFAULT_COMPACT_RATIO = impl.DEFAULT_COMPACT_RATIO;
export const DEFAULT_RETAIN_RATIO = impl.DEFAULT_RETAIN_RATIO;
export const defineTool = impl.defineTool;
export const EventKind = impl.EventKind;
export const extractFilePath = impl.extractFilePath;
export const foldToolResults = impl.foldToolResults;
export const kernelReadFile = impl.kernelReadFile;
export const kernelWriteFile = impl.kernelWriteFile;
export const log = impl.log;
export const LOSS_FACTOR_PER_EVENT = impl.LOSS_FACTOR_PER_EVENT;
export const nextFoldBoundary = impl.nextFoldBoundary;
export const parseFilePathArg = impl.parseFilePathArg;
export const registerCompactionImplementation = impl.registerCompactionImplementation;
export const resolveGuardToolName = impl.resolveGuardToolName;
export const streamWithIdleTimeout = impl.streamWithIdleTimeout;
export const WRITE_TOOLS = impl.WRITE_TOOLS;

export type CompactionConfig = import('./host').CompactionConfig;
export type CompactionEvent = import('./host').CompactionEvent;
export type CompactionHost = import('./host').CompactionHost;
export type CompactionImplementation = import('./host').CompactionImplementation;
export type CompactionSessionStats = import('./host').CompactionSessionStats;
export type CompactionTracker = import('./host').CompactionTracker;
export type Message = import('./host').Message;
export type Provider = import('./host').Provider;
export type SummaryCall = import('./host').SummaryCall;
export type SummaryRun = import('./host').SummaryRun;
export type Tool = import('./host').Tool;
export type ToolRegistry = import('./host').ToolRegistry;
export type ToolSchema = import('./host').ToolSchema;
export type Usage = import('./host').Usage;
