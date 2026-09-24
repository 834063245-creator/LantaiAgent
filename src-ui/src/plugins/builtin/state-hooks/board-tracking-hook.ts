// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// BoardFileTrackingHook — PostTool hook，自动追踪子 Agent 文件修改到 TaskBoard（**归家后真源**，2026-09-24 批 6c；原 agent/hooks/board-tracking-hook.ts）
//
// 复用现有 HookRegistry 机制（post-tool 注入点）。
// 子 Agent 调用 write_file / edit_file 时自动登记文件路径到 board。

import type { Hook, TaskBoard } from './host';

/** 工具名 → 是否修改文件 */
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export function createBoardTrackingHook(agentId: string, board: TaskBoard): Hook {
  return {
    name: 'board-file-tracking',

    shouldEnrich(toolName: string): boolean {
      return FILE_WRITE_TOOLS.has(toolName);
    },

    async enrich(_toolName: string, args: Record<string, unknown>, result: string): Promise<string> {
      const filepath = String(args.filePath || args.file_path || '');
      if (filepath) {
        board.recordFileTouch(agentId, filepath);
      }
      return result;
    },
  };
}
