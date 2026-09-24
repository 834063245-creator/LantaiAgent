// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[asset-domain/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');
export const assetDigest = impl.assetDigest;
export const assetKinds = impl.assetKinds;
export const findAssetByContent = impl.findAssetByContent;
export const generateAssetId = impl.generateAssetId;
export const getAsset = impl.getAsset;
export const listAssets = impl.listAssets;
export const parseAssetEventOutput = impl.parseAssetEventOutput;
export const requireKind = impl.requireKind;
export const requirePresentation = impl.requirePresentation;
export const upsertAsset = impl.upsertAsset;
export const validatePayload = impl.validatePayload;
export const waitForConfirm = impl.waitForConfirm;
export const defineTool = impl.defineTool;
export type Tool = import('./host').Tool;
