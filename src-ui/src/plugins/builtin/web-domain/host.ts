// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// web-domain · 宿主依赖面 · 开发/测试域。
//
// 2026-09-24 批 4b 归家：本域工具实现已搬进本包（原 agent/tools/manifest-tools.ts
// 按域拆两半）⇒ 本文件从「桥工厂」翻面成**桥它仍住内核的依赖面**。

export type { Tool, ToolExecutor } from '../../../agent/tool';
export { toInputJsonSchema } from '../../../agent/tools/define-tool';
