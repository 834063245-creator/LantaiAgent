// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件后台唤醒回调（app shell 四件套 · 件 D，S4）钉住面：
//   a) 唤醒体极小且形状钉死：formatDeferredWakeNote = JSON 恰 {status, taskId,
//      sessionId} 三键 + 归因前缀一行，message 截 160；内容不进唤醒体（凭 taskId 自取）；
//   b) 失败语义前缀翻面（同一形状）；
//   c) MCP 完成通知 → 唤醒：调用期绑 deferred progressToken，server 发
//      lantai/deferred 回带 → 桥翻译成同一唤醒注入口。
//   附加：无 runtime 受理降级不炸（warn 可见 + false）；未登记 token 静默忽略。
//
// 2026-11-23 减形（契约 v73）：**工具口 async 退役**——manifest.tools[].async 与宿主桥
// `deferred.complete` 一并删除（仓内 0 消费者）。长任务只剩 MCP 这一条路：插件自带
// server，完成时发 lantai/deferred。本文件只钉这条路。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcIO } from '../src/agent/mcp';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { MessageBus } from '../src/plugins/builtin/multiagent-comm/message-bus';
import {
  type DeferredWakeHandler,
  formatDeferredWakeNote,
  pendingDeferredCountForTests,
  registerDeferredWakeHandler,
  resetPluginDeferredForTests,
} from '../src/plugins/deferred';
import { type McpBridgeIO, registerMcpServerTools, resetMcpGovernorForTests } from '../src/plugins/mcp-bridge';

beforeEach(() => {
  resetPluginDeferredForTests();
  resetMcpGovernorForTests();
});

// ── a/b) minimal 定位键形状（纯函数钉死） ──

describe('S4 唤醒回调：a/b) 唤醒体极小且形状钉死（不占上下文）', () => {
  it('JSON 恰 {status, taskId, sessionId} 三键 + 归因前缀；无长内容', () => {
    const note = formatDeferredWakeNote(
      { taskId: 'export-1', status: 'completed', plugin: 'acme/notes', tool: 'notes_export' },
      '7',
    );
    expect(note).toBe(
      '插件后台任务完成（acme/notes · notes_export）: {"status":"completed","taskId":"export-1","sessionId":"7"}',
    );
    const parsed = JSON.parse(note.slice(note.indexOf('{'))) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['sessionId', 'status', 'taskId']);
    expect(note.length).toBeLessThan(200);
  });

  it('失败语义前缀翻面；message 截 160 且另起一行', () => {
    const note = formatDeferredWakeNote(
      { taskId: 't1', status: 'failed', plugin: 'acme/notes', message: 'x'.repeat(400) },
      '3',
    );
    expect(note.startsWith('插件后台任务失败（acme/notes）: {"status":"failed","taskId":"t1","sessionId":"3"}')).toBe(
      true,
    );
    const lines = note.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].length).toBe(160);
  });
});

/** 组真实 MessageBus 的唤醒路由器（workspace.ts 同款形状——受理检查 +
 *  sessionId 解析 + minimal note 注入 + idle wake 触发）。 */
function bootBusAndHandler(): { bus: MessageBus; wakeSpy: ReturnType<typeof vi.fn>; handler: DeferredWakeHandler } {
  const bus = new MessageBus();
  const wakeSpy = vi.fn();
  bus.register({ agentId: 'main-x' }, wakeSpy);
  const sessionIdOf = (): string => '7';
  const handler: DeferredWakeHandler = (ownerId, key) => {
    if (!bus.isRegistered(ownerId)) return false;
    bus.systemNotify(ownerId, 'bg', formatDeferredWakeNote(key, sessionIdOf()));
    return true;
  };
  return { bus, wakeSpy, handler };
}

// ── c) MCP 完成通知 → 同一唤醒（桥翻译路径） ──

/** fake server：应答握手/tools 列表/调用（捕获 deferred progressToken）；
 *  serverSays 从 server 侧回灌一行 stdout（发 lantai/deferred 完成通知）。 */
function makeDeferredFakeIO(): { io: McpBridgeIO; serverSays: (line: string) => void; lastToken: { value?: unknown } } {
  const lastToken: { value?: unknown } = {};
  const outCbs = new Set<(line: string) => void>();
  const serverSays = (line: string): void => {
    for (const cb of outCbs) cb(line);
  };
  const io: McpBridgeIO = {
    createProcIO: async () => {
      const proc: ProcIO = {
        writeLine: (line: string) => {
          const msg = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: { _meta?: { progressToken?: unknown } };
          };
          if (msg.method === undefined || msg.id === undefined) return;
          const respond = (result: unknown) => {
            for (const cb of outCbs) cb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
          };
          if (msg.method === 'initialize') {
            respond({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
          } else if (msg.method === 'tools/list') {
            respond({
              tools: [{ name: 'notes_export', description: '导出', inputSchema: { type: 'object', properties: {} } }],
            });
          } else if (msg.method === 'tools/call') {
            lastToken.value = msg.params?._meta?.progressToken;
            respond({ content: [{ type: 'text', text: '[notes_export] 已提交' }], isError: false });
          } else {
            respond({});
          }
        },
        onStdoutLine: (cb) => {
          outCbs.add(cb);
          return () => outCbs.delete(cb);
        },
        onExit: () => () => {},
        kill: () => {},
      };
      return proc;
    },
    pluginDir: async (name) => `C:/plugins/${name}`,
  };
  return { io, serverSays, lastToken };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('S4 唤醒回调：c) MCP 完成通知（lantai/deferred）→ 桥翻译成唤醒', () => {
  it('调用绑 token → server 完成通知回带 → 唤醒发起 Agent', async () => {
    const { io, serverSays, lastToken } = makeDeferredFakeIO();
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    const fiber = await root.plugin({
      name: 'acme/notes',
      inject: ['tools'],
      async apply(ctx) {
        await registerMcpServerTools(
          ctx,
          'acme/notes',
          [{ name: 'engine', transport: 'stdio', command: './bin/engine', governed: true }],
          io,
          { timing: { startupDeadlineMs: 2000, idleTimeoutMs: 5000, restartBackoffMs: 40 } },
        );
      },
    });
    const { bus, wakeSpy, handler } = bootBusAndHandler();
    const un = registerDeferredWakeHandler(handler);
    const row = pluginToolRows().find((r) => r.id === 'plugin/acme/notes/mcp/engine');
    expect(row).toBeDefined();
    // 装配触发拉起 → 轮询到就绪
    let tools = await row?.factory({} as never);
    for (let i = 0; i < 100 && (tools?.length ?? 0) === 0; i++) {
      await sleep(20);
      tools = await row?.factory({} as never);
    }
    expect(tools?.[0].name()).toBe('mcp__engine__notes_export');
    // Agent 发起调用：绑 deferred token，卡片立即回（决策 7——不等后台）
    const card = await tools?.[0].execute({ _owner_id: 'main-x' });
    expect(card).toBe('[notes_export] 已提交');
    expect(lastToken.value).toMatch(/^dftok-/);
    expect(pendingDeferredCountForTests().tokens).toBe(1);
    // server 完成：lantai/deferred（progressToken 回带 + 自订 taskId）
    serverSays(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'lantai/deferred',
        params: { progressToken: lastToken.value, taskId: 'export-1', status: 'completed', message: '完成' },
      }),
    );
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    expect(String(bus.peekInbox('main-x')[0].payload)).toContain('"taskId":"export-1"');
    expect(String(bus.peekInbox('main-x')[0].payload)).toContain('mcp__engine__notes_export');
    expect(pendingDeferredCountForTests().tokens).toBe(0); // 翻译即消费
    un();
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('server 乱发完成通知（未登记 token）→ 静默忽略不炸不唤醒', async () => {
    const { io, serverSays } = makeDeferredFakeIO();
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    const fiber = await root.plugin({
      name: 'acme/notes',
      inject: ['tools'],
      async apply(ctx) {
        await registerMcpServerTools(
          ctx,
          'acme/notes',
          [{ name: 'engine', transport: 'stdio', command: './bin/engine', governed: true }],
          io,
          { timing: { startupDeadlineMs: 2000, idleTimeoutMs: 5000, restartBackoffMs: 40 } },
        );
      },
    });
    const { wakeSpy, handler } = bootBusAndHandler();
    const un = registerDeferredWakeHandler(handler);
    serverSays(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'lantai/deferred',
        params: { progressToken: 'dftok-bogus', taskId: 'x', status: 'completed' },
      }),
    );
    serverSays(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/whatever', params: {} }));
    await sleep(60);
    expect(wakeSpy).not.toHaveBeenCalled();
    un();
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });
});
