// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent-isolation 工具族（**归家后真源**，2026-09-24 批 4c-2）。
//
// 来历：原 agent/tools/coding.ts（一文件载五族）的该段整段移出——定义逐字保留，
// 只把内核依赖改走包内宿主面（./host）。
// 纯机械搬运（S1-2 从 createCodingTools 迁出时即「定义零改写」，本批同理）。

import { z } from 'zod';
import { defineTool, type Tool, type ToolExecutor } from './host';
export function createAgentIsolationTools(exec: ToolExecutor): Tool[] {
  return [
    // ── Phase 2c: Agent Worktree 隔离（Tauri 命令已存在） ──
    defineTool({
      name: 'agent_isolation_create',
      description:
        'Create an isolated git worktree for a sub-agent to work in. Returns the isolation path. Use before spawning a sub-agent that mutates files — prevents conflicts when multiple agents modify the same repo concurrently.',
      schema: z.object({
        agent_id: z.string().describe('Identifier for this isolation workspace'),
      }),
      execute: (args, onProgress) => exec('agent_isolation_create', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_diff',
      description:
        'Show the diff of changes made in an isolation workspace. ' +
        'Diffs over ~8000 chars are spilled to .lantai/spill/ — the result then carries the file path; read it with read_file to get the full diff.',
      schema: z.object({
        agent_id: z.string().describe('Isolation workspace to diff'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('agent_isolation_diff', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_merge',
      description: 'Merge changes from an isolation workspace back into the main repository.',
      schema: z.object({
        agent_id: z.string().describe('Isolation workspace to merge'),
      }),
      execute: (args, onProgress) => exec('agent_isolation_merge', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_discard',
      description:
        "Discard an isolation workspace and delete its worktree. Use when the sub-agent's changes are no longer needed.",
      schema: z.object({
        agent_id: z.string().describe('Isolation workspace to discard'),
      }),
      execute: (args, onProgress) => exec('agent_isolation_discard', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_status',
      description: 'List all isolation workspaces and their current status.',
      schema: z.object({}),
      readOnly: true,
      execute: (args, onProgress) => exec('agent_isolation_status', args, onProgress),
    }),
  ];
}

/** ask 工具族（S1-2 从 createCodingTools 迁出）——纯机械移动，定义零改写。
 *  ui 缺帐时 execute 返回“UI 未接线”错误（原行为保留）。*/
