// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! MCP 工具注册 — 把外部 MCP server 工具包装成 ToolRegistry 里的 Tool。
//!
//! 命名规范：`mcp__<serverName>__<rawName>`，避免与本地 hologram 工具冲突。
//! 每个远端工具包装成 `Tool`：execute 走 McpClient.callTool（signal 支持取消），
//! readOnly 由 resolveMcpToolReadOnly 判定（**fail-closed**——缺省视为写）。

import type { Tool, ToolRegistry } from '../tool';
import type { McpClient, McpToolAnnotations } from './client';

interface RawMcpSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: McpToolAnnotations;
}

/** MCP 工具只读语义判定（**单一真源**——registry 与 plugins/mcp-bridge 两处工具
 *  构造共用，杜绝各判各的）。
 *
 *  优先级：条目级显式声明（`manifest.mcpServers[].readOnly` / 用户 `~/.lantai/mcp.json`
 *  同名字段）> 远端 `annotations.readOnlyHint === true` > **缺省 false（fail-closed）**。
 *
 *  为什么 fail-closed（2026-09-13 P0，见 docs/plans/office-cli-integration-plan.md §5）：
 *  旧实现两处硬编码 `readOnly: () => true`（注释「写入型由调用方按需覆盖」，实际全仓
 *  零调用方覆盖）——于是**任何写型 MCP 工具在兰台都被当只读**：plan 模式放行写动作
 *  （`plan/plan-registry.ts` 首行 `if (tool.readOnly()) return null;`）、并入只读并行组、
 *  plan 模式子 Agent 的静态只读集照收。远端不表态即不当只读，是唯一安全的默认值；
 *  确为只读的 server 由条目级声明或远端 `readOnlyHint` 显式担保。 */
export function resolveMcpToolReadOnly(
  schema: { annotations?: McpToolAnnotations },
  serverReadOnly?: boolean,
): boolean {
  if (serverReadOnly !== undefined) return serverReadOnly;
  return schema.annotations?.readOnlyHint === true;
}

/** deferred 语境（S4 app shell 件 D）：插件声明的 server 才带——调用期
 *  （args._owner_id 在场）绑 progressToken 登记发起者，server 完成通知
 *  经此关联唤醒。非插件面（用户自配 server）不传 = 行为不变。 */
export interface McpDeferredContext {
  plugin: string;
  /** token 登记面（注入隔离——registry 不直接依赖 plugins 层）。 */
  bindToken: (owner: { ownerId: string; plugin: string; tool: string }) => string | undefined;
}

/** 把远端 schema 包装成本地 Tool（执行经 McpClient，signal 透传支持取消）。 */
export function mcpClientTool(
  client: McpClient,
  schema: RawMcpSchema,
  execOverrides?: Partial<Tool>,
  deferred?: McpDeferredContext,
): Tool {
  const rawName = schema.name;
  const qualified = client.qualifiedName(rawName);
  const inputSchema = schema.inputSchema ?? { type: 'object', properties: {} };
  const required = inputSchema.required ?? [];
  return {
    name: () => qualified,
    description: () => schema.description ?? `(external MCP tool from ${client.server})`,
    parameters: () => ({
      type: 'object',
      properties: inputSchema.properties ?? {},
      required,
    }),
    readOnly: () => resolveMcpToolReadOnly(schema),
    execute: async (args: Record<string, unknown>, onProgress?: (chunk: string) => void, signal?: AbortSignal) => {
      // deferred 语境 + Agent 发起（executor 注入 _owner_id）→ 绑 token
      // （S4：server 完成通知 lantai/deferred 回带此 token，桥翻译成唤醒）；
      // 请求带 progressToken 触发服务器进度推送，桥接成 onProgress 文本块。
      const ownerId = deferred && typeof args._owner_id === 'string' ? args._owner_id : undefined;
      const dfToken = ownerId ? deferred?.bindToken({ ownerId, plugin: deferred.plugin, tool: qualified }) : undefined;
      const token = dfToken ?? (onProgress ? `tok-${rawName}-${Date.now()}` : undefined);
      const res = await client.callTool(rawName, args, signal, token);
      if (res.isError) {
        return `[MCP ${qualified} ERROR] ${res.text}`;
      }
      return res.text;
    },
    ...execOverrides,
  };
}

/** 把当前 client 的整组远端工具注册进 registry。返回注册的限定名集合。 */
export function registerMcpTools(client: McpClient, registry: ToolRegistry): string[] {
  const names: string[] = [];
  for (const schema of client.listRemoteTools()) {
    const tool = mcpClientTool(client, schema);
    try {
      registry.register(tool);
      names.push(tool.name());
    } catch {
      // 重名（多个 client 同 serverName）→ 跳过，避免注册冲突
    }
  }
  return names;
}

/** 卸载某 client 的远端工具（断开时调用）。 */
export function unregisterMcpTools(client: McpClient, registry: ToolRegistry): void {
  for (const schema of client.listRemoteTools()) {
    registry.unregister(client.qualifiedName(schema.name));
  }
}
