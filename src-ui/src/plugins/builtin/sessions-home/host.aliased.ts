// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 案卷首页插件宿主依赖面 · 构建产物域（批 9e，2026-09-26）。
// 与 host.ts 同形状的镜像实现，全部能力从宿主桥 mods 取用；本文件不参与
// tsc 测试域（esbuild onResolve 把 './host' 重定向到这里）；类型面以
// `typeof import('./host')` 对拍——两域漂移在构建期即被 tsc 拦截。
// jsx / jsxs / Fragment：esbuild automatic JSX 注入面。
//
// 形态纪律（批 4c-3 实测病灶）：必须写成两步（`const host = requireHost();` +
// `const impl = host.mods.faceDeps;`）——构建期提取器的锚点是 `<标识符>.mods.faceDeps`，
// 单行链式写法会被判成「零需求」，保险丝 a 静默失效。

/* eslint-disable */
import type { ReactNode } from 'react';

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
      '[sessions-home/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）',
    );
  }
  return host;
}

const host = requireHost();

/** 依赖实现（形状对拍开发域 host.ts——mods.faceDeps 是其超集）。 */
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const clearWorkspaceListCache = impl.clearWorkspaceListCache;
export const typedRpc = impl.typedRpc;
export const workspaceListCached = impl.workspaceListCached;
export const pickFolder = impl.pickFolder;
export const workspaceFlow = impl.workspaceFlow;
export const shellRefs = impl.shellRefs;
export const useDockStore = impl.useDockStore;
export const useUpdateStore = impl.useUpdateStore;
export const useShellStore = impl.useShellStore;
export const WinControls = impl.WinControls;
export const onTopbarDoubleClick = impl.onTopbarDoubleClick;
export const onTopbarPointerDown = impl.onTopbarPointerDown;
export type WorkspaceSummary = import('./host').WorkspaceSummary;

// ── esbuild automatic JSX 注入面（--jsx=automatic --jsx-import-source=./host）──

export function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  return host.react.createElement(type, key === undefined ? props : { ...props, key });
}

export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  return jsx(type, props, key);
}

export const Fragment = host.react.Fragment;
