// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MCP 管理页数据层测试（skills-mcp-production-plan Commit 6c）：
//   - mcp.json 读 → 列表（parseUserMcpJson）
//   - 写回形状：{ mcpServers: { <name>: {...} } } 映射形态（对齐 .mcp.json.example）
//   - 删除 = 过滤后写回

// 页面组件本身是 React UI——这里测其数据操作核心（读写 mcp.json 的形状）。
// kernel fs mock 站到 rpc-contract 具名 helper。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import { parseUserMcpJson } from '../src/plugins/user-mcp';
import { kernelReadFile, kernelWriteFile } from '../src/rpc-contract';

const MCP_PATH = '~/.lantai/mcp.json';

beforeEach(() => {
  const k = H.kernelFs!;
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.fail = {};
});

describe('McpPage 数据层（用户级 mcp.json 读写）', () => {
  it('无 mcp.json = 空列表（首次配置，非错误）', async () => {
    try {
      await kernelReadFile(MCP_PATH);
      expect(true).toBe(false); // 不应读到
    } catch {
      // ENOENT——页面 catch 后置空列表
      expect(true).toBe(true);
    }
  });

  it('读 mcp.json → parseUserMcpJson 产出 server 列表', async () => {
    H.kernelFs!.fs.setFile(
      MCP_PATH,
      JSON.stringify({
        mcpServers: {
          dataflow: { transport: 'stdio', command: 'node', args: ['./server.cjs'] },
          docs: { transport: 'http', url: 'https://docs.example.com/mcp' },
        },
      }),
    );
    const raw = await kernelReadFile(MCP_PATH);
    const servers = parseUserMcpJson(raw, []);
    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.name).sort()).toEqual(['dataflow', 'docs']);
    expect(servers.find((s) => s.name === 'dataflow')?.transport).toBe('stdio');
  });

  it('新增 server = 读 → 追加 → 映射形态写回（对齐 .mcp.json.example）', async () => {
    H.kernelFs!.fs.setFile(
      MCP_PATH,
      JSON.stringify({ mcpServers: { old: { transport: 'http', url: 'https://a.com' } } }),
    );
    const raw0 = await kernelReadFile(MCP_PATH);
    const servers = parseUserMcpJson(raw0, []);
    servers.push({
      name: 'new',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp'],
    } as never);
    const map = Object.fromEntries(
      servers.map((s) => {
        const { name: sn, ...rest } = s;
        return [sn, rest];
      }),
    );
    await kernelWriteFile(MCP_PATH, JSON.stringify({ mcpServers: map }, null, 2) + '\n');
    // 写回的文件可再解析出两 server（round-trip）
    const raw1 = await kernelReadFile(MCP_PATH);
    const after = parseUserMcpJson(raw1, []);
    expect(after).toHaveLength(2);
    expect(after.some((s) => s.name === 'new')).toBe(true);
    // 写回形状 = 映射形态（顶层 mcpServers 是对象非数组）
    const parsed = JSON.parse(raw1) as { mcpServers: unknown };
    expect(Array.isArray(parsed.mcpServers)).toBe(false);
    expect(Object.keys(parsed.mcpServers as Record<string, unknown>).sort()).toEqual(['new', 'old']);
  });

  it('删除 server = 过滤后写回（其余保留）', async () => {
    H.kernelFs!.fs.setFile(
      MCP_PATH,
      JSON.stringify({
        mcpServers: {
          a: { transport: 'http', url: 'https://a.com' },
          b: { transport: 'stdio', command: 'node' },
        },
      }),
    );
    const raw0 = await kernelReadFile(MCP_PATH);
    const servers = parseUserMcpJson(raw0, []).filter((s) => s.name !== 'a');
    const map = Object.fromEntries(
      servers.map((s) => {
        const { name: sn, ...rest } = s;
        return [sn, rest];
      }),
    );
    await kernelWriteFile(MCP_PATH, JSON.stringify({ mcpServers: map }, null, 2) + '\n');
    const raw1 = await kernelReadFile(MCP_PATH);
    const after = parseUserMcpJson(raw1, []);
    expect(after.map((s) => s.name)).toEqual(['b']);
  });
});
