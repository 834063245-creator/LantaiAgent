// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! MCP client — 让兰台的 Agent 调用外部 MCP server 的工具。
//!
//! 职责：
//! - 连接（initialize → notifications/initialized → tools/list）
//! - 把远端 tools/call 包装成本地可调用入口（`mcp__<server>__<name>` 命名）
//! - 进度转发（notifications/progress → onProgress）与取消（notifications/cancelled）
//!
//! 不依赖 Tauri/UI；传输由外部注入，测试可在内存回环上跑通。

import { type Disposer, once } from '../lifecycle';
import {
  createNodeStdioProc,
  createStdioTransport,
  createStreamableHttpTransport,
  type McpTransport,
  type ProcIO,
} from './transport';

/** 远端工具 schema（MCP tools/list 项）。 */
export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP client 结果（tools/call 返回）。 */
export interface McpResult {
  /** 文本内容 — content 里所有 text 块拼接。 */
  text: string;
  /** 原始 content 数组。 */
  content: unknown[];
  /** 是否错误（isError 标记）。 */
  isError: boolean;
}

const empty: McpToolSchema[] = [];

/** 配置：serverName 做本地命名空间，transport 二选一。 */
export interface McpClientConfig {
  /** 本地命名空间，外部工具名带 `mcp__<serverName>__` 前缀。 */
  serverName: string;
  /** 启动失败策略。 */
  failurePolicy?: 'startup-error' | 'lazy';
  /** stdio 子进程（二选一）。 */
  command?: string;
  args?: string[];
  /** 显式提供 ProcIO（非 Node 宿主 / 测试）；否则用 command spawn。 */
  procIO?: ProcIO;
  /** streamable-http 端点（二选一）。 */
  url?: string;
  headers?: Record<string, string>;
  /** 测试用：直接注入回环传输。 */
  transport?: McpTransport;
}

interface PendingReq {
  resolve: (msg: JsonRpcMessage) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  result?: unknown;
  error?: { code: number; message?: string };
  params?: Record<string, unknown>;
};

/** FNV-1a 32 位稳定哈希（hex 8）——工具名防塌缩（无 crypto 依赖，纯函数可测）。 */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 把远端工具名规范化为本地唯一名。
 *  MCP 参考实现：非法字符替换为 `_`。**发生替换时追加原串哈希**——防不同
 *  远端名（如 `a.b` 与 `a_b`）归一后塌缩成同名（skills-mcp-production-plan
 *  Commit 5，对齐 DSH/kimi-code 的 lossy+hash 防塌缩）。纯合法名（无替换）
 *  原样返回——既有 `mcp__server__tool` 形态与测试兼容面零变化。 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized === joined) return normalized;
  // 追加稳定哈希（原串 FNV-1a）——不同身份即使归一后同形也保持不同名
  return `${normalized}__${fnv1aHex(joined)}`;
}

export class McpClient {
  private readonly serverName: string;
  private readonly transport: McpTransport;
  private tools: McpToolSchema[] = empty;
  private connected = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingReq>();
  private readonly onMessageCbs = new Set<(msg: JsonRpcMessage) => void>();
  /** 外部 onProgress 回调。 */
  public onProgress?: (notification: {
    progressToken?: unknown;
    progress?: number;
    total?: number;
    message?: string;
  }) => void;
  /** 运维日志。 */
  public onLog?: (msg: string) => void;

  /** 订阅服务端主动通知（未知 method 的 message——progress 已有单独转发
   *  面，此面收其余全部）。返回退订函数。
   *  S4（app shell 件 D）：server 完成通知 lantai/deferred 经此面到达桥层
   *  翻译成插件后台唤醒。 */
  onNotification(cb: (msg: { method?: string; params?: Record<string, unknown> }) => void): () => void {
    this.onMessageCbs.add(cb);
    return () => this.onMessageCbs.delete(cb);
  }

  constructor(config: McpClientConfig) {
    this.serverName = config.serverName;
    if (config.transport) {
      this.transport = config.transport;
    } else if (config.url) {
      this.transport = createStreamableHttpTransport(config.url, config.headers ?? {});
    } else if (config.procIO) {
      this.transport = createStdioTransport(config.procIO);
    } else if (config.command) {
      // 动态引入，避免在 webview 等非 Node 环境被静态解析炸掉。
      this.transport = createStdioTransport(createNodeStdioProc(config.command, config.args ?? []));
    } else {
      throw new Error('McpClient: must provide transport, url, procIO, or command');
    }
    this.transport.onMessage((line) => {
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      this.dispatch(msg);
    });
    // 断线感知（Commit 6b）：底层进程意外退出 → isConnected 翻 false——
    // 否则死进程的 client 恒显示已连接，调用全失败直到下次装配
    // （工厂层 if (!client.isConnected) 重连逻辑也因此永不触发）。
    this.transport.onUnexpectedClose?.(() => {
      this._markDisconnected();
    });
  }

  /** 进程意外退出 → 连接态翻转 + 在途请求全部判负（错误可见不静默挂起）。 */
  private _markDisconnected(): void {
    if (!this.connected) return;
    this.connected = false;
    this.tools = empty;
    for (const [, p] of this.pending) {
      p.signal?.removeEventListener('abort', p.onAbort);
      p.reject(new Error('McpClient: server 进程意外退出（连接已断）'));
    }
    this.pending.clear();
  }

  get server(): string {
    return this.serverName;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && typeof msg.id !== 'string' && this.pending.has(Number(msg.id))) {
      const p = this.pending.get(Number(msg.id));
      this.pending.delete(Number(msg.id));
      if (p?.signal) p.signal.removeEventListener('abort', p.onAbort);
      p?.resolve(msg);
      return;
    }
    // 通知 / 服务器主动消息
    if (msg.method === 'notifications/progress') {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      this.onProgress?.({
        progressToken: params.progressToken,
        progress: params.progress as number | undefined,
        total: params.total as number | undefined,
        message: params.message as string | undefined,
      });
      return;
    }
    for (const cb of this.onMessageCbs) cb(msg);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const onAbort = () => reject(new Error(`${method} aborted by caller`));
      const entry: PendingReq = { resolve, reject, signal, onAbort };
      this.pending.set(id, entry);
      if (signal) {
        if (signal.aborted) {
          this.pending.delete(id);
          reject(new Error(`${method} aborted by caller`));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params, id })).catch((e: unknown) => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /** 握手：initialize → 通知 initialized → tools/list。 */
  async connect(): Promise<void> {
    if (this.connected) return;
    await this.transport.start();
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hologram-agent', version: '4.0.0' },
    });
    if (init.error) {
      throw new Error(`MCP initialize failed: ${init.error.message ?? init.error.code}`);
    }
    // 通知服务器已初始化（无 id 的 notify）
    await this.transport.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    const toolsMsg = await this.request('tools/list', {});
    if (toolsMsg.error) {
      throw new Error(`MCP tools/list failed: ${toolsMsg.error.message ?? toolsMsg.error.code}`);
    }
    const tools = (toolsMsg.result as { tools?: McpToolSchema[] })?.tools ?? [];
    this.tools = tools;
    this.connected = true;
  }

  /** 断开 + 清空远端工具。 */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.tools = empty;
    for (const [, p] of this.pending) {
      p.signal?.removeEventListener('abort', p.onAbort);
      p.reject(new Error('McpClient disconnected'));
    }
    this.pending.clear();
    await this.transport.close();
  }

  /** 所有权清理器：断开连接（Phase 1 disposer 契约）。幂等——disconnect 未连接时 no-op，
   *  Phase 4 由 context effect 持有；现有 disconnect 调用方不变。 */
  ownedDisposer(): Disposer {
    return once(() => this.disconnect());
  }

  /** 远端工具列表（raw names）。 */
  listRemoteTools(): McpToolSchema[] {
    return this.tools;
  }

  /** 计算某远端工具的本地限定名。 */
  qualifiedName(rawName: string): string {
    return publicToolName(this.serverName, rawName);
  }

  /** 调用远端工具。返回规范化结果。
   *  progressToken 若提供，会作为 _meta.progressToken 随请求发出，服务器据此
   *  推送 notifications/progress（经 this.onProgress 转发）。 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    progressToken?: unknown,
  ): Promise<McpResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (progressToken !== undefined) {
      params._meta = { progressToken };
    }
    const msg = await this.request('tools/call', params, signal);
    if (msg.error) {
      return { text: `MCP error ${msg.error.code} ${msg.error.message ?? ''}`, content: [], isError: true };
    }
    const result = (msg.result ?? {}) as {
      content?: unknown[];
      structuredContent?: unknown;
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    const content = result.content ?? [];
    const text = content
      .map((c) => (c as { type?: string; text?: string }).text ?? '')
      .filter(Boolean)
      .join('');
    return { text, content, isError: !!result.isError };
  }
}
