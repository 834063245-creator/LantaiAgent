// @vitest-environment node
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MCP interop E2E — TS MCP client 连接真实 Rust 引擎 MCP server（engine.exe serve，stdio）。
// 验证"我们自己的 MCP client 能连我们自己补全的 MCP server"，即设计文档 §3.3 验收闭环：
//   engine serve → TS client 握手 → tools/list 可见面 → 域调用 / 原名调用两条路。
// 前置：engine crate 已 cargo build（workspace 根 target/debug/，或 engine/target/debug/；
//      可用 HOLOGRAM_ENGINE_EXE 指到别处）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpClient } from '../src/agent/mcp/client';
import { createNodeStdioProc } from '../src/agent/mcp/transport';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.HOLOGRAM_ENGINE_EXE,
  path.resolve(here, '..', '..', 'target', 'debug', 'hologram-engine.exe'),
  path.resolve(here, '..', '..', 'engine', 'target', 'debug', 'hologram-engine.exe'),
].filter((p): p is string => typeof p === 'string' && p.length > 0);
const engineExe = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];

const hasEngine = () => fs.existsSync(engineExe);

/** 引擎契约 v6 的域面（真源 engine/src/tools/mod.rs DOMAIN_SPECS）。 */
const DOMAINS = ['graph', 'analysis', 'lsp', 'ops'];
const STANDALONE_WRITES = ['analyze_project', 'import_scip', 'rename_symbol'];

describe('MCP interop with real Rust engine (.exe serve)', () => {
  const run = async (fn: (client: McpClient) => Promise<void>, env?: Record<string, string>) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env ?? {})) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const proc = createNodeStdioProc(engineExe, ['serve']);
    const client = new McpClient({ serverName: 'hologram', procIO: proc });
    try {
      await client.connect();
      await fn(client);
    } finally {
      await client.disconnect();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('spawns engine.exe serve and completes the MCP handshake', { skip: !hasEngine() }, async () => {
    await run(async (client) => {
      expect(client.isConnected).toBe(true);
    });
  });

  it('tools/list 返回契约 v5 折叠面（4 域 + 3 写工具，原名不单列）', { skip: !hasEngine() }, async () => {
    await run(async (client) => {
      const tools = client.listRemoteTools().map((t) => t.name);
      expect(tools).toEqual([...DOMAINS, ...STANDALONE_WRITES]);
      // 折叠掉的只读原名不再出现在可见面
      expect(tools).not.toContain('get_neighbors');
      expect(tools).not.toContain('list_flows');
    });
  });

  it('tools/list 的域工具带 action 枚举与标准只读注解', { skip: !hasEngine() }, async () => {
    await run(async (client) => {
      const graph = client.listRemoteTools().find((t) => t.name === 'graph');
      expect(graph).toBeDefined();
      const props = graph?.inputSchema?.properties as Record<string, { enum?: string[] }> | undefined;
      expect(Array.isArray(props?.action?.enum)).toBe(true);
      expect(props?.action?.enum?.length).toBeGreaterThanOrEqual(10);
      // 宿主只读语义读 annotations.readOnlyHint（旧的非标准顶层 readOnly 已随 v5 删除）
      expect(graph?.annotations?.readOnlyHint).toBe(true);
      const analyze = client.listRemoteTools().find((t) => t.name === 'analyze_project');
      expect(analyze?.annotations?.readOnlyHint).toBe(false);
    });
  });

  it('域调用与原名调用等价（graph/analysis 两条路）', { skip: !hasEngine() }, async () => {
    await run(async (client) => {
      const routed = await client.callTool('analysis', { action: 'cycles' });
      const raw = await client.callTool('detect_cycles', {});
      expect(routed.isError).toBe(false);
      expect(routed.text).toBe(raw.text);
      expect(routed.text).not.toContain('Tool not found');
    });
  });

  it('折叠不改可达性：被折叠的只读原名仍可 tools/call 直达', { skip: !hasEngine() }, async () => {
    await run(async (client) => {
      const res = await client.callTool('list_flows', {});
      expect(typeof res.text).toBe('string');
      expect(res.text.length).toBeGreaterThan(0);
    });
  });

  it('未知 action 走可见降级（不是 JSON-RPC 错误、不是静默）', { skip: !hasEngine() }, async () => {
    await run(async (client) => {
      const res = await client.callTool('graph', { action: 'nope' });
      expect(res.isError).toBe(false);
      expect(res.text).toContain('unknown graph action');
      expect(res.text).toContain('valid actions');
    });
  });

  it('域自带的 help 动作取回完整说明书（折叠无损）', { skip: !hasEngine() }, async () => {
    await run(async (client) => {
      const res = await client.callTool('analysis', { action: 'help' });
      expect(res.isError).toBe(false);
      const payload = JSON.parse(res.text) as {
        domain: string;
        actions: Array<{ action: string; tool: string; description: string; required: unknown[] }>;
      };
      expect(payload.domain).toBe('analysis');
      expect(payload.actions.length).toBe(15);
      const preflight = payload.actions.find((a) => a.action === 'preflight');
      // 完整说明书（不是迷你 hint）——原文里独有的措辞必须在
      expect(preflight?.description).toContain('Change-impact rehearsal');
      expect(preflight?.required).toContain('path');
    });
  });

  it('退役开关不再影响可见面（设了也还是折叠面）', { skip: !hasEngine() }, async () => {
    await run(
      async (client) => {
        const tools = client.listRemoteTools().map((t) => t.name);
        expect(tools).toEqual([...DOMAINS, ...STANDALONE_WRITES]);
      },
      { HOLOGRAM_MCP_TOOLS: '*' },
    );
  });
});
