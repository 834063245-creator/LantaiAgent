// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 用户级 MCP server 装载（skills-mcp-production-plan Commit 5b）——
// `~/.lantai/mcp.json` 声明式挂接外部 MCP server，与插件 manifest.mcpServers
// 同构但属用户级配置（跨项目个人 server）。
//
// 形状：{ "mcpServers": [ McpServerDecl... ] }（数组形态——对齐插件 manifest
// 的数组；也可收 { mcpServers: { <name>: {...} } } 映射形态——见 parseUserMcp）。
// 条目 schema 复用 McpServerDeclSchema（单一真源，不重抄）。
//
// 装载语义：
//   - 缺文件 / 坏 JSON / 空表 = 无 server（非错误——对齐 composition 缺省纪律）
//   - schema 校验失败条目 → 记 skipped（带 reason，可见诊断，不炸装载）
//   - stdio command 裸名走 PATH（用户级 server 惯例：npx/node/...）；
//     相对形态（./x）相对 ~/.lantai 解析（pluginDir 注入）
//   - 工具贡献行 id `plugin/user/mcp/<server>`（与插件贡献同寻址域，patch/preset
//     可禁用）
//
// 复用 registerMcpServerTools（治理分岔/生命周期/回收全继承——受治字段在场走
// ServerGovernor）。

import type { Context } from '../cordis';
import { kernelGlobalMemoryDir, kernelReadFile } from '../rpc-contract';
import { type McpBridgeIO, type RegisterMcpServerOptions, registerMcpServerTools } from './mcp-bridge';
import { type McpServerDecl, McpServerDeclSchema } from './types';

/** 用户级 mcp.json 装载失败诊断（UI/日志消费）。 */
export interface UserMcpReport {
  servers: number;
  skipped: Array<{ name: string; reason: string }>;
  file: string | null;
}

/** 解析用户级 mcp.json 文本 → server 声明数组。坏 JSON/缺 mcpServers = 空。
 *  宽松：schema 失败条目进 skipped 而非整体拒绝。 */
export function parseUserMcpJson(raw: string, skipped: Array<{ name: string; reason: string }>): McpServerDecl[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed == null || typeof parsed !== 'object') return [];
  const rec = parsed as Record<string, unknown>;
  let list: unknown = rec.mcpServers;
  // 映射形态 { "mcpServers": { <name>: {...} } } → 数组（补 name）
  if (list != null && !Array.isArray(list) && typeof list === 'object') {
    list = Object.entries(list as Record<string, unknown>).map(([name, v]) =>
      typeof v === 'object' && v != null ? { name, ...(v as Record<string, unknown>) } : { name },
    );
  }
  if (!Array.isArray(list)) return [];
  const out: McpServerDecl[] = [];
  for (const item of list) {
    const parsedEntry = McpServerDeclSchema.safeParse(item);
    if (parsedEntry.success) {
      out.push(parsedEntry.data);
    } else {
      const name =
        (item as { name?: unknown } | null)?.name != null ? String((item as { name: unknown }).name) : '(未命名条目)';
      const reason = parsedEntry.error.issues.map((i) => (i.path.join('.') || '(root)') + ': ' + i.message).join('; ');
      skipped.push({ name, reason });
    }
  }
  return out;
}

/** 用户级 .lantai 目录推导（kernelGlobalMemoryDir → ~/.lantai）。 */
async function resolveUserLantaiDir(): Promise<string | null> {
  try {
    const g = await kernelGlobalMemoryDir();
    const norm = g.replace(/\\/g, '/').replace(/\/+$/, '');
    const idx = norm.lastIndexOf('/global_memory');
    if (idx > 0) return norm.slice(0, idx);
    return norm;
  } catch {
    return null;
  }
}

/** 用户级 MCP server 装载（main.ts 在 loadBuiltinPlugins 后调用——ctx.tools
 *  通道已可用）。缺 mcp.json = 无操作（非错误）。 */
export async function registerUserMcpServerTools(
  ctx: Context,
  io?: McpBridgeIO,
  opts: RegisterMcpServerOptions = {},
): Promise<UserMcpReport> {
  const lantai = await resolveUserLantaiDir();
  if (!lantai) return { servers: 0, skipped: [], file: null };
  const file = `${lantai}/mcp.json`;
  let raw: string;
  try {
    raw = await kernelReadFile(file);
  } catch {
    // 缺 mcp.json = 无用户级 server（非错误）
    return { servers: 0, skipped: [], file };
  }
  const skipped: Array<{ name: string; reason: string }> = [];
  const servers = parseUserMcpJson(raw, skipped);
  if (servers.length === 0) {
    return { servers: 0, skipped, file };
  }
  // 用户级 server：pluginDir 锚点 = ~/.lantai（相对 ./x 命令解析用；裸名走 PATH）。
  // createProcIO 复用生产实现（Rust protocol_bridge spawn）——只覆盖 pluginDir。
  const userIo: McpBridgeIO = io ?? {
    createProcIO: async (bridgeId, command, args, env) => {
      const { createTauriProcIO } = await import('../agent/mcp/tauri-io');
      return createTauriProcIO(bridgeId, command, args, env);
    },
    pluginDir: async () => lantai,
  };
  // pluginName='user'——工具行 id plugin/user/mcp/<server>；生命周期/回收继承
  await registerMcpServerTools(ctx, 'user', servers, userIo, opts);
  return { servers: servers.length, skipped, file };
}
