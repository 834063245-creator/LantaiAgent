// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// UI 消息数投影（provider 事件消息 → 开卷重建会产生的 UI 消息条数）。
// 卷目录在缺 UI 快照时用它回退；规则必须与 session-rebuild 的
// `rebuildMessagesFromMessages` 同步，否则同一卷开/合仍会两把尺。

import { isInternalMessage } from './session-types';

export interface CountableProviderMessage {
  role?: string;
  content?: string;
}

/** 冷恢复会生成多少条 UI 消息（不重建对象）：
 *  · 真实来文 → 1 条 user；assistant（含工具步）→ 1 条 assistant；
 *  · system / tool 不入 UI；
 *  · 内部来文默认不入 UI；`<compacted-context>` 会变成 1 条压缩 notice。
 *
 *  tool 必须排除：事件日志里一条助手回复常拆成多条 assistant/tool 消息，
 *  摊开态 UI 却是按轮次聚合的；把 tool 数进去正是合卷前后块数跳变的根因。 */
export function countUiMessagesFromProvider(messages: ReadonlyArray<CountableProviderMessage>): number {
  let count = 0;
  for (const m of messages) {
    if (m.role === 'assistant') {
      count += 1;
      continue;
    }
    if (m.role !== 'user') continue; // system / tool 不入 UI
    if (!isInternalMessage(m.content)) {
      count += 1;
      continue;
    }
    if (m.content?.startsWith('<compacted-context>')) count += 1; // rebuild 会落一条 notice
  }
  return count;
}
