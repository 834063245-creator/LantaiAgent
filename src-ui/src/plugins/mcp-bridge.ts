// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// MCP 机器桥（S4-4 乙，设计件 S4-preset-realm-distribution.md §2.7）——
// manifest.mcpServers 声明式挂接外部 MCP server。
//
// 关键裁定（设计件原文）：MCP 工具是**工具行贡献**（composition 的 tools
// 域），不是旁路注册——装载期把每个 mcpServer 折算成一条工具贡献（行 id
// `plugin/<插件名>/mcp/<server名>`，factory = 惰性连接 + 远端工具整组产出）。
// preset/patch 可以禁用某插件的某个 MCP server（S4-4 甲起贡献行全量可寻址
// ——组合均匀性不破）。进程生命周期：bridge 的 kill 归插件 fiber disposer
// （贡献注销 → client disconnect → transport kill 链式停）。
//
// failurePolicy 语义（对齐 dsh-bundle 的 failOnStartupError: false 哲学：
// 瞬态机器不是装载失败的合格理由）：
//   - startup-error：装载期急连接验证——失败抛出 → 插件 error 记录；
//   - lazy（缺省）：首装配连接——失败 = 空集 + warn（pluginToolRows 的
//     「空集不缓存」语义保证下次装配重试；服务器恢复后新会话即得工具面）。
//     断线后的自动重连监督（DSH reconnect loop 同构）是未决项——v1 以
//     装配期重试承担。
//
// 边界（ADR §5 维持）：这是「插件挂外部机器」，不是「进程内宿主插件」——
// 后者永久关闭，本批不开口子。
//
// 可注入面（McpBridgeIO）：ProcIO 构造与插件目录解析都是宿主能力（Rust
// protocol_bridge / plugin_dir RPC）——测试注入 fake（loopback JSON-RPC
// 行协议），生产走默认实现。

import { McpClient, mcpClientTool, type ProcIO } from '../agent/mcp';
import { createTauriProcIO } from '../agent/mcp/tauri-io';
import type { Context } from '../cordis';
import { typedRpc } from '../rpc-contract';
import type { McpServerDecl } from './types';

/** 宿主 IO 能力（生产 = Rust 桥；测试注入 fake）。 */
export interface McpBridgeIO {
  /** 起一个 stdio 子进程桥（bridgeId 唯一寻址，kill 归 ProcIO）。 */
  createProcIO(bridgeId: string, command: string, args: string[]): Promise<ProcIO>;
  /** 插件目录绝对路径（stdio command 相对解析的锚点）。 */
  pluginDir(pluginName: string): Promise<string>;
}

/** 生产 IO：Rust protocol_bridge spawn + plugin_dir RPC。 */
export const tauriMcpBridgeIO: McpBridgeIO = {
  createProcIO: (bridgeId, command, args) => createTauriProcIO(bridgeId, command, args),
  pluginDir: (name) => typedRpc('plugin_dir', { name }),
};

/** stdio command 解析：含路径分隔符的相对形态 → 相对插件目录（归一 `./`
 *  前缀与分隔符）；裸名（无分隔符）/绝对路径原样（PATH / 绝对定位）。 */
function resolveCommand(command: string, pluginDir: string): string {
  const looksRelative = !/^[a-zA-Z]:[\\/]/.test(command) && /[\\/]/.test(command);
  if (!looksRelative) return command;
  return resolvePluginRel(command, pluginDir);
}

/** `./`/`../` 前缀的 arg → 相对插件目录解析（平台化 P4 · D1 端到端例子：
 *  让示例插件能以 `args: ["./server.cjs"]` 便携声明脚本参数——裸名 arg
 *  （如 `-v`、`--flag`、`file.json`）不受影响，向后兼容）。 */
function resolvePluginRel(p: string, pluginDir: string): string {
  const base = pluginDir.replace(/[\\/]$/, '');
  const tail = p
    .replace(/^[\\/]+/, '')
    .split(/[\\/]+/)
    .filter((seg) => seg !== '.')
    .join('/');
  return base + '/' + tail;
}

/** 组装一个 server 的 McpClient 配置（stdio 经注入 IO；http 直连）。 */
async function connectServer(server: McpServerDecl, pluginName: string, io: McpBridgeIO): Promise<McpClient> {
  if (server.transport === 'http') {
    const client = new McpClient({
      serverName: server.name,
      failurePolicy: server.failurePolicy ?? 'lazy',
      url: server.url,
      headers: server.headers,
    });
    await client.connect();
    return client;
  }
  const pluginDir = await io.pluginDir(pluginName);
  const bridgeId = `mcp-bridge/${pluginName}/${server.name}`;
  const args = (server.args ?? []).map((a) => (/^\.{1,2}[\\/]/.test(a) ? resolvePluginRel(a, pluginDir) : a));
  const procIO = await io.createProcIO(bridgeId, resolveCommand(server.command ?? '', pluginDir), args);
  const client = new McpClient({
    serverName: server.name,
    failurePolicy: server.failurePolicy ?? 'lazy',
    procIO,
  });
  await client.connect();
  return client;
}

/**
 * 注册一个插件声明的全部 MCP server 工具贡献（loader 装载期调用）。
 *
 * 每个 server：一条 ctx.tools 贡献（id `<插件名>/mcp/<server名>`——折算行
 * id `plugin/<插件名>/mcp/<server名>`）；贡献注销 + client kill 挂该 server
 * 自己的 ctx.effect（插件 fiber dispose → 进程链式停）。startup-error 的
 * server 急连接失败 → 抛出（调用方 loader 把插件记 error）；已注册的
 * 先行 server 贡献由各自 effect 清理（失败不残留）。
 */
export async function registerMcpServerTools(
  ctx: Context,
  pluginName: string,
  servers: McpServerDecl[],
  io: McpBridgeIO = tauriMcpBridgeIO,
): Promise<void> {
  for (const server of servers) {
    // 急连接（startup-error）：装载期验证机器起得来；失败即抛（→ 插件 error）
    let eager: McpClient | null = null;
    if (server.failurePolicy === 'startup-error') {
      eager = await connectServer(server, pluginName, io);
    }
    // 惰性连接（lazy 缺省 / startup-error 急连接复用）：首装配建连 + tools/list
    let client: McpClient | null = eager;
    const contribId = `${pluginName}/mcp/${server.name}`;
    const dispose = ctx.tools.register({
      id: contribId,
      factory: async () => {
        try {
          if (!client) client = await connectServer(server, pluginName, io);
          if (!client.isConnected) await client.connect();
          return client.listRemoteTools().map((schema) => mcpClientTool(client as McpClient, schema));
        } catch (e) {
          // lazy 语义：瞬态机器不炸装配——空集 + 可见 warn；空集不缓存
          // （pluginToolRows），下次装配重试
          client = null;
          console.warn(`[mcp-bridge] server "${server.name}"（${pluginName}）连接失败——本次装配空集，下次装配重试:`, e);
          return [];
        }
      },
    });
    ctx.effect(
      () => () => {
        dispose();
        if (client) {
          void client.ownedDisposer()();
          client = null;
        }
      },
      `${contribId}`,
    );
  }
}
