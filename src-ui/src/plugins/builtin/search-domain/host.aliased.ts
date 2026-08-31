// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// search-DomainPlugin 域插件宿主依赖面 · 构建产物域（增补四）。与 host.ts 同形状，从宿主桥
// mods.toolDomains 取 bundle 域同一插件对象；本文件不参与 tsc 测试域。

/* eslint-disable */
interface PluginHostBridge {
  mods: {
    toolDomains: Record<string, unknown>;
  };
}

function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) {
    throw new Error(
      '[search-DomainPlugin/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）',
    );
  }
  return host;
}

const impl = requireHost().mods.toolDomains as unknown as typeof import('./host');

export const searchDomainPlugin = impl.searchDomainPlugin;
