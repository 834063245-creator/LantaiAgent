// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S4-1.5 消费闭环接线测试 — 设计件 §3 S4-1.5 验收：
//   1. 插件贡献面板在信号后出现在清单（panelDefs() 合流点 + bump 信号）；
//   2. 插件工具行折算正确（plugin/<id> 前缀 + factory 缓存实例 + dispose
//      清缓存）、撞名走装载期拒绝；
//   3. 插件命令贡献进 CommandPalette 清单（effectiveActions 折算面）；
//   4. hello 前身（mock 贡献）三通道机制全绿。
// llm 通道现状 = 方言收口已接线（createProvider 消费，见 provider-dialect.test）。

import { describe, expect, it } from 'vitest';
import type { Tool } from '../src/agent/tool';
import { panelDefs } from '../src/app/panels/panel-def';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { usePanelDefsStore } from '../src/state/panel-defs-store';

function probeTool(name: string, tag: string): Tool {
  return {
    name: () => name,
    description: () => 'probe ' + tag,
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => 'ok:' + tag,
  };
}

async function bootServices(): Promise<Context> {
  const root = new Context();
  const fiber = root.plugin(compositionServicesPlugin);
  await fiber;
  return root;
}

describe('S4-1.5 panels 合流点：panelDefs() + bump 信号', () => {
  it('无贡献 = 内置清单全等（零漂移）', async () => {
    const root = await bootServices();
    const defs = panelDefs();
    // V3b 起 paper 面板是 paperPlugin 贡献（本用例只 boot 四 service，无 paper）；
    // S3（2026-08-22）起常量面清空——settings 也走贡献（plugins/settings-plugin.ts）。
    expect(defs.map((d) => d.id)).toEqual([]);
    await root[Symbol.asyncDispose]?.();
  });

  it('注册面板贡献 → bump 信号 + 清单出现；dispose → bump + 清单消失', async () => {
    const root = await bootServices();
    const tick0 = usePanelDefsStore.getState().panelDefsTick;
    const dispose = root.panels.register({
      id: 'probe-panel',
      side: 'right',
      title: '探针面板',
      icon: 'probe',
      component: () => null,
    });
    // 注册 → 信号 bump（即时生效语义）
    expect(usePanelDefsStore.getState().panelDefsTick).toBe(tick0 + 1);
    expect(panelDefs().some((d) => d.id === 'probe-panel')).toBe(true);
    // S3（2026-08-22）：常量面已清空，「与内置同 id → 内置胜」路径不再可达
    // （settings/paper 均为贡献）；同 id 撞贡献 → 装载期拒绝（重复注册 throw）。
    // 内置胜语义在常量面重新有行之前保持潜伏，见 panel-def.ts 合流纪律注。
    const tick1 = usePanelDefsStore.getState().panelDefsTick;
    expect(() =>
      root.panels.register({
        id: 'probe-panel',
        side: 'right',
        title: '探针面板二',
        icon: 'probe',
        component: () => null,
      }),
    ).toThrow(/duplicate/);
    expect(usePanelDefsStore.getState().panelDefsTick).toBe(tick1); // 拒绝不 bump
    expect(panelDefs().filter((d) => d.id === 'probe-panel').length).toBe(1);
    dispose();
    // dispose → 信号 bump + 贡献消失
    expect(panelDefs().some((d) => d.id === 'probe-panel')).toBe(false);
    await root[Symbol.asyncDispose]?.();
  });

  it('无效贡献（缺 component）跳过不炸', async () => {
    const root = await bootServices();
    const dispose = root.panels.register({
      id: 'broken-panel',
      side: 'right',
      title: '坏贡献',
      icon: 'x',
      component: undefined as unknown as () => null,
    });
    expect(panelDefs().some((d) => d.id === 'broken-panel')).toBe(false);
    dispose();
    await root[Symbol.asyncDispose]?.();
  });
});

describe('S4-1.5 commands 合流点：贡献折算 + bump 信号', () => {
  it('注册命令贡献 → bump 信号；activeCommandContributions 可见', async () => {
    const root = await bootServices();
    const tick0 = usePanelDefsStore.getState().commandsTick;
    let fired = false;
    const dispose = root.commands.register({
      id: 'probe-cmd',
      label: '探针命令',
      group: '测试',
      shortcut: '/probe',
      action: { type: 'local', handler: () => (fired = true) },
    });
    expect(usePanelDefsStore.getState().commandsTick).toBe(tick0 + 1);
    const list = root.commands.list();
    expect(list.map((c) => c.id)).toContain('probe-cmd');
    dispose();
    expect(root.commands.list().length).toBe(0);
    await root[Symbol.asyncDispose]?.();
  });
});

describe('S4-1.5 tools 折算：pluginToolRows() + 实例缓存 + 撞名拒绝', () => {
  it('无贡献 = 空集（零漂移）', async () => {
    const root = await bootServices();
    expect(pluginToolRows()).toEqual([]);
    await root[Symbol.asyncDispose]?.();
  });

  it('贡献折算为 plugin/<id> 行；factory 缓存实例（两次装配同一 Tool 对象）', async () => {
    const root = await bootServices();
    let factoryCalls = 0;
    const dispose = root.tools.register({
      id: 'acme/probe',
      factory: () => {
        factoryCalls++;
        return probeTool('acme_probe', 'v1');
      },
    });
    const rows = pluginToolRows();
    expect(rows.map((r) => r.id)).toEqual(['plugin/acme/probe']);
    const a = await rows[0].factory({} as never);
    const b = await rows[0].factory({} as never);
    expect(b[0]).toBe(a[0]); // 同一实例（factory 只调一次）
    expect(factoryCalls).toBe(1);
    // dispose → 缓存清（重新注册后 factory 会再调）
    dispose();
    const dispose2 = root.tools.register({
      id: 'acme/probe',
      factory: () => {
        factoryCalls++;
        return probeTool('acme_probe', 'v2');
      },
    });
    const c = await pluginToolRows()[0].factory({} as never);
    expect(factoryCalls).toBe(2); // 缓存被 dispose 清掉——新贡献重新实例化
    expect(c[0].description()).toBe('probe v2');
    dispose2();
    await root[Symbol.asyncDispose]?.();
  });

  it('真正撞名（两个贡献产出同名 Tool）→ ToolRegistry 装载期拒绝', async () => {
    const { ToolRegistry } = await import('../src/agent/tool');
    const root = await bootServices();
    root.tools.register({ id: 'a/dupe', factory: () => probeTool('dupe_tool', 'a') });
    root.tools.register({ id: 'b/dupe', factory: () => probeTool('dupe_tool', 'b') });
    const reg = new ToolRegistry();
    let rejected = false;
    for (const row of pluginToolRows()) {
      for (const tool of await row.factory({} as never)) {
        try {
          reg.register(tool);
        } catch {
          rejected = true;
        }
      }
    }
    expect(rejected).toBe(true); // 同 Tool.name → duplicate throw（既有兜底）
    await root[Symbol.asyncDispose]?.();
  });
});

describe('S4-1.5 hello 前身：mock 贡献三通道机制（面板+命令+工具）', () => {
  it('一个 mock 插件经四 service 注册三通道贡献，全链路可观测', async () => {
    const root = await bootServices();
    // mock 插件 apply（hello 的形态：inject 声明四 service 依赖 + 三注册 +
    // disposer 归 ctx.effect——与外部插件 manifest 的 inject 语义同构）
    const plugin = {
      name: 'hello',
      inject: ['panels', 'commands', 'tools'],
      apply(ctx: Context) {
        ctx.effect(
          () =>
            ctx.panels.register({
              id: 'hello-panel',
              side: 'right',
              title: 'Hello',
              icon: 'agent',
              component: () => null,
            }),
          'hello-panel',
        );
        ctx.effect(
          () =>
            ctx.commands.register({
              id: 'hello/hello',
              label: 'Hello 命令',
              group: '插件',
              shortcut: '/hello',
              action: { type: 'local', handler: () => {} },
            }),
          'hello-command',
        );
        ctx.effect(
          () => ctx.tools.register({ id: 'hello/greet', factory: () => probeTool('hello_greet', 'hello') }),
          'hello-tool',
        );
      },
    };
    const fiber = root.plugin(plugin);
    await fiber;

    // 三通道全绿
    expect(panelDefs().some((d) => d.id === 'hello-panel')).toBe(true);
    expect(root.commands.list().map((c) => c.id)).toContain('hello/hello');
    const toolRows = pluginToolRows();
    expect(toolRows.map((r) => r.id)).toEqual(['plugin/hello/greet']);
    const tools = await toolRows[0].factory({} as never);
    expect(tools[0].name()).toBe('hello_greet');

    // 卸载（fiber dispose）→ 三通道干净退出
    await fiber.dispose();
    expect(panelDefs().some((d) => d.id === 'hello-panel')).toBe(false);
    expect(root.commands.list().length).toBe(0);
    expect(pluginToolRows()).toEqual([]);
    await root[Symbol.asyncDispose]?.();
  });
});
