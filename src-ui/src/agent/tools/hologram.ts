// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Hologram 引擎动态工具工厂（S1-3 从 agent-runtime/agent-builder.ts 机械迁出）。
// 迁出动机：composition/tool-rows.ts 的行 factory 需要复用（行化装配），
// 留在 agent-builder 会造成 composition ↔ runtime 循环 import。
// 定义零改写——loadHologramSchemas / mcpSchemaToTool 与迁移前逐字一致。

import { typedJsonRpc } from '../../rpc-contract';
import type { Tool, ToolExecutor } from '../tool';

export interface McpSchema {
  name: string;
  description: string;
  readOnly?: boolean;
  // properties 元素 description 可选：引擎 mcp_value 恒写但浏览器 mock 面缺省
  // （与 rpcResultSchemas.hologram_tools_list 的两态兼容口径一致）。
  inputSchema: {
    type: string;
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export async function loadHologramSchemas(): Promise<McpSchema[]> {
  try {
    return await typedJsonRpc('hologram_tools_list', {});
  } catch {
    return [];
  }
}

export function mcpSchemaToTool(schema: McpSchema, exec: ToolExecutor): Tool {
  const required = schema.inputSchema.required || [];
  return {
    name: () => schema.name,
    description: () => schema.description,
    parameters: () => ({
      type: 'object',
      properties: schema.inputSchema.properties,
      required,
    }),
    readOnly: () =>
      // 优先用引擎 schema 的 readOnly 标志（领域收敛后 plan 门禁按动作判定，
      // import_scip 等写工具不能再靠硬编码名单漏判）
      schema.readOnly ?? !['analyze_project', 'validate_project', 'rename_symbol'].includes(schema.name),
    execute: (args: Record<string, unknown>) => exec(schema.name, args),
  };
}
