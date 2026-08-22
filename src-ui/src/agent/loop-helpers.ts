// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具循环的纯函数助手 — 从 agent.ts 机械搬移（11c），零逻辑改动。
// 消费方：agent.ts（runLoop / _stormNudge）、compaction-summarize.ts（digestMessages）。

import type { ToolCall, Usage } from '../provider/types';

/** ⚠️ 内部契约：storm 断路器与机械摘要共享的结果形状。 */
export interface ToolOutcome {
  output: string;
  errMsg?: string;
  blocked: boolean;
  truncated: boolean;
  truncMsg?: string;
}

export function batchStormSignature(calls: ToolCall[], outcomes: ToolOutcome[]): { sig: string; ok: boolean } {
  if (calls.length === 0) return { sig: '', ok: false };
  const parts: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (!outcomes[i].errMsg || outcomes[i].blocked) return { sig: '', ok: false };
    parts.push(`${calls[i].name}\x00${outcomes[i].errMsg}`);
  }
  return { sig: parts.join('\x00'), ok: true };
}

/** 从工具调用参数中提取文件路径（read_file_content / read_file）。
 *  同时容忍 filePath 和 file_path 键；任何失败返回 null。 */
export function parseFilePathArg(argsJson: string | undefined): string | null {
  try {
    const a = JSON.parse(argsJson || '{}');
    const fp = a.filePath ?? a.file_path;
    return typeof fp === 'string' && fp.length > 0 ? fp : null;
  } catch {
    return null;
  }
}

export function finishReasonMessage(u?: Usage): string | undefined {
  if (!u) return undefined;
  switch (u.finish_reason) {
    case 'length':
      return 'response truncated: hit max output tokens';
    case 'content_filter':
      return 'response blocked by content filter';
    default:
      return undefined;
  }
}
