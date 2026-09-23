// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 渲染器宿主桥 · 构建期 alias 面（P1，first-party-hot-reload-plan）——
// 与 renderer-host.ts 同形状的明星实现，但**全部能力从宿主桥
// `window.__lantai_plugin_host__` 取用**，产出自包含 ESM（插件无裸 import）。
//
// 本文件不参与 tsc 测试域（esbuild 构建时用 onResolve 把 './renderer-host'
// 指到这里；tsc 走真 renderer-host.ts 直连 react）。生产包运行时：
//   - rendererReact / rendererHooks：宿主桥注入的 React（全量 + hooks）；
//   - rendererOverlay：宿主桥注入的 Overlay 浮层组件；
//   - rendererRpc：宿主桥注入的 typedRpc；
//   - jsx / jsxs / Fragment：esbuild automatic JSX 注入面（React 形状等价）。
//
// 本文件是「产物专用」——类型面以最小形状声明 + 显式断言，避免与完整
// React 类型系统摩擦（构建产物不需要通过项目 tsc，但保持类型合法便于
// biome 与编辑器）。

import type { Component, ComponentType, ReactNode } from 'react';

/** 宿主桥最小形状（与 plugins/loader.ts 的注入面一致）。
 *  注：运行期注入的是 React **本体**（`react: React`），故 `Component` / `useMemo`
 *  在产物域同样可用——这里只是把类型面补齐（B1 错误边界用 Component；
 *  B2 代码查看器的高亮记忆化用 useMemo）。 */
interface PluginHostBridge {
  react: {
    Component: typeof Component;
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ReactNode;
    Fragment: unknown;
    useEffect: (effect: () => undefined | (() => undefined), deps?: readonly unknown[]) => undefined;
    useMemo: <T>(factory: () => T, deps?: readonly unknown[]) => T;
    useRef: <T>(initial: T) => { current: T };
    useState: <T>(initial: T | (() => T)) => [T, (v: T | ((p: T) => T)) => void];
  };
  Overlay: ComponentType<{
    open: boolean;
    onClose: () => void;
    portal?: boolean;
    inertBackground?: boolean;
    className?: string;
    veilClose?: boolean;
    children?: ReactNode;
  }>;
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** 重依赖查看器取件（P2）：宿主桥注入 `loadHeavyViewer`（loader.ts）。 */
  loadViewer: (id: string) => Promise<ComponentType<{ mode: string } & Record<string, unknown>>>;
}

function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) {
    throw new Error(
      '[renderer-host.aliased] 宿主桥不可用——内置渲染器插件必须在 Tauri 宿主内装载' +
        '（window.__lantai_plugin_host__ 缺失）',
    );
  }
  return host;
}

const host = requireHost();

/** React 全量（组件构造面——esbuild define 产物域用到的元素类型不在此受限）。 */
export const rendererReact = host.react;

/** hooks 子集（useState/useEffect/useRef/useMemo）。 */
export const rendererHooks = {
  useEffect: host.react.useEffect,
  useMemo: host.react.useMemo,
  useRef: host.react.useRef,
  useState: host.react.useState,
} as const;

/** Overlay 浮层组件（媒体预览用）。 */
export const rendererOverlay = host.Overlay;

/** 媒体渲染器的 RPC 取用（read_file_base64）。 */
export function rendererRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  return host.rpc(method, params);
}

/** 重依赖查看器取件（P2）：本体在应用 bundle，产物域经宿主桥按 id 取（同 rendererRpc 纪律）。 */
export function rendererLoadViewer(id: string): Promise<ComponentType<never>> {
  return host.loadViewer(id) as unknown as Promise<ComponentType<never>>;
}

// ── esbuild automatic JSX 注入面（--jsx=automatic --jsx-import-source=./renderer-host）──
// React 的 jsx-runtime 形状：jsx(type, props, key?) / jsxs(type, props, key?) /
// Fragment。经 createElement 等价实现——纯函数组件渲染，key 由 React 处理。

/** createElement 等价（自动 JSX 注入）。props 已含 children（jsx-runtime 形状）。 */
export function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  const merged = key != null ? { ...(props ?? {}), key } : (props ?? {});
  return host.react.createElement(type, merged) as ReactNode;
}

/** createElement 等价（多子——static children，children 已在 props 中为数组）。 */
export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  return jsx(type, props, key);
}

/** Fragment。 */
export const Fragment = host.react.Fragment;
