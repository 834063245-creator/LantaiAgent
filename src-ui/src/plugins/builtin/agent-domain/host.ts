// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent-domain · 宿主依赖面 · 开发/测试域。
//
// 本包实心化后（批 7a）**桥它仍住内核的依赖面**：schema 校验四件 · 子代理活动账两件 ·
// defineTool 平台面 · 类型面（SubAgentPool / SubAgentSpawner / Tool / ToolExecutor / JsonSchema）。
// 包内符号（三个工具工厂）**不经本面二次出口**——index.ts 直连 ./subagent-tools。

export type { SubAgentPool } from '../../../agent/coordinator';
export type { JsonSchema } from '../../../agent/schema-validate';
export { assertSupportedSchema, extractJsonObject, validateObjectJsonSchema } from '../../../agent/schema-validate';
export { getSubAgentActivity, STUCK_THRESHOLD_S } from '../../../agent/subagent-activity';
export type { SubAgentSpawner, SubAgentToolsImplementation } from '../../../agent/subagent-tools-contract';
export { registerSubAgentTools } from '../../../agent/subagent-tools-impl';
export type { Tool, ToolExecutor } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
