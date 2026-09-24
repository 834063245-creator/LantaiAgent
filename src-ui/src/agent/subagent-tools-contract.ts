// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// subagent 工具族**契约面**（批 7a，2026-09-24）：三个工具工厂归产物包
// `plugins/builtin/agent-domain/`，契约住内核——内核（blueprint 的 capability /
// tool-rows / runtime 装配类型）引用本件即可，不反向依赖产物包。
//
// 为什么 `SubAgentSpawner` 是内核契约而不是包内类型：它是**装配输入**（`ToolRowContext`
// 与 `AgentAssemblyInputs` 都带它，由 workspace 会话工厂注入），内核装配面先于产物存在。

import type { SubAgentPool } from './coordinator';
import type { Tool } from './tool';

export type SubAgentSpawner = (
  description: string,
  prompt: string,
  onProgress?: (chunk: string) => void,
  mode?: 'fork' | 'fresh',
  toolAllowlist?: string[] | null,
  signal?: AbortSignal, // pool 的中断信号 — 停/超时通过它杀死子Agent
  asyncMode?: boolean, // true = 非阻塞，立即返回 agentId，结果通过 bus 回来
  agentIdOverride?: string, // 显式指定子 Agent ID（异步模式必须，保证 LLM 拿到的 ID 与 board/bus 一致）
  outputSchema?: Record<string, unknown> | null, // 结构化返回 schema（仅同步模式）
) => Promise<{ text: string; err?: string }>;

/** subagent 工具族实现面——产物包 `hologram/agent-domain` 在 apply 期登记。 */
export interface SubAgentToolsImplementation {
  createSubAgentTool(spawner: SubAgentSpawner, pool: SubAgentPool): Tool;
  createAgentKillTool(pool: SubAgentPool, isolationExec?: import('./tool').ToolExecutor): Tool;
  createAgentStatusTool(pool: SubAgentPool): Tool;
}
