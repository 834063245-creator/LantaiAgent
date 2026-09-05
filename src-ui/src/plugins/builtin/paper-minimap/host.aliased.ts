// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 小地图插件宿主依赖面 · 构建产物域（2026-09-05 插件化；增补四同款双走查）。
// 与 host.ts 同形状的镜像实现，全部能力从宿主桥 mods 取用；本文件不参与
// tsc 测试域（esbuild onResolve 把 './host' 重定向到这里）；类型面以
// `typeof import('./host')` 对拍。jsx / jsxs / Fragment：esbuild automatic
// JSX 注入面。
//
// 2026-09-06 事故立法修正：早期版本用 `take("X")` 泛型 + `faceDeps[key]` 索引
// 访问取用宿主键——esbuild 内联后保留 `requireHost()` 调用 + 运行时索引形态，
// face-keys 提取器（scripts/lib/face-keys.mjs）只认 `<impl>.X` 点访问 → 提取
// 空集 → 不产 face.json → 本插件成为 27 个 host.aliased 里唯一不受保险丝 a
// （产物 face.json ↔ 宿主面键对拍，2026-09-03 立法）保护的产物。改回与其他
// 面同构的 `const impl = host.mods.faceDeps` + `export const X = impl.X` 点
// 访问形态，使 face.json 重新产出、偏斜产物装载期拒载恢复。

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
      '[paper-minimap/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）',
    );
  }
  return host;
}

const host = requireHost();

/** 依赖实现（形状对拍开发域 host.ts——mods.faceDeps 是其超集）。 */
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const clampViewportFrame = impl.clampViewportFrame;
export const inkBarsFor = impl.inkBarsFor;
export const inkColorOf = impl.inkColorOf;
export const minimapProject = impl.minimapProject;
export const regionFrame = impl.regionFrame;
export const useCanvasViewStore = impl.useCanvasViewStore;
export const usePaperDock = impl.usePaperDock;
export const usePaperRegion = impl.usePaperRegion;

export type SourcedBlock = import('./host').SourcedBlock;
export type InkCache = import('./host').InkCache;
export type MinimapRegionInput = import('./host').MinimapRegionInput;
export type RegionView = import('./host').RegionView;

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
