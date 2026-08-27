// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P4-C5 端到端：外部 MCP server 承载真实能力（平台化 Phase 4 · D1 收口）。
// 链路 = examples/plugins/dataflow-mcp 的真实 node 子进程 + 真实 stdio 传输
// （createNodeStdioProc——与生产 Rust protocol_bridge 同语义的进程 IO）+
// loader 同款挂接路径（registerMcpServerTools）→ ctx.tools 贡献 → 工具工厂
// → McpClient → server.cjs → 直读 .lantai/dataflow/ 追踪文件。
// 「MCP 是能力加面路径之一（不是唯一）」的活例子——同一能力既可走进程内
// seam（dataflow RPC），也可走外部 MCP server（本例）。

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeStdioProc } from '../src/agent/mcp/transport';
import { activeToolContributions, compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { type McpBridgeIO, registerMcpServerTools } from '../src/plugins/mcp-bridge';
import type { McpServerDecl } from '../src/plugins/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = path.resolve(HERE, '..', '..', 'examples', 'plugins', 'dataflow-mcp');
const MANIFEST = JSON.parse(
  await import('node:fs').then((m) => m.readFileSync(path.join(EXAMPLE_DIR, 'manifest.json'), 'utf8')),
);

let workspace: string;

beforeAll(() => {
  // 临时工作区：.lantai/dataflow/ 两条追踪（新→旧排序断言用）
  workspace = mkdtempSync(path.join(os.tmpdir(), 'lantai-dataflow-mcp-'));
  const dir = path.join(workspace, '.lantai', 'dataflow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'df_20260827T010101111.json'),
    JSON.stringify({
      traceId: 'df_20260827T010101111',
      query: '校验 fs 域引用链',
      content: 'trace-content-older',
      exploreResult: null,
      dataflowResult: null,
      createdAt: '2026-08-27T01:01:01.111Z',
    }),
  );
  writeFileSync(
    path.join(dir, 'df_20260827T020202222.json'),
    JSON.stringify({
      traceId: 'df_20260827T020202222',
      query: '分析 rope 数据结构',
      content: 'trace-content-newer',
      exploreResult: null,
      dataflowResult: null,
      createdAt: '2026-08-27T02:02:02.222Z',
    }),
  );
  // mtime 粒度粗（同毫秒写入平手）——显式定序（新 > 旧）
  utimesSync(path.join(dir, 'df_20260827T010101111.json'), new Date(1_000), new Date(1_000));
  utimesSync(path.join(dir, 'df_20260827T020202222.json'), new Date(2_000), new Date(2_000));
  // server.cjs 经 DATAFLOW_ROOT 定位工作区（spawn 继承本进程 env）
  process.env.DATAFLOW_ROOT = workspace;
});

afterAll(() => {
  delete process.env.DATAFLOW_ROOT;
});

/** 真实进程 IO 的桥宿主（createNodeStdioProc = 生产 protocol_bridge 同语义）。 */
const realProcBridgeIO: McpBridgeIO = {
  createProcIO: (_bridgeId, command, args) => Promise.resolve(createNodeStdioProc(command, args)),
  pluginDir: () => Promise.resolve(EXAMPLE_DIR),
};

describe('P4-C5：外部 MCP server 承载真实能力（dataflow 查询端到端）', () => {
  it('manifest 声明 → 机器桥挂接 → 工具贡献 → 真实进程应答', async () => {
    expect(MANIFEST.mcpServers).toHaveLength(1);
    const decl: McpServerDecl = MANIFEST.mcpServers[0];
    expect(decl.transport).toBe('stdio');
    expect(decl.failurePolicy).toBe('startup-error');

    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    // loader 装载 manifest.mcpServers 的同款调用路径（startup-error 急连接
    // ——真实 node 进程在此刻起起）
    await registerMcpServerTools(root as never, MANIFEST.name, [decl], realProcBridgeIO);
    const contrib = activeToolContributions().find((c) => c.id === `${MANIFEST.name}/mcp/${decl.name}`);
    expect(contrib).toBeDefined();

    // 工具工厂（首装配建连）→ 远端工具面
    const tools = (await contrib!.factory()) as Array<{
      name: () => string;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }>;
    expect(tools.map((t) => t.name())).toContain('mcp__dataflow__dataflow_query');
    const tool = tools.find((t) => t.name() === 'mcp__dataflow__dataflow_query')!;

    // ① list 模式 → 摘要列表（最新优先——server 直读磁盘文件）
    const listed = JSON.parse(await tool.execute({ list: true })) as {
      traces: Array<{ traceId: string; query: string; hasContent: boolean }>;
    };
    expect(listed.traces.map((t) => t.traceId)).toEqual(['df_20260827T020202222', 'df_20260827T010101111']);
    expect(listed.traces[0]).toMatchObject({ query: '分析 rope 数据结构', hasContent: true });

    // ② 精确 trace → 完整记录（原样文件内容——与 Rust dataflow_query 同语义）
    const full = await tool.execute({ traceId: 'df_20260827T010101111' });
    expect(full).toContain('trace-content-older');
    expect(full).toContain('"query":"校验 fs 域引用链"');

    // ③ 非法 trace id → server 侧围栏拒绝（isError 面）
    const bad = await tool.execute({ traceId: '../escape' });
    expect(bad).toContain('非法 trace_id');
  });
});
