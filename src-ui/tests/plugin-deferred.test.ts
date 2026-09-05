// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件后台唤醒回调（app shell 四件套 · 件 D，S4）钉住面：
//   a) 异步提交立即返回：manifest.tools async:true → execute 即回卡片（宿主注入
//      args._task_id 供回执引用），不等待后台完成；
//   b) 完成后台唤醒带 minimal 键：deferred.complete(taskId,'completed') →
//      唤醒发起 Agent（executor 注入的 _owner_id 语义），注入体
//      {status, taskId, sessionId}；
//   c) 失败唤醒带定位键：'failed' 同链路；
//   d) 唤醒不占上下文：formatDeferredWakeNote 形状钉死——JSON 恰三键 +
//      归因前缀一行，message 截 160，内容不进唤醒体（凭 taskId 自取）；
//   e) MCP 完成通知 → 同一唤醒：server 发 lantai/deferred（progressToken 回带
//      调用期 token），桥翻译成与工具口同一唤醒面。
//   附加：无 Agent 语境（_owner_id 缺席）降级不炸（warn 可见 + false）；
//   async 缺省 false = 同步语义不变（不注入 _task_id 不登记）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcIO } from '../src/agent/mcp';
import { MessageBus } from '../src/agent/message-bus';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import {
  completePluginTask,
  type DeferredWakeHandler,
  formatDeferredWakeNote,
  pendingDeferredCountForTests,
  registerDeferredWakeHandler,
  resetPluginDeferredForTests,
} from '../src/plugins/deferred';
import { type McpBridgeIO, registerMcpServerTools, resetMcpGovernorForTests } from '../src/plugins/mcp-bridge';
import { mountToolDeclarations } from '../src/plugins/tool-declarations';
import { type ToolManifestDecl, validateManifest } from '../src/plugins/types';

const HELLO = { name: 'hello', version: '1.0.0', entry: 'entry.js' };

beforeEach(() => {
  resetPluginDeferredForTests();
  resetMcpGovernorForTests();
});

// ── schema：async 声明字段 ──

describe('S4 唤醒回调：manifest.tools async 字段', () => {
  const DECL = (async?: boolean): Record<string, unknown> => ({
    name: 'notes_export',
    description: '导出',
    parameters: { type: 'object' },
    ...(async !== undefined ? { async } : {}),
  });

  it('true / false / 缺省均合法；非布尔拒绝（手误不静默）', () => {
    expect(validateManifest({ ...HELLO, tools: [DECL(true)] }).ok).toBe(true);
    expect(validateManifest({ ...HELLO, tools: [DECL(false)] }).ok).toBe(true);
    expect(validateManifest({ ...HELLO, tools: [DECL()] }).ok).toBe(true);
    expect(validateManifest({ ...HELLO, tools: [DECL('true' as unknown as boolean)] }).ok).toBe(false);
  });
});

// ── d) minimal 定位键形状（纯函数钉死） ──

describe('S4 唤醒回调：d) 唤醒体极小且形状钉死（不占上下文）', () => {
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

// ── 工具口：a) 提交即回 / b) 完成唤醒 / c) 失败唤醒 ──

const ASYNC_DECL: ToolManifestDecl = {
  name: 'notes_export',
  description: '导出便签（长任务模拟）',
  parameters: { type: 'object' },
  async: true,
};

async function bootAsyncTool(): Promise<{ root: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  const fiber = await root.plugin({
    name: 'acme/notes',
    inject: ['tools'],
    apply(ctx) {
      mountToolDeclarations(ctx, 'acme/notes', [ASYNC_DECL], {
        notes_export: async (args) => `导出任务已提交（taskId: ${String(args._task_id)}）——完成后将通知你。`,
      });
    },
  });
  return { root, fiber };
}

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

async function asyncExportTool(): Promise<ReturnType<ReturnType<typeof pluginToolRows>[number]['factory']>> {
  const rows = pluginToolRows();
  const row = rows.find((r) => r.id === 'plugin/acme/notes/notes_export');
  expect(row).toBeDefined();
  return row?.factory;
}

describe('S4 唤醒回调：a/b/c) 工具口 async 提交即回卡片，完成/失败唤醒', () => {
  it('a) async:true → execute 立即返回卡片（args._task_id 注入）+ 调用期登记发起者', async () => {
    const { root, fiber } = await bootAsyncTool();
    const factory = await asyncExportTool();
    const tools = await factory({} as never);
    const card = await tools[0].execute({ _owner_id: 'main-x' });
    expect(card).toMatch(/导出任务已提交（taskId: ptask-/);
    expect(pendingDeferredCountForTests().tasks).toBe(1);
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('b) complete(taskId,"completed") → 唤醒发起 Agent（bg 注入 + idle wake 触发）', async () => {
    const { root, fiber } = await bootAsyncTool();
    const { bus, wakeSpy, handler } = bootBusAndHandler();
    const un = registerDeferredWakeHandler(handler);
    const factory = await asyncExportTool();
    const tools = await factory({} as never);
    const card = await tools[0].execute({ _owner_id: 'main-x' });
    const taskId = /ptask-[a-z0-9-]+/.exec(card ?? '')?.[0] ?? '';
    expect(taskId).not.toBe('');
    expect(completePluginTask(taskId, 'completed', '导出完成，结果可取')).toBe(true);
    expect(wakeSpy).toHaveBeenCalledTimes(1); // idle 唤醒回调触发
    const inbox = bus.peekInbox('main-x');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe('bg');
    expect(String(inbox[0].payload)).toContain('{"status":"completed","taskId":"' + taskId + '","sessionId":"7"}');
    expect(pendingDeferredCountForTests().tasks).toBe(0); // 唤醒即消费登记
    un();
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('c) 失败唤醒带定位键（"failed" 同链路）', async () => {
    const { root, fiber } = await bootAsyncTool();
    const { bus, handler } = bootBusAndHandler();
    const un = registerDeferredWakeHandler(handler);
    const factory = await asyncExportTool();
    const tools = await factory({} as never);
    const card = await tools[0].execute({ _owner_id: 'main-x' });
    const taskId = /ptask-[a-z0-9-]+/.exec(card ?? '')?.[0] ?? '';
    expect(completePluginTask(taskId, 'failed')).toBe(true);
    expect(String(bus.peekInbox('main-x')[0].payload)).toContain('"status":"failed"');
    un();
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('无 Agent 语境（_owner_id 缺席）：提交照常，complete 降级 false（warn 可见）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, fiber } = await bootAsyncTool();
    const factory = await asyncExportTool();
    const tools = await factory({} as never);
    const card = await tools[0].execute({}); // UI/测试直调语境
    expect(card).toMatch(/ptask-/);
    const taskId = /ptask-[a-z0-9-]+/.exec(card ?? '')?.[0] ?? '';
    expect(completePluginTask(taskId, 'completed')).toBe(false);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('无发起 Agent'))).toBe(true);
    warnSpy.mockRestore();
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });

  it('async 缺省 false：同步语义不变——不注入 _task_id、不登记', async () => {
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    const fiber = await root.plugin({
      name: 'acme/plain',
      inject: ['tools'],
      apply(ctx) {
        mountToolDeclarations(
          ctx,
          'acme/plain',
          [{ name: 'sync_tool', description: '同步', parameters: { type: 'object' } }],
          {
            sync_tool: async (args) => {
              expect(args._task_id).toBeUndefined(); // 同步工具无注入
              return 'ok';
            },
          },
        );
      },
    });
    const rows = pluginToolRows();
    const factory = rows.find((r) => r.id === 'plugin/acme/plain/sync_tool')?.factory;
    const tools = await factory?.({} as never);
    expect(await tools?.[0].execute({ _owner_id: 'main-x' })).toBe('ok');
    expect(pendingDeferredCountForTests().tasks).toBe(0);
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
  });
});

// ── e) MCP 完成通知 → 同一唤醒（桥翻译路径） ──

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

describe('S4 唤醒回调：e) MCP 完成通知（lantai/deferred）→ 桥翻译成同一唤醒', () => {
  it('调用绑 token → server 完成通知回带 → 唤醒发起 Agent（与工具口同面）', async () => {
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
          [{ name: 'engine', transport: 'stdio', command: './bin/engine', lifecycle: 'lazy' }],
          io,
          { timing: { startupDeadlineMs: 2000, idleTimeoutMs: 5000, restartBackoffMs: 40 } },
        );
      },
    });
    const { bus, wakeSpy, handler } = bootBusAndHandler();
    const un = registerDeferredWakeHandler(handler);
    const row = pluginToolRows().find((r) => r.id === 'plugin/acme/notes/mcp/engine');
    expect(row).toBeDefined();
    // 装配触发拉起（lazy）→ 轮询到就绪
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
          [{ name: 'engine', transport: 'stdio', command: './bin/engine', lifecycle: 'lazy' }],
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
