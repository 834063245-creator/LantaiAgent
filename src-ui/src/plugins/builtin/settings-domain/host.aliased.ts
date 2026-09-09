// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置域插件宿主依赖面 · 构建产物域（增补四，first-party-hot-reload-plan）。
// 与 host.ts 同形状的镜像实现，全部能力从宿主桥 mods 取用；本文件不参与
// tsc 测试域（esbuild onResolve 把 './host' 重定向到这里）；类型面以
// `typeof import('./host')` 对拍。jsx / jsxs / Fragment：esbuild automatic
// JSX 注入面。

/* eslint-disable */
import type { ComponentType, ReactNode } from 'react';

interface PluginHostBridge {
  react: {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ReactNode;
    Fragment: unknown;
  };
  mods: {
    faceDeps: Record<string, unknown>;
  };
}

function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) {
    throw new Error(
      '[settings-domain/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）',
    );
  }
  return host;
}

const host = requireHost();

/** 依赖实现（形状对拍开发域 host.ts——mods.faceDeps 是其超集）。 */
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const selectPreset = impl.selectPreset;
export const setLang = impl.setLang;
export const typedJsonRpc = impl.typedJsonRpc;
export const autoUpdateCheckEnabled = impl.autoUpdateCheckEnabled;
export const canvasWheelMode = impl.canvasWheelMode;
export const loadSettings = impl.loadSettings;
export const loadSettingsWithSecrets = impl.loadSettingsWithSecrets;
export const persistSecrets = impl.persistSecrets;
export const removeSecret = impl.removeSecret;
export const saveSettings = impl.saveSettings;
export const notifyAgentConfigChanged = impl.notifyAgentConfigChanged;
export const useCompositionStore = impl.useCompositionStore;
export const useDockStore = impl.useDockStore;
export const usePresetStore = impl.usePresetStore;
export const useUpdateStore = impl.useUpdateStore;
export const iconHtml = impl.iconHtml;
export const ConfirmDialog = impl.ConfirmDialog as ComponentType;
export const McpPage = impl.McpPage as ComponentType;
export const PluginsPage = impl.PluginsPage as ComponentType;
export const ProviderPage = impl.ProviderPage as ComponentType;
export const SkillsPage = impl.SkillsPage as ComponentType;

export type AppSettings = import('./host').AppSettings;
export type ConnectionProbe = import('./host').ConnectionProbe;
export type ProviderId = import('./host').ProviderId;

// ── esbuild automatic JSX 注入面（--jsx=automatic --jsx-import-source=./host）──

export function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  const merged = key != null ? { ...(props ?? {}), key } : (props ?? {});
  return host.react.createElement(type, merged) as ReactNode;
}

export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  return jsx(type, props, key);
}

export const Fragment = host.react.Fragment;
export type { ComponentType };
