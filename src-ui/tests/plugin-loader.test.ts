// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 插件内核（WO-S0B）单元测试：manifest 校验 / 失败隔离 / disabled 跳过 / fiber dispose。
// loader 的 fetch 与 dynamic import 均为注入面（URL 注入 mock）；
// Rust 侧通道行为（遍历防护 / MIME / 404 / junction）由 src-tauri 的
// plugin_assets cargo test 覆盖。

import { beforeEach, describe, expect, it } from 'vitest';
import { Context } from '../src/cordis';
import { loadExternalPlugins } from '../src/plugins/loader';
import { PluginManifestSchema, validateManifest } from '../src/plugins/types';
import { usePluginStore } from '../src/state/plugin-store';

const ORIGIN = 'http://127.0.0.1:14570/plugins';

interface MockResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

function jsonResponse(body: unknown): MockResponse {
  return { ok: true, json: async () => body };
}

function notFound(): MockResponse {
  return { ok: false, json: async () => null };
}

/** 按 URL 精确路由的 mock fetch（未登记的 URL 一律 404）。 */
function mockFetch(routes: Record<string, unknown>): (url: string) => Promise<MockResponse> {
  return async (url: string) => (url in routes ? jsonResponse(routes[url]) : notFound());
}

const HELLO_MANIFEST = { name: 'hello', version: '1.0.0', entry: 'entry.js' };
const BAD_MANIFEST = { name: 'bad', version: '1.0.0', entry: 'entry.js' };

describe('manifest 校验（zod 单一来源）', () => {
  it('合法 manifest 通过', () => {
    expect(PluginManifestSchema.safeParse(HELLO_MANIFEST).success).toBe(true);
    const v = validateManifest(HELLO_MANIFEST);
    expect(v.ok).toBe(true);
  });

  it('缺 name / 坏 version / 坏 entry / 坏 name 全部拒绝', () => {
    expect(validateManifest({ version: '1.0.0', entry: 'entry.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: 'latest', entry: 'entry.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: '1.0.0', entry: '/abs/entry.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: '1.0.0', entry: '../escape.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: '1.0.0', entry: 'style.css' }).ok).toBe(false);
    expect(validateManifest({ name: 'Hello!', version: '1.0.0', entry: 'entry.js' }).ok).toBe(false);
    expect(validateManifest('not-an-object').ok).toBe(false);
  });

  it('S4-4 乙：mcpServers 形状校验（stdio/http 二选一 + failurePolicy 枚举）', () => {
    // 合法：stdio 带 command；http 带 url；failurePolicy 枚举值
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [
          { name: 'engine', transport: 'stdio', command: './bin/engine', args: ['--serve'] },
          { name: 'remote', transport: 'http', url: 'http://127.0.0.1:9000/mcp' },
          { name: 'strict', transport: 'stdio', command: 'node', failurePolicy: 'startup-error' },
        ],
      }).ok,
    ).toBe(true);
    // stdio 缺 command / 带 url；http 缺 url / 带 command；未知键；坏枚举
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ name: 'a', transport: 'stdio' }] }).ok).toBe(false);
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [{ name: 'a', transport: 'stdio', command: 'x', url: 'http://x' }],
      }).ok,
    ).toBe(false);
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ name: 'a', transport: 'http' }] }).ok).toBe(false);
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [{ name: 'a', transport: 'http', url: 'http://x', command: 'c' }],
      }).ok,
    ).toBe(false);
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [{ name: 'a', transport: 'stdio', command: 'c', bogus: 1 }],
      }).ok,
    ).toBe(false);
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [{ name: 'a', transport: 'stdio', command: 'c', failurePolicy: 'nope' }],
      }).ok,
    ).toBe(false);
  });
});

describe('loadExternalPlugins（失败隔离铁律）', () => {
  beforeEach(() => {
    usePluginStore.setState({ plugins: [] });
  });

  it('两个插件一个 import 抛错 → 另一个 active，store 有 error 记录', async () => {
    const root = new Context();
    const importCalls: string[] = [];
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello', 'bad'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
        [ORIGIN + '/bad/manifest.json']: BAD_MANIFEST,
      }),
      importModule: async (url: string) => {
        importCalls.push(url);
        if (url.endsWith('bad/entry.js')) throw new Error('disk boom');
        return { default: { name: 'hello', apply() {} } };
      },
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(2);
    expect(plugins.find((p) => p.name === 'hello')?.status).toBe('active');
    const bad = plugins.find((p) => p.name === 'bad');
    expect(bad?.status).toBe('error');
    expect(bad?.error).toContain('disk boom');
    expect(importCalls).toHaveLength(2);
  });

  it('apply 抛错 → error 记录（cordis fiber await reject）', async () => {
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule: async () => ({
        default: {
          name: 'hello',
          apply() {
            throw new Error('apply boom');
          },
        },
      }),
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.status).toBe('error');
    expect(plugins[0]?.error).toContain('apply boom');
  });

  it('disabled 跳过：plugins.json 列出 → 不 import，store 记 disabled', async () => {
    const root = new Context();
    const importModule = async (url: string): Promise<Record<string, unknown>> => {
      throw new Error('不应被调用: ' + url);
    };
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: ['hello'] },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule,
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.status).toBe('disabled');
  });

  it('inject 缺失 → error 记录（装载期存在性校验）', async () => {
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: { ...HELLO_MANIFEST, inject: ['nonexistent-service'] },
      }),
      importModule: async () => {
        throw new Error('不应被调用');
      },
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins[0]?.status).toBe('error');
    expect(plugins[0]?.error).toContain('nonexistent-service');
  });

  it('manifest 缺失 / 校验失败 → error 记录（不 import）', async () => {
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['ghost', 'broken'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/broken/manifest.json']: { name: 'broken', version: 'x', entry: 'entry.js' },
      }),
      importModule: async () => {
        throw new Error('不应被调用');
      },
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(2);
    expect(plugins.find((p) => p.name === 'ghost')?.error).toContain('缺失');
    expect(plugins.find((p) => p.name === 'broken')?.error).toContain('校验失败');
  });

  it('通道索引不可用 → loader 不 reject、store 不变', async () => {
    const root = new Context();
    await expect(loadExternalPlugins(root, { origin: ORIGIN, fetchImpl: mockFetch({}) })).resolves.toBeUndefined();
    expect(usePluginStore.getState().plugins).toEqual([]);
  });

  it('C11-1：manifest.tools + entry toolHandlers → 声明通道工具挂接；缺 handler → error 记录', async () => {
    const root = new Context();
    const { compositionServicesPlugin } = await import('../src/composition/services');
    await root.plugin(compositionServicesPlugin);
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/todo'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/acme/todo/manifest.json']: {
          name: 'acme/todo',
          version: '1.0.0',
          entry: 'entry.js',
          tools: [
            {
              name: 'todo_read',
              description: '读待办',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
              readOnly: true,
            },
          ],
        },
      }),
      importModule: async () => ({
        default: { name: 'acme/todo', apply() {} },
        toolHandlers: { todo_read: async (args: { q?: string }) => 'todo:' + String(args.q ?? '') },
      }),
    });
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
    // 声明通道贡献在册（行 id 折算 plugin/<插件名>/<工具名>）
    const { pluginToolRows } = await import('../src/composition/plugin-tool-rows');
    expect(pluginToolRows().map((r) => r.id)).toEqual(['plugin/acme/todo/todo_read']);
    const row = pluginToolRows()[0];
    if (!row) throw new Error('声明通道贡献行未注册');
    const tools = await row.factory({} as never);
    expect(tools[0]?.name()).toBe('todo_read');
    expect(tools[0]?.readOnly()).toBe(true);
    await expect(tools[0]?.execute({ q: 'x' })).resolves.toBe('todo:x');

    // 缺 handler → 插件 error（失败隔离；all-or-nothing：一条不挂，全部不挂）
    const root2 = new Context();
    await root2.plugin(compositionServicesPlugin);
    await loadExternalPlugins(root2, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/broken'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/acme/broken/manifest.json']: {
          name: 'acme/broken',
          version: '1.0.0',
          entry: 'entry.js',
          tools: [{ name: 'todo_read', description: '读', parameters: { type: 'object' } }],
        },
      }),
      importModule: async () => ({
        default: { name: 'acme/broken', apply() {} },
        // toolHandlers 导出但缺 todo_read
        toolHandlers: { other: async () => 'x' },
      }),
    });
    expect(usePluginStore.getState().plugins[0]?.status).toBe('error');
    expect(usePluginStore.getState().plugins[0]?.error).toContain('未声明的工具');
    expect(pluginToolRows()).toEqual([]); // 失败不残留贡献
  });

  it('C11-2：permissions 声明形状校验（枚举闭集）', () => {
    expect(validateManifest({ ...HELLO_MANIFEST, permissions: ['read', 'bash'] }).ok).toBe(true);
    expect(validateManifest({ ...HELLO_MANIFEST, permissions: [] }).ok).toBe(true);
    // 未知权限类拒绝（枚举闭集——「写了但不生效」的类名是手误）
    expect(validateManifest({ ...HELLO_MANIFEST, permissions: ['root'] }).ok).toBe(false);
    expect(validateManifest({ ...HELLO_MANIFEST, permissions: ['bash', 'ssh'] }).ok).toBe(false);
    expect(validateManifest({ ...HELLO_MANIFEST, permissions: 'bash' }).ok).toBe(false);
  });

  it('C11-2：权限门禁——声明未被 granted 覆盖 → blocked（不 import）；覆盖/无声明 → 装载', async () => {
    const importCalls: string[] = [];
    const importModule = async (url: string): Promise<Record<string, unknown>> => {
      importCalls.push(url);
      return { default: { name: 'acme/power', apply() {} } };
    };
    const manifest = {
      name: 'acme/power',
      version: '1.0.0',
      entry: 'entry.js',
      permissions: ['bash', 'edit'],
    };
    // 未授予（granted 缺该插件）→ blocked + 缺哪些授权可见 + 不 import
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/power'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/acme/power/manifest.json']: manifest,
      }),
      importModule,
    });
    let rec = usePluginStore.getState().plugins[0];
    expect(rec?.status).toBe('blocked');
    expect(rec?.missingPermissions).toEqual(['bash', 'edit']);
    expect(importCalls).toEqual([]);

    // 部分授予 → 仍 blocked（缺的部分可见）
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/power'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: { 'acme/power': ['bash'] } },
        [ORIGIN + '/acme/power/manifest.json']: manifest,
      }),
      importModule,
    });
    rec = usePluginStore.getState().plugins[0];
    expect(rec?.status).toBe('blocked');
    expect(rec?.missingPermissions).toEqual(['edit']);
    expect(importCalls).toEqual([]);

    // 全覆盖 → active（import + apply）
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/power'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: { 'acme/power': ['bash', 'edit', 'web'] } },
        [ORIGIN + '/acme/power/manifest.json']: manifest,
      }),
      importModule,
    });
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
    expect(importCalls).toHaveLength(1);

    // 无声明 = 零摩擦直接装载（hello 形态）
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/pure'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/acme/pure/manifest.json']: { name: 'acme/pure', version: '1.0.0', entry: 'entry.js' },
      }),
      importModule: async () => ({ default: { name: 'acme/pure', apply() {} } }),
    });
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');

    // plugins.json 缺失/坏形状 → granted 空表（按无授权处理，声明插件 blocked）
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/power'],
        // plugins.json 不可达（404 → fetchJson null → 空态）
        [ORIGIN + '/acme/power/manifest.json']: manifest,
      }),
      importModule,
    });
    expect(usePluginStore.getState().plugins[0]?.status).toBe('blocked');
  });

  it('S4-4 乙：mcpServers → 包装装载（entry.apply 后桥贡献注册）', async () => {
    // 内存 MCP server 行协议 fake（mcp-bridge.test 同款——loader 集成只验
    // 包装接线，协议细节与 dispose 链在桥测试钉）
    const kills: string[] = [];
    const io = {
      createProcIO: async () => {
        const outCbs = new Set<(line: string) => void>();
        const exitCbs = new Set<(code: number | null) => void>();
        return {
          writeLine: (line: string) => {
            const msg = JSON.parse(line) as { id?: number; method?: string };
            if (msg.id === undefined) return;
            const result =
              msg.method === 'initialize'
                ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'f', version: '1' } }
                : msg.method === 'tools/list'
                  ? { tools: [{ name: 'probe_tool', inputSchema: { type: 'object', properties: {} } }] }
                  : {};
            for (const cb of outCbs) cb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
          },
          onStdoutLine: (cb: (line: string) => void) => {
            outCbs.add(cb);
            return () => {
              outCbs.delete(cb);
            };
          },
          onExit: (cb: (code: number | null) => void) => {
            exitCbs.add(cb);
            return () => {
              exitCbs.delete(cb);
            };
          },
          kill: () => {
            kills.push('killed');
            for (const cb of exitCbs) cb(0);
          },
        };
      },
      pluginDir: async (name: string) => `C:/plugins/${name}`,
    } as const;

    const applyCalls: string[] = [];
    const root = new Context();
    // 四 service 先挂（tools 可注入）
    const { compositionServicesPlugin } = await import('../src/composition/services');
    await root.plugin(compositionServicesPlugin);
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      mcpBridgeIO: io,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: {
          ...HELLO_MANIFEST,
          mcpServers: [{ name: 'engine', transport: 'stdio', command: './bin/engine' }],
        },
      }),
      importModule: async () => ({
        default: {
          name: 'hello',
          apply() {
            applyCalls.push('hello');
          },
        },
      }),
    });
    // entry.apply 已跑 + 插件 active
    expect(applyCalls).toEqual(['hello']);
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
    // 桥贡献已注册（行 id plugin/hello/mcp/engine）
    const { pluginToolRows } = await import('../src/composition/plugin-tool-rows');
    const rows = pluginToolRows();
    expect(rows.map((r) => r.id)).toEqual(['plugin/hello/mcp/engine']);
    // 惰性连接：首装配拉远端工具
    const row = rows[0];
    if (!row) throw new Error('桥贡献行未注册');
    const tools = await row.factory({} as never);
    expect(tools.map((t) => t.name())).toEqual(['mcp__engine__probe_tool']);
    // dispose 链（fiber dispose → 贡献注销 + 进程 kill）在 mcp-bridge.test 钉
    // （root 的 asyncDispose 不级联 plugin fibers——此处不重复断言）
    expect(kills).toEqual([]);
    await root[Symbol.asyncDispose]?.();
  });
});

describe('fiber 生命周期（cordis，workspace-fiber 测试同款模式）', () => {
  it('root.plugin(obj) 注册的 effect 在 fiber dispose 后清理', async () => {
    const root = new Context();
    const events: string[] = [];
    const fiber = root.plugin({
      name: 'probe',
      apply(ctx) {
        ctx.effect(() => {
          events.push('setup');
          return () => {
            events.push('dispose');
          };
        }, 'probe');
      },
    });
    await fiber;
    expect(events).toEqual(['setup']);
    await fiber.dispose();
    expect(events).toEqual(['setup', 'dispose']);
  });

  it('apply 抛错 → await root.plugin() reject（装载期可捕获，进 store）', async () => {
    const root = new Context();
    const fiber = root.plugin({
      name: 'bad',
      apply() {
        throw new Error('apply boom');
      },
    });
    await expect(Promise.resolve(fiber)).rejects.toThrow('apply boom');
  });
});
