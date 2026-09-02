// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸壳插件宿主依赖面 · 构建产物域（增补四，first-party-hot-reload-plan）。
// 与 host.ts 同形状的镜像实现，全部能力从宿主桥 mods 取用；本文件不参与
// tsc 测试域（esbuild onResolve 把 './host' 重定向到这里）；类型面以
// `typeof import('./host')` 对拍——两域漂移在构建期即被 tsc 拦截。
// jsx / jsxs / Fragment：esbuild automatic JSX 注入面。

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
      '[paper-shell/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）',
    );
  }
  return host;
}

const host = requireHost();

/** 依赖实现（形状对拍开发域 host.ts——mods.faceDeps 是其超集）。 */
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const ANCHOR = impl.ANCHOR;
export const layoutRegion = impl.layoutRegion;
export const panBy = impl.panBy;
export const screenToWorld = impl.screenToWorld;
export const viewFocusRegion = impl.viewFocusRegion;
export const viewForAnchor = impl.viewForAnchor;
export const wheelFactor = impl.wheelFactor;
export const worldToScreen = impl.worldToScreen;
export const zoomAt = impl.zoomAt;
export const createSettleSelector = impl.createSettleSelector;
export const hitRegionAtWorld = impl.hitRegionAtWorld;
export const viewportCenterWorld = impl.viewportCenterWorld;
export const createFocusFlightScheduler = impl.createFocusFlightScheduler;
export const defaultFolded = impl.defaultFolded;
export const foldLabel = impl.foldLabel;
export const isFoldable = impl.isFoldable;
export const groupWorkUnits = impl.groupWorkUnits;
export const leadOf = impl.leadOf;
export const sealedMessageIdsOf = impl.sealedMessageIdsOf;
export const unitMembership = impl.unitMembership;
export const createInkCache = impl.createInkCache;
export const inkColorOf = impl.inkColorOf;
export const inkForBlock = impl.inkForBlock;
export const inkForText = impl.inkForText;
export const lodActive = impl.lodActive;
export const clearPaperMeasureCache = impl.clearPaperMeasureCache;
export const createBlockMeasureCache = impl.createBlockMeasureCache;
export const measureBlockHeightCached = impl.measureBlockHeightCached;
export const measureFolioHeadHeight = impl.measureFolioHeadHeight;
export const needsObservedHeight = impl.needsObservedHeight;
export const reportObservedBlockHeight = impl.reportObservedBlockHeight;
export const subscribeObservedBlockHeights = impl.subscribeObservedBlockHeights;
export const USER_SHRINK_MIN_W = impl.USER_SHRINK_MIN_W;
export const PaperDockContext = impl.PaperDockContext;
export const PaperRegionContext = impl.PaperRegionContext;
export const classifyDropZone = impl.classifyDropZone;
export const makeStrip = impl.makeStrip;
export const selectionMaskRects = impl.selectionMaskRects;
export const stashStripPositionAt = impl.stashStripPositionAt;
export const mergeSelectionLines = impl.mergeSelectionLines;
export const selInkPaths = impl.selInkPaths;
export const selSeedOf = impl.selSeedOf;
export const sheetCharacter = impl.sheetCharacter;
export const clampRegionW = impl.clampRegionW;
export const defaultRegionFor = impl.defaultRegionFor;
export const nearestFreeRegion = impl.nearestFreeRegion;
export const REGION_CONTENT_MARGIN = impl.REGION_CONTENT_MARGIN;
export const STREAM_REGION = impl.STREAM_REGION;
export const collapseToolGroups = impl.collapseToolGroups;
export const translateMessagesCached = impl.translateMessagesCached;
export const injectPaperTokens = impl.injectPaperTokens;
export const viewportWorldRect = impl.viewportWorldRect;
export const visibleFlowWindow = impl.visibleFlowWindow;
export const visiblePinnedIds = impl.visiblePinnedIds;
export const blockFromSnapshot = impl.blockFromSnapshot;
export const getCanvasStore = impl.getCanvasStore;
export const scheduleCanvasSave = impl.scheduleCanvasSave;
export const snapshotFromBlock = impl.snapshotFromBlock;
export const useCanvasViewStore = impl.useCanvasViewStore;
export const useDockStore = impl.useDockStore;
export const useBgAlertStore = impl.useBgAlertStore;
export const useUpdateStore = impl.useUpdateStore;
export const getChatStore = impl.getChatStore;
export const msgStoreFor = impl.msgStoreFor;
export const useCoreStore = impl.useCoreStore;
export const useDialogEscape = impl.useDialogEscape;
export const useShellStore = impl.useShellStore;
export const Icon = impl.Icon;
export const WinControls = impl.WinControls;
export const activeOverlayContributions = impl.activeOverlayContributions;
export const subscribeOverlayContributions = impl.subscribeOverlayContributions;
export const resolveAssetBlock = impl.resolveAssetBlock;
export const resolveRenderer = impl.resolveRenderer;
export const activeSpace = impl.activeSpace;
export const agentSessionState = impl.agentSessionState;

export type SourcedBlock = import('./host').SourcedBlock;
export type RegionHitRect = import('./host').RegionHitRect;
export type BlockInk = import('./host').BlockInk;
export type InkCache = import('./host').InkCache;
export type BlockMeasureCache = import('./host').BlockMeasureCache;
export type RegionView = import('./host').RegionView;
export type MaskRect = import('./host').MaskRect;
export type PaperStrip = import('./host').PaperStrip;
export type StreamRegionState = import('./host').StreamRegionState;
export type MessageTranslateCache = import('./host').MessageTranslateCache;
export type FlowGeom = import('./host').FlowGeom;
export type PinnedGeom = import('./host').PinnedGeom;
export type CanvasStore = import('./host').CanvasStore;
export type AssistantMessage = import('./host').AssistantMessage;
export type ChatMessage = import('./host').ChatMessage;
export type TextPart = import('./host').TextPart;
export type UserMessage = import('./host').UserMessage;

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
