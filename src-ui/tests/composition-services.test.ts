// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 组合层四 service（S1-1）单元测试：注册 → disposer / 重名装载期拒绝 /
// 陈旧性守卫 / 组合序 / compositionServicesPlugin 挂根 Context。
// 语义基线：与 ToolRegistry.register 的 disposer 契约对齐（AGENTS.md §6 资源两原语）。

import { describe, expect, it } from 'vitest';
import {
  type CommandContribution,
  CommandsService,
  compositionServicesPlugin,
  type PanelContribution,
  PanelsService,
  type ProviderContribution,
  ProvidersService,
  type ToolContribution,
  ToolsService,
} from '../src/composition/services';
import { Context } from '../src/cordis';

function probeTool() {
  return {
    name: () => 'probe-tool',
    description: () => 'probe',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => 'ok',
  };
}

const PANEL: PanelContribution = {
  id: 'probe-panel',
  side: 'right',
  title: '探针面板',
  icon: 'probe',
  component: () => null,
};

const COMMAND: CommandContribution = {
  id: 'probe-command',
  label: '探针命令',
  group: '测试',
  shortcut: '/probe',
  action: { type: 'local', handler: () => {} },
};

const TOOL: ToolContribution = { id: 'probe/tool', factory: probeTool };

const PROVIDER: ProviderContribution = { id: 'probe/provider', factory: () => ({ kind: 'probe' }) };

describe('四 service 装载（compositionServicesPlugin 挂根 Context）', () => {
  it('挂载后 ctx.panels/commands/tools/providers 四服务可解析', async () => {
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    expect(root.panels).toBeInstanceOf(PanelsService);
    expect(root.commands).toBeInstanceOf(CommandsService);
    expect(root.tools).toBeInstanceOf(ToolsService);
    expect(root.providers).toBeInstanceOf(ProvidersService);
    await fiber.dispose();
  });

  it('服务随挂载 fiber dispose 注销（provide 语义）', async () => {
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    expect(root.reflect.get('panels')).toBeDefined();
    await fiber.dispose();
    expect(root.reflect.get('panels')).toBeUndefined();
  });
});

describe('注册 → disposer 契约（四 service 结构同构，逐个钉住）', () => {
  it('panels：register → list/get 可见 → dispose 后清空；disposer 幂等', async () => {
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    const dispose = root.panels.register(PANEL);
    expect(root.panels.get('probe-panel')).toBe(PANEL);
    expect(root.panels.list()).toEqual([PANEL]);
    dispose();
    dispose(); // 幂等
    expect(root.panels.get('probe-panel')).toBeUndefined();
    expect(root.panels.list()).toEqual([]);
    await fiber.dispose();
  });

  it('commands：同契约', async () => {
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    const dispose = root.commands.register(COMMAND);
    expect(root.commands.get('probe-command')).toBe(COMMAND);
    dispose();
    expect(root.commands.get('probe-command')).toBeUndefined();
    await fiber.dispose();
  });

  it('tools：同契约 + factory 不主动调用（零副作用注册）', async () => {
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    let factoryCalled = false;
    const tool: ToolContribution = {
      id: 'probe/lazy',
      factory: () => {
        factoryCalled = true;
        return probeTool();
      },
    };
    const dispose = root.tools.register(tool);
    expect(factoryCalled).toBe(false); // 注册不实例化——实例化时机是装配方的事
    expect(root.tools.get('probe/lazy')).toBe(tool);
    dispose();
    expect(root.tools.get('probe/lazy')).toBeUndefined();
    await fiber.dispose();
  });

  it('providers：同契约', async () => {
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    const dispose = root.providers.register(PROVIDER);
    expect(root.providers.get('probe/provider')).toBe(PROVIDER);
    dispose();
    expect(root.providers.get('probe/provider')).toBeUndefined();
    await fiber.dispose();
  });
});

describe('重名装载期拒绝 + 陈旧性守卫（错误不静默宪法）', () => {
  it('同 id 重复注册 throw，不静默覆盖', async () => {
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    const first = root.tools.register(TOOL);
    expect(() => root.tools.register(TOOL)).toThrow('duplicate contribution id "probe/tool"');
    first();
    // 删掉后同 id 可重注册（拒绝的是共存，不是名字本身）
    const second = root.tools.register(TOOL);
    expect(root.tools.get('probe/tool')).toBe(TOOL);
    second();
    await fiber.dispose();
  });

  it('陈旧 disposer 不误删后注册的同名行', async () => {
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    const stale = root.panels.register(PANEL);
    stale();
    const fresh = root.panels.register(PANEL);
    stale(); // 陈旧 disposer 再调——不得删掉 fresh 注册
    expect(root.panels.get('probe-panel')).toBe(PANEL);
    fresh();
    expect(root.panels.get('probe-panel')).toBeUndefined();
    await fiber.dispose();
  });
});

describe('组合序（前缀缓存语义的地基）', () => {
  it('list() 序 = 注册序（数组序），不受 get 干扰', async () => {
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    const a = root.commands.register({ ...COMMAND, id: 'cmd-a', shortcut: '/a' });
    const b = root.commands.register({ ...COMMAND, id: 'cmd-b', shortcut: '/b' });
    root.commands.get('cmd-b');
    root.commands.get('cmd-a');
    expect(root.commands.list().map((c) => c.id)).toEqual(['cmd-a', 'cmd-b']);
    a();
    expect(root.commands.list().map((c) => c.id)).toEqual(['cmd-b']);
    b();
    expect(root.commands.list()).toEqual([]);
    await fiber.dispose();
  });
});

describe('外部插件视角：inject 四服务名可解析（manifest 依赖装载期校验通路）', () => {
  it('compositionServicesPlugin 先装载 → 后续插件的 inject 校验通过', async () => {
    const root = new Context();
    // 第一方表引导（与 loader.loadBuiltinPlugins 同序）
    const servicesFiber = root.plugin(compositionServicesPlugin);
    await servicesFiber;
    // 外部插件形状：inject 声明四服务，apply 里读 ctx.tools
    const externalPlugin = {
      name: 'probe/external',
      inject: ['tools', 'panels'],
      apply(ctx: Context) {
        const dispose = ctx.tools.register(TOOL);
        // effect 回调是 init 函数，返回 disposer（cordis effect 契约）
        ctx.effect(() => dispose, 'probe-external-tools');
      },
    };
    const fiber = root.plugin(externalPlugin);
    await fiber;
    expect(root.tools.get('probe/tool')).toBe(TOOL);
    // 外部插件 fiber dispose → 其注册的行随之清理（ctx.effect 挂在插件 fiber 上）
    await fiber.dispose();
    expect(root.tools.get('probe/tool')).toBeUndefined();
    await servicesFiber.dispose();
  });
});
