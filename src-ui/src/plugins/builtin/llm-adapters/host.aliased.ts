// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LLM adapter · 宿主依赖面 · 构建产物域（与 host.ts 同形状镜像；类型面以
// `typeof import('./host')` 对拍）。
//
// 2026-09-24 批 2a 归家：三方言实现与两个私有 helper 已在本包内 ⇒ 这里只桥
// 仍住内核的依赖面（见 host.ts 头注）。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}

function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) {
    throw new Error('[llm-adapters/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  }
  return host;
}

const impl = requireHost().mods.faceDeps as unknown as typeof import('./host');

export const PROVIDER_PROTOCOL_DEFAULTS = impl.PROVIDER_PROTOCOL_DEFAULTS;
export const ApiError = impl.ApiError;
export const ChunkType = impl.ChunkType;
export const classifyError = impl.classifyError;
export const classifyStreamError = impl.classifyStreamError;
export const errorCodeFromBody = impl.errorCodeFromBody;
export const retryAfterSeconds = impl.retryAfterSeconds;
export const sanitizeToolPairing = impl.sanitizeToolPairing;
export const clampMaxTokens = impl.clampMaxTokens;
export const getModel = impl.getModel;
export const classifyProviderError = impl.classifyProviderError;
export const modelEntries = impl.modelEntries;
export const parseModelEntry = impl.parseModelEntry;
export const assertEffortDeclared = impl.assertEffortDeclared;
export const isThinkingMode = impl.isThinkingMode;
export const THINKING_EFFORT_BUDGETS = impl.THINKING_EFFORT_BUDGETS;
export const thinkingCapability = impl.thinkingCapability;
export const proxyFetch = impl.proxyFetch;

export type ChatImageRef = import('./host').ChatImageRef;
export type Chunk = import('./host').Chunk;
export type ClassifiedProviderError = import('./host').ClassifiedProviderError;
export type Message = import('./host').Message;
export type ModelDescriptor = import('./host').ModelDescriptor;
export type ModelMeta = import('./host').ModelMeta;
export type Provider = import('./host').Provider;
export type Request = import('./host').Request;
export type ResponsesOutputItem = import('./host').ResponsesOutputItem;
export type Role = import('./host').Role;
export type StoredThinking = import('./host').StoredThinking;
export type ThinkingEffort = import('./host').ThinkingEffort;
