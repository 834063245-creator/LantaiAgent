#!/usr/bin/env node
'use strict';
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// dataflow-mcp 外部 MCP server（平台化 P4 · D1 端到端示例）——
// 零依赖 Node 进程，经 stdio 说 MCP JSON-RPC（协议面与兰台 McpClient 对齐：
// initialize / notifications/initialized / tools/list / tools/call）。
//
// 能力 = 第一方 dataflow 查询的进程外重表达：直读 <root>/.lantai/dataflow/
// 的 JSON 追踪文件（格式与 src-tauri app/services/dataflow_service.rs 逐字段
// 对齐：traceId/query/content/exploreResult/dataflowResult/createdAt），
// 语义与 dataflow_query 一致：traceId → 完整记录；list → 摘要列表（最新优先，
// ≤100 条）。root 取 DATAFLOW_ROOT 环境变量（缺省 = 进程 cwd）。
//
// 这是「MCP 是能力加面路径之一」的活例子：同一能力既可以走进程内 seam
// （ctx.graph / dataflow RPC），也可以走外部 MCP server（本文件）——D1 收口。

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = process.env.DATAFLOW_ROOT || process.cwd();
const DATAFLOW_DIR = path.join(ROOT, '.lantai', 'dataflow');

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 与 Rust sanitize_path_id 同款围栏：trace id 只允许 [_a-zA-Z0-9-]，
 *  防路径逃逸（.. / 分隔符 / 盘符）。 */
function sanitizeTraceId(tid) {
  if (typeof tid !== 'string' || tid === '' || !/^[_a-zA-Z0-9-]+$/.test(tid) || tid.length > 128) {
    throw new Error(`非法 trace_id（只允许 [_a-zA-Z0-9-]，≤128 字符）: ${String(tid)}`);
  }
  return tid;
}

function readTraces() {
  if (!fs.existsSync(DATAFLOW_DIR)) return [];
  return fs
    .readdirSync(DATAFLOW_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(DATAFLOW_DIR, f);
      try {
        return { path: full, mtime: fs.statSync(full).mtimeMs, record: JSON.parse(fs.readFileSync(full, 'utf8')) };
      } catch {
        return null; // 毒化条目跳过（读取容忍——INVARIANTS #11.2 同款纪律）
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

function query(args) {
  const list = args.list === true;
  const traceId = args.traceId;
  if (traceId !== undefined) {
    const tid = sanitizeTraceId(traceId);
    const full = path.join(DATAFLOW_DIR, `${tid}.json`);
    if (!fs.existsSync(full)) {
      return { isError: true, text: `trace 不存在: ${tid}` };
    }
    return { text: fs.readFileSync(full, 'utf8') };
  }
  const traces = readTraces();
  if (list) {
    return {
      text: JSON.stringify({
        traces: traces.slice(0, 100).map(({ record }) => ({
          traceId: typeof record.traceId === 'string' ? record.traceId : '',
          query: typeof record.query === 'string' ? record.query : '',
          createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
          hasContent: typeof record.content === 'string' ? record.content.length > 0 : false,
        })),
      }),
    };
  }
  return { text: JSON.stringify({ traces: traces.slice(0, 50).map(({ record }) => record) }) };
}

const TOOLS = [
  {
    name: 'dataflow_query',
    description:
      '查询工作区 .lantai/dataflow/ 下的数据流追踪记录（进程外 MCP 重表达）：traceId → 完整记录 JSON；list:true → 摘要列表（最新优先，≤100 条）；都不给 → 完整内容列表（遗留模式，≤50 条）。',
    inputSchema: {
      type: 'object',
      properties: {
        traceId: { type: 'string', description: '精确 trace id（df_ 前缀形态）' },
        list: { type: 'boolean', description: 'true = 摘要列表' },
      },
    },
  },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (req.id === undefined) return; // 通知不回
  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'dataflow-mcp', version: '1.0.0' },
          instructions: 'dataflow 查询的进程外重表达（DATAFLOW_ROOT/.lantai/dataflow）',
        },
      });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
      break;
    case 'tools/call': {
      if (req.params?.name !== 'dataflow_query') {
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: `未知工具: ${String(req.params?.name)}` }], isError: true },
        });
        break;
      }
      try {
        const out = query(req.params?.arguments || {});
        send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: out.text }], isError: !!out.isError } });
      } catch (e) {
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true },
        });
      }
      break;
    }
    default:
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${String(req.method)}` } });
  }
});
