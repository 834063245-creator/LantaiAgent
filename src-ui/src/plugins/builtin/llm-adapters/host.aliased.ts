// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LLM adapter · 宿主依赖面 · 构建产物域。

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

export const createAnthropicProvider = impl.createAnthropicProvider;
export const createOpenAIProvider = impl.createOpenAIProvider;
