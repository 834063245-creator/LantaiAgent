// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 用户级 MCP 配置解析测试（skills-mcp-production-plan Commit 5b）：
//   - parseUserMcpJson：数组/映射形态、坏 JSON、schema 失败条目进 skipped
//   - registerUserMcpServerTools：缺 mcp.json = 无操作；折算工具贡献

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { parseUserMcpJson, registerUserMcpServerTools } from '../src/plugins/user-mcp';

beforeEach(() => {
  const k = H.kernelFs!;
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.fail = {};
});

const STDIO_SERVER = {
  name: 'dataflow',
  transport: 'stdio',
  command: 'node',
  args: ['./server.cjs'],
};

describe('parseUserMcpJson', () => {
  it('数组形态：合法条目全收，非法条目进 skipped', () => {
    const skipped: Array<{ name: string; reason: string }> = [];
    const out = parseUserMcpJson(
      JSON.stringify({
        mcpServers: [
          STDIO_SERVER,
          { name: 'bad', transport: 'stdio' }, // 缺 command/url
          { name: 'http-ok', transport: 'http', url: 'https://mcp.example.com' },
        ],
      }),
      skipped,
    );
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.name)).toEqual(['dataflow', 'http-ok']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].name).toBe('bad');
  });

  it('映射形态 { mcpServers: { <name>: {...} } } → 数组（补 name）', () => {
    const skipped: Array<{ name: string; reason: string }> = [];
    const out = parseUserMcpJson(
      JSON.stringify({
        mcpServers: {
          dataflow: { transport: 'stdio', command: 'node', args: ['./server.cjs'] },
          http1: { transport: 'http', url: 'https://x.example.com' },
        },
      }),
      skipped,
    );
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.name).sort()).toEqual(['dataflow', 'http1']);
  });

  it('坏 JSON / 缺 mcpServers / 空 = 空数组（非错误）', () => {
    expect(parseUserMcpJson('not json', [])).toEqual([]);
    expect(parseUserMcpJson('{"other": 1}', [])).toEqual([]);
    expect(parseUserMcpJson('', [])).toEqual([]);
  });

  it('治理字段（restart/lifecycle）对 http 条目拒绝', () => {
    const skipped: Array<{ name: string; reason: string }> = [];
    const out = parseUserMcpJson(
      JSON.stringify({
        mcpServers: [{ name: 'x', transport: 'http', url: 'https://x.com', restart: 'on-crash' }],
      }),
      skipped,
    );
    expect(out).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });
});

describe('registerUserMcpServerTools', () => {
  it('缺 ~/.lantai/mcp.json = 无操作（非错误）', async () => {
    // kernelGlobalMemoryDir mock 返回 ~/.lantai/global_memory → 用户根 ~/.lantai；
    // 该目录无 mcp.json → kernelReadFile 抛 ENOENT → 空报告
    const report = await registerUserMcpServerTools({} as never);
    expect(report.servers).toBe(0);
    expect(report.file).toBe('~/.lantai/mcp.json');
  });

  it('mcp.json 存在 → 折算工具贡献（行 id plugin/user/mcp/<server>）', async () => {
    H.kernelFs!.fs.setFile('~/.lantai/mcp.json', JSON.stringify({ mcpServers: [STDIO_SERVER] }));
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    // pluginDir 锚到 ~/.lantai（用户级相对命令解析）；createProcIO fake 不真 spawn
    const fakeIo = {
      createProcIO: vi.fn(async () => {
        throw new Error('not spawned in unit test');
      }),
      pluginDir: vi.fn(async () => '~/.lantai'),
    };
    const report = await registerUserMcpServerTools(root, fakeIo as never);
    expect(report.servers).toBe(1);
    expect(report.file).toBe('~/.lantai/mcp.json');
    // 折算进组合工具行：plugin/user/mcp/dataflow 一条贡献
    const rows = pluginToolRows(root);
    expect(rows.some((r: { id: string }) => r.id === 'plugin/user/mcp/dataflow')).toBe(true);
  });
});
