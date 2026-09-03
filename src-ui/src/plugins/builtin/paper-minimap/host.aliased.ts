// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 小地图插件宿主依赖面 · 构建产物域（2026-09-05 插件化；增补四同款双走查）。
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
      '[paper-minimap/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）',
    );
  }
  return host;
}

type Host = typeof import('./host');
const faceDeps = requireHost().mods.faceDeps;

/** 从宿主桥取模块真实例；缺失 = 显式抛错（不得静默 undefined 走查）。 */
function take<T>(key: keyof Host & string): T {
  const v = faceDeps[key];
  if (v === undefined) {
    throw new Error(`[paper-minimap] 宿主面缺键 ${key}——产物与 exe 版本偏斜（face.json 对拍应已拒载）`);
  }
  return v as T;
}

export const clampViewportFrame = take<typeof import('./host')['clampViewportFrame']>('clampViewportFrame');
export const inkBarsFor = take<typeof import('./host')['inkBarsFor']>('inkBarsFor');
export const inkColorOf = take<typeof import('./host')['inkColorOf']>('inkColorOf');
export const minimapProject = take<typeof import('./host')['minimapProject']>('minimapProject');
export const regionFrame = take<typeof import('./host')['regionFrame']>('regionFrame');
export const usePaperDock = take<typeof import('./host')['usePaperDock']>('usePaperDock');
export const usePaperRegion = take<typeof import('./host')['usePaperRegion']>('usePaperRegion');
export const useCanvasViewStore = take<typeof import('./host')['useCanvasViewStore']>('useCanvasViewStore');
export type { SourcedBlock } from '../../../paper/block-model';
export type { InkCache } from '../../../paper/ink';
export type { MinimapRegionInput } from '../../../paper/minimap-core';
export type { RegionView } from '../../../paper/region-view';

// ── esbuild automatic JSX 注入面（--jsx=automatic --jsx-import-source=./host）──

export function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  const merged = key != null ? { ...(props ?? {}), key } : (props ?? {});
  return requireHost().react.createElement(type, merged) as ReactNode;
}

export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  return jsx(type, props, key);
}

export const Fragment = requireHost().react.Fragment;
export type { ComponentType };
