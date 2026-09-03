// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞插件宿主依赖面 · 构建产物域（增补四，first-party-hot-reload-plan）。
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
      '[compose-dock/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）',
    );
  }
  return host;
}

const host = requireHost();

/** 依赖实现（形状对拍开发域 host.ts——mods.faceDeps 是其超集）。 */
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const agentSessionState = impl.agentSessionState;
export const composerSubmitOnKey = impl.composerSubmitOnKey;
export const isMockMode = impl.isMockMode;
export const typedJsonRpc = impl.typedJsonRpc;
export const useShellStore = impl.useShellStore;
export const watchFileDragDrop = impl.watchFileDragDrop;
export const usePaperDock = impl.usePaperDock;
export const usePaperRegion = impl.usePaperRegion;
export const buildStageAnchors = impl.buildStageAnchors;
export const nearestAnchorAt = impl.nearestAnchorAt;
export const viewportMarker = impl.viewportMarker;
export const computeSlider = impl.computeSlider;
export const grabOffsetAt = impl.grabOffsetAt;
export const scrubViewTop = impl.scrubViewTop;
export const jumpViewTopAt = impl.jumpViewTopAt;
export const stripToWorld = impl.stripToWorld;
export const deriveMarks = impl.deriveMarks;
export const unreadBand = impl.unreadBand;
export const createInkCache = impl.createInkCache;
export const inkColorOf = impl.inkColorOf;
export const inkForBlock = impl.inkForBlock;
export const useCanvasViewStore = impl.useCanvasViewStore;
export const findModels = impl.findModels;
export const getDynamicFetchFailure = impl.getDynamicFetchFailure;
export const getDynamicFetchInflight = impl.getDynamicFetchInflight;
export const getModel = impl.getModel;
export const hasDynamicFetchInflight = impl.hasDynamicFetchInflight;
export const onDynamicFetchChange = impl.onDynamicFetchChange;
export const searchModels = impl.searchModels;
export const resolveApiKey = impl.resolveApiKey;
export const thinkingOptionsFor = impl.thinkingOptionsFor;
export const effectiveModels = impl.effectiveModels;
export const loadSettings = impl.loadSettings;
export const onSettingsSaved = impl.onSettingsSaved;
export const getComposeStore = impl.getComposeStore;
export const resolveNewSessionDefault = impl.resolveNewSessionDefault;
export const MODE_DESCRIPTIONS = impl.MODE_DESCRIPTIONS;
export const MODE_LABELS = impl.MODE_LABELS;
export const PERMISSION_MODES = impl.PERMISSION_MODES;
export const useModeStore = impl.useModeStore;
export const getChatStore = impl.getChatStore;
export const CommandRegistry = impl.CommandRegistry;
export const useCoreStore = impl.useCoreStore;
export const iconHtml = impl.iconHtml;

export type StoredThinking = import('./host').StoredThinking;
export type ThinkingMode = import('./host').ThinkingMode;
export type ProviderSettings = import('./host').ProviderSettings;
export type ComposeSessionPrefs = import('./host').ComposeSessionPrefs;
export type PermissionMode = import('./host').PermissionMode;
export type ModelDescriptor = import('./host').ModelDescriptor;
export type Protocol = import('./host').Protocol;
export type TocRange = import('./host').TocRange;
export type TocMark = import('./host').TocMark;
export type TocMarkInput = import('./host').TocMarkInput;
export type TocSlider = import('./host').TocSlider;
export type SourcedBlock = import('./host').SourcedBlock;
export type FileDragEvent = import('./host').FileDragEvent;

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
