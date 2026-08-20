// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 3（hologram/shell-chat）：ChatCore 构造 + core-store 注入 +
// setStarGraph + trail 接线。
// 自 main.ts 586-589 机械迁移。agentViz 属 graph 行产出——chat 行只消费
// （判空），不假设前行必然成功（失败隔离纪律）。

import { ChatCore } from '../../app/chat/chat-core';
import { useCoreStore } from '../../app/chat/core-instance';
import type { ShellRefs } from '../runtime';

export function bootChat(refs: ShellRefs): void {
  // Chat core（无头）+ React 信标视图（经 core-instance 注入 App 树）
  refs.chatPanel = new ChatCore();
  useCoreStore.getState().setChatCore(refs.chatPanel);
  if (refs.starGraph) refs.chatPanel.setStarGraph(refs.starGraph);
  // Agent 可视化 trail 开关（graph 行产出；缺席时 no-op）
  refs.chatPanel.setOnTrailToggle(() => refs.agentViz?.toggleTrail());
}
