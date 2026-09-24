// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// browser-desktop-domain · 宿主依赖面 · 开发/测试域。
//
// 2026-09-24 批 4a 归家（账本 §1.1 / §6 批 4）：browser/desktop 工具实现（912 行）
// 已搬进本包 ⇒ 本文件从「桥两个工厂」翻面成**桥它仍住内核的依赖面**
// （typedRpc 强制层口 · errText · Tool 类型 · defineTool/toInputJsonSchema ·
// parseStructuredError），产物域经 mods.faceDeps 取用。

export { errText } from '../../../agent/loop-helpers';
export type { Tool } from '../../../agent/tool';
export { defineTool, toInputJsonSchema } from '../../../agent/tools/define-tool';
export { parseStructuredError } from '../../../agent/tools/structured-error';
export { typedRpc } from '../../../rpc-contract';
