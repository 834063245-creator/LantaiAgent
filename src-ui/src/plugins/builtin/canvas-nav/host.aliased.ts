// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 画布导航插件宿主依赖面 · 构建产物域（增补四，first-party-hot-reload-plan）。
//
// 与 host.ts 同形状的镜像实现，但**全部能力从宿主桥 mods 取用**
// （window.__lantai_plugin_host__.mods.faceDeps——bundle 域真实例注册表，
// 见 builtin/host-modules.ts）。本文件不参与 tsc 测试域（esbuild 构建时
// onResolve 把 './host' 重定向到这里）；类型面以 `typeof import('./host')`
// 对拍开发域形状——两域漂移在构建期即被 tsc 拦截。
//
// jsx / jsxs / Fragment：esbuild automatic JSX 注入面
// （--jsx=automatic --jsx-import-source=./host），经 createElement 等价实现。

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
      '[canvas-nav/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）',
    );
  }
  return host;
}

const host = requireHost();

/** 依赖实现（形状对拍开发域 host.ts——mods.faceDeps 是其超集）。 */
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const agentSessionState = impl.agentSessionState;
export type ExecStateInstance = import('./host').ExecStateInstance;
export const activeSpace = impl.activeSpace;
export const screenToWorld = impl.screenToWorld;
export const pickDropAnchor = impl.pickDropAnchor;
export const useCanvasViewStore = impl.useCanvasViewStore;
export const useDockStore = impl.useDockStore;
export const getChatStore = impl.getChatStore;
export const msgStoreFor = impl.msgStoreFor;
export const useCoreStore = impl.useCoreStore;
export const useAskStore = impl.useAskStore;
export const useShellStore = impl.useShellStore;

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
