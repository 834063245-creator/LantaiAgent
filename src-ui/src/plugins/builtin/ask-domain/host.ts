// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask-domain · 宿主依赖面 · 开发/测试域。
//
// 2026-09-24 批 4c-2 归家：本族工具已搬进本包（原 agent/tools/coding.ts 的族段）
// ⇒ 本文件从「桥工厂」翻面成**桥它仍住内核的依赖面**。
// UI 依赖面类型三件在 `agent/tool.ts`（批 4c 前置上收内核契约）——类型不经 faceDeps。

export type { AskUserQuestionItem, AskUserRequest, CodingToolsUI, Tool } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
