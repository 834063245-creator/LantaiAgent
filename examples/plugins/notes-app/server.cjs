#!/usr/bin/env node
'use strict';
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// notes-app 后端——零依赖 Node 进程，两副面孔（app shell 范本 · S5）：
//
//   1. 对宿主说 MCP（stdio）：数据四工具（notes_list / notes_create /
//      notes_delete / notes_export）随 tools/list 动态进兰台工具注册表
//      （动态名面族——一行贡献承载整族，P4 ①c 纪律天然满足）；就绪 =
//      initialize 握手（受治进程治理 S2：lazy 档首装配/调用/开窗拉起，空闲
//      回收，再拉再起）。
//   2. 对自己的窗说极简 HTTP API（127.0.0.1，CORS *——窗是 sandbox iframe
//      的 opaque origin）：GET/POST/DELETE /notes——宿主不掺和（app 内部的
//      事，决策 8）。
//
// 数据权威单点 = 本进程：notes.json 独占读写（窗与工具都经它，不并发打架
// ——插件作者的设计责任，本范本示范单写者）。数据地盘 = spawn env
// LANTAI_PLUGIN_DATA_DIR（S2 注入；独立裸跑时回退插件目录下 .data/）。
// HTTP 端口每次启动动态取（port 0），落 port.json 进数据地盘——窗经宿主
// 桥 fs 读它找到本进程（桥 fs 是窗能拿到宿主能力的白名单通道）。
//
// 异步导出（件 D）：notes_export 无 taskId → 提交即回卡片 + 记
// {taskId, progressToken}，1.2s 后写导出文件并发完成通知
// lantai/deferred（params.progressToken 回带调用期 token——MCP 请求↔通知
// 关联的标准锚点）→ 桥翻译成后台唤醒 + minimal 定位键；凭 taskId 再调
// notes_export 取结果（内容按需取，不进唤醒体）。

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');

const DATA_DIR = process.env.LANTAI_PLUGIN_DATA_DIR || path.join(__dirname, '.data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const PORT_FILE = path.join(DATA_DIR, 'port.json');

// ── 数据存取（单写者 = 本进程） ──

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readNotes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // 毒化/缺文件 = 空集起步（INVARIANTS #11.2 毒化容忍同款）
  }
}

function writeNotes(notes) {
  ensureDataDir();
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), 'utf8');
}

function newId() {
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── 异步导出任务（件 D） ──

const pendingExports = new Map(); // taskId → { progressToken }

function startExport(progressToken) {
  const taskId = `export-${Date.now().toString(36)}`;
  pendingExports.set(taskId, { progressToken });
  setTimeout(() => {
    const snapshot = JSON.stringify(readNotes(), null, 2);
    ensureDataDir();
    fs.writeFileSync(path.join(DATA_DIR, `notes-export-${taskId}.json`), snapshot, 'utf8');
    const pending = pendingExports.get(taskId);
    pendingExports.delete(taskId);
    // 完成通知（S4 MCP 路）：progressToken 回带调用期 token——桥翻译成唤醒
    if (pending && pending.progressToken !== undefined) {
      send({
        jsonrpc: '2.0',
        method: 'lantai/deferred',
        params: {
          progressToken: pending.progressToken,
          taskId,
          status: 'completed',
          message: '便签导出完成——凭 taskId 再调 notes_export 取文件内容',
        },
      });
    }
  }, 1200);
  return taskId;
}

function exportResult(taskId) {
  const file = path.join(DATA_DIR, `notes-export-${taskId}.json`);
  if (pendingExports.has(taskId)) {
    return { text: `导出进行中（taskId: ${taskId}）——完成会有唤醒通知，届时再取。` };
  }
  if (!fs.existsSync(file)) {
    return { isError: true, text: `未知 taskId: ${taskId}（可能已完成并被清理，或从未提交）` };
  }
  return { text: fs.readFileSync(file, 'utf8') };
}

// ── MCP 面（stdio） ──

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const TOOLS = [
  {
    name: 'notes_list',
    description: '列出全部便签（MCP 路：实现住在 server 进程里，随 tools/list 进注册表）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'notes_create',
    description: '新建一条便签（text 必填）。数据写进插件数据地盘 notes.json——窗与工具都经本进程，不并发打架。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '便签内容' } },
      required: ['text'],
    },
  },
  {
    name: 'notes_delete',
    description: '按 id 删除一条便签。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '便签 id（notes_list 里的 n- 前缀形态）' } },
      required: ['id'],
    },
  },
  {
    name: 'notes_export',
    description:
      '导出全部便签（异步长任务示例）：不带 taskId = 提交导出任务，立即返回卡片（完成后后台唤醒，minimal 定位键 {status, taskId, sessionId}）；带 taskId = 按需取该任务的导出内容（JSON 全文）。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '导出任务 id（取结果时传）' } },
    },
  },
];

function callTool(name, args) {
  switch (name) {
    case 'notes_list':
      return { text: JSON.stringify({ notes: readNotes() }, null, 2) };
    case 'notes_create': {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (text === '') return { isError: true, text: 'text 不能为空' };
      const notes = readNotes();
      const note = { id: newId(), text, createdAt: new Date().toISOString() };
      notes.push(note);
      writeNotes(notes);
      return { text: `便签已创建（id: ${note.id}）——窗内与 notes_list 可见。` };
    }
    case 'notes_delete': {
      const id = typeof args.id === 'string' ? args.id : '';
      const notes = readNotes();
      const next = notes.filter((n) => n.id !== id);
      if (next.length === notes.length) return { isError: true, text: `便签不存在: ${id}` };
      writeNotes(next);
      return { text: `便签已删除（id: ${id}）。` };
    }
    case 'notes_export': {
      if (typeof args.taskId === 'string' && args.taskId !== '') {
        return exportResult(args.taskId);
      }
      const taskId = startExport(args._progressToken);
      return { text: `导出任务已提交（taskId: ${taskId}）——完成后将收到唤醒通知，凭 taskId 再调本工具取结果。` };
    }
    default:
      return { isError: true, text: `未知工具: ${name}` };
  }
}

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
          serverInfo: { name: 'notes-app', version: '1.0.0' },
          instructions: '便签范本后端：数据四工具 + 异步导出（完成通知 lantai/deferred）',
        },
      });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
      break;
    case 'tools/call': {
      // 调用期 progressToken（_meta）透传给工具——异步导出完成后原样回带
      const args = { ...(req.params?.arguments || {}) };
      if (req.params?._meta?.progressToken !== undefined) {
        args._progressToken = req.params._meta.progressToken;
      }
      try {
        const out = callTool(String(req.params?.name), args);
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: out.text }], isError: !!out.isError },
        });
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

// ── HTTP 面（窗 ↔ 本进程——app 内部的事，宿主不掺和） ──

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*', // 窗是 sandbox iframe 的 opaque origin
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/notes') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ notes: readNotes() }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/notes') {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (trimmed === '') {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'text 不能为空' }));
          return;
        }
        const notes = readNotes();
        const note = { id: newId(), text: trimmed, createdAt: new Date().toISOString() };
        notes.push(note);
        writeNotes(notes);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ note }));
      } catch {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'bad json' }));
      }
    });
    return;
  }
  const delMatch = /^\/notes\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && delMatch) {
    const id = delMatch[1];
    const notes = readNotes();
    const next = notes.filter((n) => n.id !== id);
    if (next.length === notes.length) {
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `便签不存在: ${id}` }));
      return;
    }
    writeNotes(next);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  ensureDataDir();
  // 端口落 port.json 进数据地盘——窗经宿主桥 fs 读它找到本进程的 HTTP 面
  fs.writeFileSync(PORT_FILE, JSON.stringify({ port, startedAt: new Date().toISOString() }), 'utf8');
  send({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', data: `notes-app http api on 127.0.0.1:${port} (port.json written)` },
  });
});
