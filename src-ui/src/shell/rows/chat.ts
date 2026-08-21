// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-chat）：ChatCore 构造 + core-store 注入。
// 自 main.ts 586-589 机械迁移（S2）；V5 拆除（2026-08-22）后 starGraph/
// agentViz 接线随星图退役——ChatCore 是无头编排核心（会话/流式/权限/goal），
// 纸壳（PaperPanel）经 core-instance 消费其消息与发送面。

import { ChatCore } from '../../app/chat/chat-core';
import { useCoreStore } from '../../app/chat/core-instance';
import type { ShellRefs } from '../runtime';

export function bootChat(refs: ShellRefs): void {
  // Chat core（无头）+ 纸壳视图（经 core-instance 注入 App 树）
  refs.chatPanel = new ChatCore();
  useCoreStore.getState().setChatCore(refs.chatPanel);
}
