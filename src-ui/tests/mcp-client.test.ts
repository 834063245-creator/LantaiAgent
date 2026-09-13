// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MCP client 测试 — 用内存回环传输连一个 fake MCP server，验证握手/工具列表/调用/错误。

import { describe, expect, it } from 'vitest';
import { McpClient, publicToolName } from '../src/agent/mcp/client';
import { mcpClientTool, registerMcpTools, resolveMcpToolReadOnly } from '../src/agent/mcp/registry';
import { createLoopbackTransport } from '../src/agent/mcp/transport';
import { planGateCheck } from '../src/agent/plan/plan-registry';
import { PlanStateManager } from '../src/agent/plan/plan-state';
import { ToolRegistry } from '../src/agent/tool';

/** 构造一个 fake MCP server 的响应处理器（回环，同步返回）。 */
function makeFakeServer() {
  const handler = (line: string): string[] => {
    const req = JSON.parse(line);
    const id = req.id;
    if (id === undefined) return []; // notification
    const method = req.method;
    if (method === 'initialize') {
      return [
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1.0' },
          },
        }),
      ];
    }
    if (method === 'tools/list') {
      return [
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'echo back',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
              },
              { name: 'boom', description: 'always errors', inputSchema: { type: 'object', properties: {} } },
            ],
          },
        }),
      ];
    }
    if (method === 'tools/call') {
      const name = req.params.name;
      if (name === 'echo') {
        const text = req.params.arguments?.text ?? '';
        return [JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo:${text}` }] } })];
      }
      if (name === 'boom') {
        return [JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], isError: true } })];
      }
      return [JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } })];
    }
    return [JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method' } })];
  };
  return { handler };
}

describe('McpClient', () => {
  it('publicToolName prefixes with mcp__server__', () => {
    expect(publicToolName('repo', 'get_file')).toBe('mcp__repo__get_file');
  });

  it('publicToolName 归一化追加哈希防塌缩（a.b 与 a_b 不同名）', () => {
    // 非法字符触发归一 → 追加 FNV-1a 哈希（不同原串即使归一同形也保持不同）
    const dotted = publicToolName('repo', 'a.b');
    const underscored = publicToolName('repo', 'a_b');
    expect(dotted.startsWith('mcp__repo__a_b')).toBe(true);
    expect(underscored).toBe('mcp__repo__a_b'); // 纯合法名不追加哈希
    expect(dotted).not.toBe(underscored); // 防塌缩：不同身份不同名
    // 哈希稳定可复现
    expect(publicToolName('repo', 'a.b')).toBe(dotted);
    // 纯合法名（含连字符/下划线）原样返回——既有兼容面零变化
    expect(publicToolName('repo', 'get-file')).toBe('mcp__repo__get-file');
  });

  it('connects, lists tools, and calls a tool via loopback transport', async () => {
    const fake = makeFakeServer();
    const client = new McpClient({
      serverName: 'fake',
      transport: createLoopbackTransport(fake.handler),
    });
    await client.connect();
    expect(client.isConnected).toBe(true);
    expect(client.listRemoteTools().map((t) => t.name)).toEqual(['echo', 'boom']);

    const res = await client.callTool('echo', { text: 'hi' });
    expect(res.text).toBe('echo:hi');
    expect(res.isError).toBe(false);

    const err = await client.callTool('boom', {});
    expect(err.isError).toBe(true);

    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('registers remote tools into a ToolRegistry with qualified names', async () => {
    const fake = makeFakeServer();
    const client = new McpClient({
      serverName: 'repo',
      transport: createLoopbackTransport(fake.handler),
    });
    await client.connect();
    const registry = new ToolRegistry();
    const names = registerMcpTools(client, registry);
    expect(names).toContain('mcp__repo__echo');
    expect(registry.get('mcp__repo__echo')).toBeDefined();

    const tool = registry.get('mcp__repo__echo')!;
    // P0（2026-09-13）规格变更：远端未声明 annotations → fail-closed 视为**写**
    // （旧实现硬编码 true，写型 MCP 工具因此在 plan 模式被放行）
    expect(tool.readOnly()).toBe(false);
    const out = await tool.execute({ text: 'yo' });
    expect(out).toContain('echo:yo');
  });

  it('calls a wrapped tool with signal support', async () => {
    const fake = makeFakeServer();
    const client = new McpClient({
      serverName: 'repo',
      transport: createLoopbackTransport(fake.handler),
    });
    await client.connect();
    const tool = mcpClientTool(client, client.listRemoteTools()[0]);
    const ac = new AbortController();
    const out = await tool.execute({ text: 'x' }, undefined, ac.signal);
    expect(out).toContain('echo:x');
  });

  // ── 只读语义（P0，2026-09-13）：条目声明 > 远端 readOnlyHint > 缺省 false ──

  it('resolveMcpToolReadOnly：优先级链与 fail-closed 缺省', () => {
    expect(resolveMcpToolReadOnly({})).toBe(false); // 什么都不表态 = 写
    expect(resolveMcpToolReadOnly({ annotations: {} })).toBe(false);
    expect(resolveMcpToolReadOnly({ annotations: { readOnlyHint: false } })).toBe(false);
    expect(resolveMcpToolReadOnly({ annotations: { readOnlyHint: true } })).toBe(true);
    // 条目级声明覆盖远端注解（双向）
    expect(resolveMcpToolReadOnly({ annotations: { readOnlyHint: false } }, true)).toBe(true);
    expect(resolveMcpToolReadOnly({ annotations: { readOnlyHint: true } }, false)).toBe(false);
    // undefined 才是「不表态」——false 是显式担保写
    expect(resolveMcpToolReadOnly({ annotations: { readOnlyHint: true } }, undefined)).toBe(true);
  });

  it('P0 反向判据：未声明只读的 MCP 工具在 plan 模式被 planGateCheck 拦截', async () => {
    const fake = makeFakeServer();
    const client = new McpClient({
      serverName: 'office',
      transport: createLoopbackTransport(fake.handler),
    });
    await client.connect();
    // 远端 fake 的 echo/boom 均无 annotations（OfficeCLI 的 MCP 工具正是这种形态）
    const tool = mcpClientTool(client, client.listRemoteTools()[0]);
    const ps = new PlanStateManager();
    ps.enter('/proj');
    // 旧实现下此处为 null（放行写动作）——本判据钉死修复后的行为
    expect(planGateCheck(ps, tool.name(), {}, tool)).toContain('[已拦截]');
    // 显式担保只读的 server 工具仍放行（不误伤）
    const roTool = mcpClientTool(client, { ...client.listRemoteTools()[0], annotations: { readOnlyHint: true } });
    expect(planGateCheck(ps, roTool.name(), {}, roTool)).toBeNull();
  });
});
