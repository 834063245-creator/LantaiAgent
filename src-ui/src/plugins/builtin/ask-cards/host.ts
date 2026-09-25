// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask-cards 产物 · 宿主依赖面 · 开发/测试/编译域（批 9e-3，2026-09-26）。
//
// ask / 权限卡架的**形状**是内核契约（`app/chat/ask-card-contract.ts`——内核 `chat-core`
// 是消费侧，五动词 + 三个 prompt 类型都从那里取），**实现**随本包；渲染面只需要一个
// 内核值：`iconSvg`（自有静态图标库，卡片上的小图标）。句柄回注走 `useCoreStore`
// （见 AskCardsHost）。
//
// 类型再出口：包内组件从 './host' 一处取形状，产物域由 host.aliased 提供同名类型面。

export type {
  AskBatchPrompt,
  AskPrompt,
  AskQuestionItem,
  PermissionPrompt,
  PromptData,
  PromptOwner,
  PromptShelfHandle,
} from '../../../app/chat/ask-card-contract';
export { useCoreStore } from '../../../app/chat/core-instance';
export { iconSvg } from '../../../ui/icons';
