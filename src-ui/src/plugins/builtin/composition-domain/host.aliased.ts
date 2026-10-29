// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composition-domain · 宿主依赖面 · 构建产物域（与 host.ts 同形状镜像；
// 类型面以 `typeof import('./host')` 对拍）。全部能力从宿主桥 mods.faceDeps 取用。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[composition-domain/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const defineTool = impl.defineTool;
export const factoryComposition = impl.factoryComposition;
export const parseCompositionPatch = impl.parseCompositionPatch;
export const resolveRoster = impl.resolveRoster;
export const CompositionPatchError = impl.CompositionPatchError;
export const discoverPresets = impl.discoverPresets;
export const parsePatchYamlText = impl.parsePatchYamlText;
export const stringifyPatchYaml = impl.stringifyPatchYaml;
export const reapplyComposition = impl.reapplyComposition;
export const builtinPresets = impl.builtinPresets;
export const isValidPresetId = impl.isValidPresetId;
export const usePresetStore = impl.usePresetStore;
export const kernelCreateDirectory = impl.kernelCreateDirectory;
export const kernelReadFile = impl.kernelReadFile;
export const kernelWriteFile = impl.kernelWriteFile;
export const typedRpc = impl.typedRpc;

export type Tool = import('./host').Tool;
export type CompositionPatch = import('./host').CompositionPatch;
export type PresetEntry = import('./host').PresetEntry;
export type ResolvedComposition = import('./host').ResolvedComposition;
