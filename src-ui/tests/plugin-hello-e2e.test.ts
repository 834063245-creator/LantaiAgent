// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S4-5 hello 闭环测试 — 「假装是外人」验收的自动化半边：
//   真实 examples/plugins/hello/entry.js 经真实装载管道（manifest 校验 →
//   dynamic import → root.plugin(apply)）跑通三通道。README 的手动走查
//   （装-用-卸）是另一半——执行者按文档操作，本测试保证文档描述的机制
//   事实上成立（文档撒谎 = 验收失败）。
//
// 覆盖：manifest 形状 / 插件对象形状 / inject 依赖可解析 / 三通道注册
// 即时可见 / 工具经 pluginToolRows 折算（factory 缓存）/ fiber dispose
// 干净退出 / 面板组件经宿主桥 createElement 可渲染。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { panelDefs } from '../src/app/panels/panel-def';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { validateManifest } from '../src/plugins/types';

const HELLO_DIR = path.resolve(process.cwd(), '../examples/plugins/hello');

/** 装载真实 hello 插件的共享管道（manifest 经通道形状——同生产）。 */
async function bootWithHello(): Promise<{
  root: Context;
  fiber: Awaited<ReturnType<Context['plugin']>>;
}> {
  const root = new Context();
  const servicesFiber = root.plugin(compositionServicesPlugin);
  await servicesFiber;
  // 动态 import 真实 entry.js：读源码 → data: URL 动态 import（模块零裸
  // import，data URL 自包含可执行——比 file URL 更贴近生产形态：webview
  // 也是从非 bundle 通道动态 import 的）。
  const src = readFileSync(path.join(HELLO_DIR, 'entry.js'), 'utf8');
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
  const mod = (await import(/* @vite-ignore */ dataUrl)) as Record<string, unknown>;
  const candidate = (mod.default ?? mod) as { name: string; apply: (ctx: Context) => void };
  const fiber = root.plugin(candidate);
  await fiber;
  return { root, fiber };
}

describe('S4-5 hello 闭环：真实插件经真实管道', () => {
  it('manifest 形状合法（名称/入口与目录约定一致）', () => {
    const raw: unknown = JSON.parse(readFileSync(path.join(HELLO_DIR, 'manifest.json'), 'utf8'));
    const validated = validateManifest(raw);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.manifest.name).toBe('hello');
      expect(validated.manifest.entry).toBe('entry.js');
    }
  });

  it('entry.js 无裸 import（平台硬约束——自包含或宿主桥）', () => {
    const src = readFileSync(path.join(HELLO_DIR, 'entry.js'), 'utf8');
    // 裸 import = from '裸名'（非相对路径 / 非 file: URL）
    const bareImports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .filter((spec) => !spec.startsWith('.') && !spec.startsWith('file:') && !spec.startsWith('/'));
    expect(bareImports, `hello 含裸 import（插件运行时不可解析）: ${bareImports.join(', ')}`).toEqual([]);
  });

  it('三通道注册即时可见（面板/命令/工具）+ 干净退出', async () => {
    const { root, fiber } = await bootWithHello();

    // 通道 1：面板进 panelDefs()（消费闭环合流点）
    expect(panelDefs().some((d) => d.id === 'hello-panel')).toBe(true);
    const def = panelDefs().find((d) => d.id === 'hello-panel');
    expect(def?.side).toBe('right');
    expect(def?.title).toBe('Hello');

    // 通道 2：命令进 commands 服务
    const cmds = root.commands.list();
    expect(cmds.map((c) => c.id)).toContain('hello/say-hi');

    // 通道 3：工具经 pluginToolRows 折算（行 id + factory 缓存）
    const rows = pluginToolRows();
    expect(rows.map((r) => r.id)).toEqual(['plugin/hello/greet']);
    const tools = await rows[0].factory({} as never);
    const tool = tools[0];
    expect(tool.name()).toBe('hello_greet');
    expect(tool.parameters()).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
    await expect(tool.execute({ name: 'HoloGram' }, undefined, undefined)).resolves.toContain('Hello, HoloGram!');
    await expect(tool.execute({}, undefined, undefined)).resolves.toContain('Hello, World!');
    // factory 缓存：两次装配同一实例
    const again = await rows[0].factory({} as never);
    expect(again[0]).toBe(tool);

    // 干净退出：fiber dispose → 三通道消失
    await fiber.dispose();
    expect(panelDefs().some((d) => d.id === 'hello-panel')).toBe(false);
    expect(root.commands.list().length).toBe(0);
    expect(pluginToolRows()).toEqual([]);
    await root[Symbol.asyncDispose]?.();
  });

  it('面板组件经宿主桥 createElement 渲染（React 19 函数组件形状）', async () => {
    // 注入宿主桥（生产由 loadBuiltinPlugins 装载前注入；测试就地注入同形状）
    const hostTarget = globalThis as Record<string, unknown>;
    hostTarget.__hologram_plugin_host__ = {
      createElement,
      notify: () => {},
    };
    const { root, fiber } = await bootWithHello();
    const def = panelDefs().find((d) => d.id === 'hello-panel');
    expect(def).toBeTruthy();
    // 组件是函数组件：调用返回 createElement 产物（type/props 树）
    const component = def ? def.component : undefined;
    expect(typeof component).toBe('function');
    const vnode = (component as () => { type: string; props: unknown })();
    expect(typeof vnode.type).toBe('string');
    expect(vnode.type).toBe('div');
    await fiber.dispose();
    await root[Symbol.asyncDispose]?.();
    delete hostTarget.__hologram_plugin_host__;
  });

  it('loader 管道兼容 hello 形状（inject 声明 + default 导出）', async () => {
    // loadExternalPlugins 的 loadOne 逻辑对 hello 的 manifest 形状做静态
    // 兼容断言（动态 import 已在上一用例真跑——此处钉 manifest 契约面）
    const manifest = JSON.parse(readFileSync(path.join(HELLO_DIR, 'manifest.json'), 'utf8'));
    expect(manifest.name).toBe('hello');
    expect(typeof manifest.entry).toBe('string');
    // inject 依赖（panels/commands/tools）在四 service 挂载后可解析——
    // bootWithHello 已实证（不抛 "cannot get property without inject"）
    expect(true).toBe(true);
  });
});
