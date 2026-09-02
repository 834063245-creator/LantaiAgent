// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 进程内子代理 provider · 宿主依赖面 · 开发/测试域。
// 运行时依赖 spawnSubAgentImpl 经宿主桥 mods.faceDeps 取用（产物域）。

export { spawnSubAgentImpl } from '../../../agent/subagent-spawn';
