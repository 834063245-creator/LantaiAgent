// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// wait-domain · 宿主依赖面 · 开发/测试域。
//
// 2026-09-24 批 3a 归家（账本 §1.1 / §6 批 3）：工具工厂实现已搬进本包
// ⇒ 本文件从「桥工厂」翻面成**桥它仍住内核的依赖面**（defineTool 工厂 /
// Tool 类型面 / 该域用到的内核工具函数），产物域经 mods.faceDeps 取用。

export type { SubAgentPool } from '../../../agent/subagent-runtime-contract';
export { SubAgentStatus } from '../../../agent/subagent-runtime-contract';
export type { Tool } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
