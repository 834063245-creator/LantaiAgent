// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 7（hologram/shell-dataflow-parser）：NL→symbol 回退解析器——
// 面板 NL 查询启发式失败时用 Agent provider 解析符号名。
// 自 main.ts 601-630 机械迁移。workspace 引用改为 refs 动态取
// （原闭包读模块级变量，等价：boot 时点 refs.workspace 必为 null，
// 真正消费发生在用户查询时——彼时 refs 已被 workspace 流填充）。

import { streamWithIdleTimeout } from '../../provider/idle-stream';
import { ChunkType } from '../../provider/types';
import { setDataflowQueryParser } from '../../state/dock-config';
import type { ShellRefs } from '../runtime';

export function bootDataflowParser(refs: ShellRefs): void {
  // 接线 NL→symbol 回退：如果启发式解析器失败，使用 Agent 解析
  setDataflowQueryParser(async (nl: string): Promise<string[]> => {
    try {
      const ws = refs.workspace;
      if (!ws?.prov) return [];
      // 60s 空闲超时守卫（与 Agent 主循环共用）— 挂起/流内错误均视为解析失败
      const stream = streamWithIdleTimeout(ws.prov, new AbortController().signal, {
        messages: [
          {
            role: 'user',
            content: `Extract code symbol names (functions, classes, modules, variables) from this query. Return ONLY a JSON array of strings, nothing else. If no symbols found, return [].\n\nQuery: "${nl}"`,
          },
        ],
        tools: [],
        temperature: 0,
        max_tokens: 200,
      });
      const parts: string[] = [];
      for await (const chunk of stream.chunks) {
        if (chunk.type === ChunkType.Text && chunk.text) parts.push(chunk.text);
        if (chunk.type === ChunkType.Error) throw chunk.err ?? new Error('stream error');
      }
      const text = parts.join('').trim();
      // 从响应中提取 JSON 数组
      const match = text.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
      return [];
    } catch {
      return [];
    }
  });
}
