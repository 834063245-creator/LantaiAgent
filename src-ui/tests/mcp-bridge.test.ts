// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// MCP 机器桥（S4-4 乙，设计件 S4 §2.7）钉住面：
//   1. 折算：一个 mcpServer = 一条工具贡献（id <插件名>/mcp/<server名>，
//      pluginToolRows 行 id plugin/<插件名>/mcp/<server名>）——进组合解析域，
//      patch/preset 可寻址禁用（甲+乙合流）；
//   2. 惰性连接：lazy（缺省）首装配经注入 ProcIO 真实跑 MCP JSON-RPC 行协议
//      （initialize → tools/list）→ 远端工具整组产出（mcp__<server>__<name>）；
//   3. failurePolicy：startup-error 装载期急连接（失败抛出 → loader error 记录）；
//      lazy 连接失败 = 空集 + warn（不炸装配）；
//   4. 生命周期：插件 fiber dispose → 贡献注销 + client disconnect →
//      ProcIO.kill 链式停；
//   5. 空集不缓存：lazy 失败后的下次装配重试（服务器恢复 → 新装配即得工具）。
//
// ProcIO 注入 fake（设计件验收口径：vitest 用 ProcIO 注入 mock——不 spawn
// 真实进程，行协议是真的）。

import { describe, expect, it, vi } from 'vitest';
import type { ProcIO } from '../src/agent/mcp';
import type { Tool } from '../src/agent/tool';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { factoryComposition, resolveRoster } from '../src/composition/roster';
import { compositionServicesPlugin } from '../src/composition/services';
import type { BuiltinToolRow } from '../src/composition/tool-rows';
import { Context } from '../src/cordis';
import { type McpBridgeIO, registerMcpServerTools } from '../src/plugins/mcp-bridge';
import type { McpServerDecl } from '../src/plugins/types';

/** 数组取首项（断言前置——已断言长度/存在的取值面，免非空断言）。 */
function first<T>(list: T[]): T {
  if (list.length === 0) throw new Error('断言前置失败：期望非空数组');
  return list[0] as T;
}

/** 内存 MCP server：行协议 fake ProcIO（initialize/tools/list/tools/call 应答）。 */
function fakeMcpProcIO(opts: { failConnect?: boolean } = {}): { proc: ProcIO; killed: number[] } {
  const state = { failConnect: opts.failConnect ?? false };
  const killed: number[] = [];
  const outCbs = new Set<(line: string) => void>();
  const exitCbs = new Set<(code: number | null) => void>();
  const respond = (id: number, result: unknown) => {
    for (const cb of outCbs) cb(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const proc: ProcIO = {
    writeLine: (line) => {
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (msg.method && msg.id !== undefined) {
        if (msg.method === 'initialize') {
          if (state.failConnect) {
            // 模拟握手失败：以 JSON-RPC 错误响应（connect 抛出）
            const errLine = JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32000, message: 'handshake failed' },
            });
            for (const cb of outCbs) cb(errLine);
            return;
          }
          respond(msg.id, {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'fake', version: '1.0.0' },
          });
        } else if (msg.method === 'tools/list') {
          respond(msg.id, {
            tools: [
              {
                name: 'echo',
                description: '回声工具',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
              },
              {
                name: 'ping',
                description: '探活',
                inputSchema: { type: 'object', properties: {} },
                // 远端只读自述（P0 只读语义的远端来源；echo 不表态 → fail-closed 视为写）
                annotations: { readOnlyHint: true },
              },
            ],
          });
        } else if (msg.method === 'tools/call') {
          const name = (msg.params?.name as string) ?? '';
          respond(msg.id, { content: [{ type: 'text', text: `[${name}] ok` }], isError: false });
        } else {
          respond(msg.id, {});
        }
      }
    },
    onStdoutLine: (cb) => {
      outCbs.add(cb);
      return () => {
        outCbs.delete(cb);
      };
    },
    onExit: (cb) => {
      exitCbs.add(cb);
      return () => {
        exitCbs.delete(cb);
      };
    },
    kill: () => {
      killed.push(killed.length + 1);
      for (const cb of exitCbs) cb(0);
    },
  };
  return { proc, killed };
}

interface SpawnRecord {
  id: string;
  command: string;
  args: string[];
}

/** 注入 IO：记录 spawn 参数 + 返回受控 fake。 */
function makeIO(failConnect = false): { io: McpBridgeIO; spawns: SpawnRecord[] } {
  const spawns: SpawnRecord[] = [];
  const io: McpBridgeIO = {
    createProcIO: async (id, command, args) => {
      spawns.push({ id, command, args });
      return fakeMcpProcIO({ failConnect }).proc;
    },
    pluginDir: async (name) => `C:/plugins/${name}`,
  };
  return { io, spawns };
}

const STDIO_SERVER: McpServerDecl = {
  name: 'my-engine',
  transport: 'stdio',
  command: './bin/engine',
  args: ['--serve'],
};

/** 生产形态的桥装载：插件 fiber 内注册（loader 包装 apply 的同款——贡献与
 *  kill 挂插件 fiber 的 ctx.effect）。 */
async function bootBridge(
  servers: McpServerDecl[],
  io: McpBridgeIO,
): Promise<{ root: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  const fiber = await root.plugin({
    name: 'acme/tools',
    inject: ['tools'],
    async apply(ctx) {
      await registerMcpServerTools(ctx, 'acme/tools', servers, io);
    },
  });
  return { root, fiber };
}

describe('MCP 机器桥（S4-4 乙）：折算与解析域', () => {
  it('一个 server = 一条贡献；pluginToolRows 行 id = plugin/<插件名>/mcp/<server名>', async () => {
    const { io } = makeIO();
    const { root, fiber } = await bootBridge([STDIO_SERVER], io);
    const rows = pluginToolRows();
    expect(rows.map((r) => r.id)).toEqual(['plugin/acme/tools/mcp/my-engine']);
    // 甲合流：贡献行进组合解析域——patch 可寻址禁用该 server
    const base = factoryComposition();
    expect(base.tools.some((r) => r.id === 'plugin/acme/tools/mcp/my-engine')).toBe(true);
    const resolved = resolveRoster(base, [{ tools: [{ id: 'plugin/acme/tools/mcp/my-engine', disabled: true }] }]);
    expect(resolved.tools.some((r) => r.id === 'plugin/acme/tools/mcp/my-engine')).toBe(false);
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('惰性连接（lazy 缺省）：首装配经行协议拉远端工具整组产出', async () => {
    const { io, spawns } = makeIO();
    const { root, fiber } = await bootBridge([STDIO_SERVER], io);
    // 注册期不 spawn（lazy——装配才连）
    expect(spawns).toEqual([]);
    const rows = pluginToolRows();
    const row: BuiltinToolRow = first(rows);
    const tools: Tool[] = await row.factory({} as never);
    expect(tools.map((t) => t.name())).toEqual(['mcp__my-engine__echo', 'mcp__my-engine__ping']);
    // spawn 参数：bridgeId + 相对命令解析到插件目录
    expect(spawns).toHaveLength(1);
    const spawn = first(spawns);
    expect(spawn.id).toBe('mcp-bridge/acme/tools/my-engine');
    expect(spawn.command).toBe('C:/plugins/acme/tools/bin/engine');
    expect(spawn.args).toEqual(['--serve']);
    // 实例缓存：二次装配同实例；execute 走行协议
    const again = await row.factory({} as never);
    expect(first(again)).toBe(first(tools));
    const echo = first(tools);
    expect(await echo.execute({ text: 'hi' })).toBe('[echo] ok');
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('裸命令名（无分隔符）不解析——PATH 直达', async () => {
    const { io, spawns } = makeIO();
    const { root, fiber } = await bootBridge([{ name: 'node-srv', transport: 'stdio', command: 'node' }], io);
    const rows = pluginToolRows();
    await first(rows).factory({} as never);
    expect(first(spawns).command).toBe('node');
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  // P0（2026-09-13）：只读语义归真——旧实现两处硬编码 readOnly=true，写型 MCP 工具
  // 因此在 plan 模式被放行。判定真源 = agent/mcp/registry.resolveMcpToolReadOnly。
  it('只读语义（旧形态路）：远端 readOnlyHint 生效，未表态者 fail-closed 视为写', async () => {
    const { io } = makeIO();
    const { root, fiber } = await bootBridge([STDIO_SERVER], io);
    const tools: Tool[] = await first(pluginToolRows()).factory({} as never);
    const byName = new Map(tools.map((t) => [t.name(), t]));
    expect(byName.get('mcp__my-engine__ping')?.readOnly()).toBe(true); // annotations.readOnlyHint
    expect(byName.get('mcp__my-engine__echo')?.readOnly()).toBe(false); // 远端不表态 → 写
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('只读语义（旧形态路）：条目级 readOnly 声明覆盖远端注解（双向）', async () => {
    // 声明 true → 全组只读（echo 虽不表态也放行）；声明 false → 全组写（ping 的
    // readOnlyHint 被作者担保推翻——误声明是作者责任，见 types.ts 字段注）
    for (const [decl, expected] of [
      [true, true],
      [false, false],
    ] as const) {
      const { io } = makeIO();
      const { root, fiber } = await bootBridge([{ ...STDIO_SERVER, readOnly: decl }], io);
      const tools: Tool[] = await first(pluginToolRows()).factory({} as never);
      expect(tools.map((t) => t.readOnly())).toEqual([expected, expected]);
      await fiber.dispose();
      await root[Symbol.asyncDispose]?.();
    }
  });
});

describe('MCP 机器桥：failurePolicy', () => {
  it('startup-error：装载期急连接（spawn 在注册期发生）', async () => {
    const { io, spawns } = makeIO();
    const { root, fiber } = await bootBridge([{ ...STDIO_SERVER, failurePolicy: 'startup-error' }], io);
    expect(spawns).toHaveLength(1); // 注册期已连接
    // 急连接实例被 factory 复用（不二次 spawn）
    const tools = await first(pluginToolRows()).factory({} as never);
    expect(tools.map((t) => t.name())).toEqual(['mcp__my-engine__echo', 'mcp__my-engine__ping']);
    expect(spawns).toHaveLength(1);
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('startup-error 急连接失败 → registerMcpServerTools 抛出（loader 记 error）', async () => {
    const { io } = makeIO(true);
    await expect(bootBridge([{ ...STDIO_SERVER, failurePolicy: 'startup-error' }], io)).rejects.toThrow();
  });

  it('lazy 连接失败 = 空集 + warn（不炸装配）+ 空集不缓存（下次装配重试）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { io } = makeIO(true);
    const { root, fiber } = await bootBridge([STDIO_SERVER], io);
    const row = first(pluginToolRows());
    const firstOut = await row.factory({} as never);
    expect(firstOut).toEqual([]); // 空集——装配不炸
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockClear();
    // 空集未缓存：下次装配重跑 factory（重试语义）
    const secondOut = await row.factory({} as never);
    expect(secondOut).toEqual([]);
    expect(warnSpy).toHaveBeenCalled(); // 重试再次尝试连接（再次失败再次 warn）
    warnSpy.mockRestore();
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });
});

describe('MCP 机器桥：生命周期（kill 归插件 fiber disposer）', () => {
  it('fiber dispose → 贡献注销 + 进程 kill', async () => {
    const kills: number[] = [];
    const spawns: SpawnRecord[] = [];
    const io: McpBridgeIO = {
      createProcIO: async (id, command, args) => {
        spawns.push({ id, command, args });
        const fake = fakeMcpProcIO();
        const origKill = fake.proc.kill.bind(fake.proc);
        fake.proc.kill = () => {
          kills.push(kills.length + 1);
          origKill();
        };
        return fake.proc;
      },
      pluginDir: async (name) => `C:/plugins/${name}`,
    };
    const { root, fiber } = await bootBridge([STDIO_SERVER], io);
    // 连接（进程活跃）
    await first(pluginToolRows()).factory({} as never);
    expect(kills).toEqual([]);
    // 插件 fiber dispose → effect 链 → 贡献消失 + 进程被杀
    await fiber.dispose();
    expect(pluginToolRows()).toEqual([]);
    expect(kills.length).toBe(1);
    await root[Symbol.asyncDispose]?.();
  });
});
