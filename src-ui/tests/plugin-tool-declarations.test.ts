// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// C11-1 工具声明可序列化钉住面（plugins/tool-declarations.ts）：
//   1. manifest schema：tools 声明形状校验（合法 / parameters 非 object
//      型 / 缺字段 / 未知键拒绝）；
//   2. declarationToTool：数据声明 → Tool（模型面三字段 + readOnly 缺省
//      false + execute 透传 args/onProgress/signal）；
//   3. declarationOf：zod 工具（defineTool）→ 声明数据——与
//      declarationToTool 往返对拍（parameters 逐字节等于 toInputJsonSchema
//      产物——zod↔manifest 双向桥的同构保证）；
//   4. mountToolDeclarations：贡献挂接（行 id 折算 plugin/<插件名>/<工具名>）
//      + 声明/实现一一对应校验（缺 handler / 多 handler / 非函数 / 无
//      toolHandlers 导出 → throw）+ fiber dispose 贡献注销。

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/agent/tools/define-tool';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { declarationOf, declarationToTool, mountToolDeclarations } from '../src/plugins/tool-declarations';
import { validateManifest } from '../src/plugins/types';

const BASE_MANIFEST = { name: 'acme/todo', version: '1.0.0', entry: 'entry.js' };

describe('manifest.tools 声明形状（C11-1 schema）', () => {
  it('合法声明通过（name/description/parameters object 型 JSON Schema/readOnly）', () => {
    const v = validateManifest({
      ...BASE_MANIFEST,
      tools: [
        {
          name: 'todo_read',
          description: '读待办',
          parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
          readOnly: true,
        },
        { name: 'todo_write', description: '写待办', parameters: { type: 'object', properties: {} } },
      ],
    });
    expect(v.ok).toBe(true);
  });

  it('parameters 非 object 型 / 缺字段 / 未知键 / 坏 readOnly 拒绝', () => {
    // parameters 不是 type:"object"
    expect(
      validateManifest({
        ...BASE_MANIFEST,
        tools: [{ name: 't', description: 'd', parameters: { type: 'string' } }],
      }).ok,
    ).toBe(false);
    expect(
      validateManifest({
        ...BASE_MANIFEST,
        tools: [{ name: 't', description: 'd', parameters: { properties: {} } }],
      }).ok,
    ).toBe(false);
    // 缺 description / 缺 name
    expect(validateManifest({ ...BASE_MANIFEST, tools: [{ name: 't', parameters: { type: 'object' } }] }).ok).toBe(
      false,
    );
    expect(
      validateManifest({ ...BASE_MANIFEST, tools: [{ description: 'd', parameters: { type: 'object' } }] }).ok,
    ).toBe(false);
    // 未知键（strictObject）+ 坏 readOnly
    expect(
      validateManifest({
        ...BASE_MANIFEST,
        tools: [{ name: 't', description: 'd', parameters: { type: 'object' }, execute: 'nope' }],
      }).ok,
    ).toBe(false);
    expect(
      validateManifest({
        ...BASE_MANIFEST,
        tools: [{ name: 't', description: 'd', parameters: { type: 'object' }, readOnly: 'yes' }],
      }).ok,
    ).toBe(false);
  });
});

describe('declarationToTool（manifest→工具方向）', () => {
  it('数据声明直转 Tool：三字段 + readOnly 缺省 false + execute 透传', async () => {
    const calls: unknown[] = [];
    const tool = declarationToTool({
      name: 'probe_tool',
      description: '探针',
      parameters: { type: 'object', properties: { a: { type: 'string' } } },
      readOnly: true,
      execute: async (args, onProgress, signal) => {
        calls.push({ args, hasProgress: typeof onProgress, signal });
        onProgress?.('半程');
        return 'ok:' + String(args.a);
      },
    });
    expect(tool.name()).toBe('probe_tool');
    expect(tool.description()).toBe('探针');
    expect(tool.parameters()).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
    expect(tool.readOnly()).toBe(true);
    // 缺省 false
    expect(
      declarationToTool({
        name: 'x',
        description: 'y',
        parameters: { type: 'object' },
        execute: async () => '',
      }).readOnly(),
    ).toBe(false);
    // execute 透传三参
    const ctrl = new AbortController();
    const out = await tool.execute({ a: 'Q' }, () => {}, ctrl.signal);
    expect(out).toBe('ok:Q');
    expect(calls[0]).toMatchObject({ args: { a: 'Q' }, hasProgress: 'function' });
    expect((calls[0] as { signal?: AbortSignal }).signal).toBe(ctrl.signal);
  });
});

describe('declarationOf（zod→manifest 数据方向）', () => {
  it('defineTool 的 zod 工具序列化为声明数据，往返同构（parameters 逐字节等于）', () => {
    const zodTool = defineTool({
      name: 'probe_zod',
      description: 'zod 探针',
      schema: z.object({ q: z.string().describe('查询词'), limit: z.number().optional() }),
      readOnly: true,
      execute: async () => 'ok',
    });
    const decl = declarationOf(zodTool);
    expect(decl).toEqual({
      name: 'probe_zod',
      description: 'zod 探针',
      parameters: zodTool.parameters(),
      readOnly: true,
    });
    // 往返：declarationToTool(declarationOf(t)) 的模型面与 t 全等——
    // 第一方 zod 工具与第三方 manifest 工具在同一数据形状上对拍
    const rebuilt = declarationToTool({ ...decl, execute: async () => 'ok' });
    expect(rebuilt.name()).toBe(zodTool.name());
    expect(rebuilt.description()).toBe(zodTool.description());
    expect(rebuilt.parameters()).toEqual(zodTool.parameters());
    expect(rebuilt.readOnly()).toBe(zodTool.readOnly());
  });
});

describe('mountToolDeclarations（装载器挂接面）', () => {
  it('声明 + handlers 一一对应：贡献挂接（行 id 折算）+ fiber dispose 注销', async () => {
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    // 复刻装载器路径：挂接动作在插件 fiber 的 apply 内（effect 归该 fiber；
    // inject 声明与装载器包装层同款——cordis 注入纪律）
    const fiber = await root.plugin({
      name: 'acme/todo-mount',
      inject: ['tools'],
      apply(ctx) {
        mountToolDeclarations(
          ctx,
          'acme/todo',
          [
            { name: 'todo_read', description: '读', parameters: { type: 'object', properties: {} }, readOnly: true },
            { name: 'todo_write', description: '写', parameters: { type: 'object', properties: {} } },
          ],
          {
            todo_read: async () => 'read-ok',
            todo_write: async () => 'write-ok',
          },
        );
      },
    });
    // 行 id 折算（plugin/<插件名>/<工具名>——patch/preset 可寻址）
    expect(pluginToolRows().map((r) => r.id)).toEqual(['plugin/acme/todo/todo_read', 'plugin/acme/todo/todo_write']);
    // factory 产出可执行工具（实例缓存：数据 + 函数闭包，无 noCache 语义）
    const row = pluginToolRows()[0];
    if (!row) throw new Error('贡献行未注册');
    const tools = await row.factory({} as never);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name()).toBe('todo_read');
    await expect(tools[0]?.execute({})).resolves.toBe('read-ok');

    // fiber dispose → 贡献注销（插件卸载语义）
    await fiber.dispose();
    expect(pluginToolRows()).toEqual([]);
  });

  it('缺 handler → throw（声明与实现一一对应；多余 handler 同理拒绝）', () => {
    const root = new Context();
    expect(() => mountToolDeclarations(root, 'acme/todo', [], { todo_read: async () => 'x' })).toThrow(
      /未声明的工具 "todo_read"/,
    );
  });

  it('handler 未声明 / 非函数 / 无 toolHandlers 导出 → throw', () => {
    const root = new Context();
    expect(() => mountToolDeclarations(root, 'acme/todo', [], { ghost: async () => 'x' })).toThrow(
      /未声明的工具 "ghost"/,
    );
    expect(() =>
      mountToolDeclarations(root, 'acme/todo', [{ name: 't', description: 'd', parameters: { type: 'object' } }], {}),
    ).toThrow(/缺 handler：t/);
    expect(() =>
      mountToolDeclarations(root, 'acme/todo', [{ name: 't', description: 'd', parameters: { type: 'object' } }], {
        t: 'not-a-function',
      }),
    ).toThrow(/必须是函数/);
    expect(() =>
      mountToolDeclarations(
        root,
        'acme/todo',
        [{ name: 't', description: 'd', parameters: { type: 'object' } }],
        undefined,
      ),
    ).toThrow(/未导出 toolHandlers/);
    expect(() =>
      mountToolDeclarations(
        root,
        'acme/todo',
        [{ name: 't', description: 'd', parameters: { type: 'object' } }],
        ['array'],
      ),
    ).toThrow(/未导出 toolHandlers/);
  });
});
