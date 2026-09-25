// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}
function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) throw new Error('[task-domain/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  return host;
}
// 批 9h-5：本包整件归家 ⇒ 桥面 = 登记口（register/clear）+ 内核依赖面。
// 锚点形态 `<标识符>.mods.faceDeps` 拆两步写（构建期提取器按它认键，见账本 §5 第 4 条）。
const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');
export const registerTaskImplementation = impl.registerTaskImplementation;
export const clearTaskImplementation = impl.clearTaskImplementation;
export const createTaskTools = impl.createTaskTools;
export const createBoardStatusTool = impl.createBoardStatusTool;
export const BoardPersistence = impl.BoardPersistence;
export const defineTool = impl.defineTool;
export const parseIsolationDiff = impl.parseIsolationDiff;
export const spillToFile = impl.spillToFile;
