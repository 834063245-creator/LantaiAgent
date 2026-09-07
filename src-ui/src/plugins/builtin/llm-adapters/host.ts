// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LLM adapter · 宿主依赖面 · 开发/测试域。
// 运行时依赖 createAnthropicProvider/createOpenAIProvider/createResponsesProvider
// 经宿主桥 mods.faceDeps 取用（产物域）。

export { createAnthropicProvider } from '../../../provider/anthropic';
export { createOpenAIProvider } from '../../../provider/openai';
export { createResponsesProvider } from '../../../provider/responses';
