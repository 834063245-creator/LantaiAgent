// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// bundled-engine · 宿主依赖面（开发/测试域）——本包需要的**全部内核面**（逐符号 re-export）。
// 产物域由构建期重定向到 './host.aliased.ts'（宿主桥 mods.faceDeps 取真实例）。
//
// 两域形状必须一致（host.aliased.ts 以 `typeof import('./host')` 对拍）；
// host-modules 的 FaceBridgeSeal 要求本文件每个**值**导出都是 faceDeps 键
// （类型导出不计——编译期擦除）。
//
// 批 10 部件三（2026-09-26）：本包从内核 `plugins/bundled-engine.ts` 拆出——**接线**随包，
// **探测 + 开关**留内核 `plugins/bundled-engine-prefs.ts`（平台只读面/偏好，设置面板要用）；
// MCP 桥面（`registerMcpServerTools` 等）本批按设计件 §4.2 方案 A 经 faceDeps 暴露给第一方产物
// （**不**新开公开通道：第三方面仍只有 `manifest.mcpServers` 声明面）。

export { createTauriProcIO } from '../../../agent/mcp/tauri-io';
// 回执面（状态栏 + 引擎台账：两个内核 store 的**真实例**——影子 store 禁止）
export { useShellStore } from '../../../app/shell-store';
// 探测 + 开关（内核平台面：`plugins/bundled-engine-prefs.ts`）
export { isBundledEngineEnabled, probeBundledEngine } from '../../../plugins/bundled-engine-prefs';
// 类型面（编译期擦除；host.aliased 以 `typeof import('./host')` 对拍，不占面键）
export type { GovernedActivationFace, McpBridgeIO } from '../../../plugins/mcp-bridge';
// MCP 受治进程桥（设计件 §4.2 方案 A：faceDeps 暴露，第三方不可见）
export {
  ASSEMBLY_READY_WAIT_MS,
  registerMcpServerTools,
  waitWithin,
} from '../../../plugins/mcp-bridge';
export { useBundledEngineStore } from '../../../state/bundled-engine-store';
