// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S4-1.5 React 渲染面合流点测试（补欠账：composition-consumption-wiring
// 只测了数据层 panelDefs()/折算函数——DockRail/DockPanel/CommandPalette
// 真正「渲染出插件贡献」从未验证。合流点在组件里接错（如 tick 忘了订阅、
// 按钮没接 dock 开合）时数据层测试全绿但 UI 是哑的——本文件钉渲染面）。
//
// 渲染环境：check-briefing.test.ts 同款（createRoot + DOM 断言 + bridge mock
// ——DockPanel 会挂载常驻内置面板，其 mount effects 可能触 rpc）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => mockRpc(...args),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandPalette } from '../src/app/CommandPalette';
import { DockRail } from '../src/app/DockRail';
import { DockPanel } from '../src/app/panels/DockPanel';
import { useShellStore } from '../src/app/shell-store';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { useDockStore } from '../src/state/dock-store';

/** 重置 dock 开合（不动其他 selector 状态）。 */
function resetDock(): void {
  useDockStore.setState({
    open: {
      timeline: false,
      hotspots: false,
      check: false,
      constraints: false,
      dataflow: false,
      settings: false,
      agents: false,
      tasks: false,
    },
  });
}

/** 插件面板组件（宿主桥无 JS 环境的兜底形态：直接 createElement）。 */
function ProbePanel() {
  return createElement('div', { 'data-testid': 'probe-panel-body' }, 'PROBE PANEL CONTENT');
}

/** 四 service 根 + 一个三通道 mock 插件（面板 + 命令 + 工具）。 */
async function bootWithProbePlugin(): Promise<{ root: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  const plugin = {
    name: 'render-probe',
    inject: ['panels', 'commands', 'tools'],
    apply(ctx: Context) {
      ctx.effect(
        () =>
          ctx.panels.register({
            id: 'probe-panel',
            side: 'right',
            title: '探针面板',
            icon: 'agent',
            component: ProbePanel,
          }),
        'probe-panel',
      );
      ctx.effect(
        () =>
          ctx.commands.register({
            id: 'render-probe/say',
            label: '渲染探针命令',
            group: '插件',
            shortcut: '/probe',
            action: { type: 'local', handler: () => {} },
          }),
        'probe-command',
      );
    },
  };
  const fiber = root.plugin(plugin);
  await fiber;
  return { root, fiber };
}

describe('S4-1.5 渲染面：DockRail（插件面板上轨道）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    resetDock();
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('{}');
  });

  function cleanup(): void {
    root.unmount();
    container.remove();
  }

  it('贡献面板的轨道按钮渲染出现；fiber dispose 后即时消失', async () => {
    const { root: svcRoot, fiber } = await bootWithProbePlugin();
    root.render(createElement(DockRail, { side: 'right' }));
    await vi.waitFor(() => {
      const btn = container.querySelector('button[title="探针面板"]');
      expect(btn).toBeTruthy();
    });
    // dispose → bump 信号 → 订阅组件重渲染 → 按钮消失
    await fiber.dispose();
    await vi.waitFor(() => {
      expect(container.querySelector('button[title="探针面板"]')).toBeNull();
    });
    await svcRoot[Symbol.asyncDispose]?.();
    cleanup();
  });

  it('插件面板按钮（无注册动作）→ 点击走 togglePanel 兜底（dock 开合翻转）', async () => {
    const { root: svcRoot, fiber } = await bootWithProbePlugin();
    root.render(createElement(DockRail, { side: 'right' }));
    await vi.waitFor(() => {
      expect(container.querySelector('button[title="探针面板"]')).toBeTruthy();
    });
    (container.querySelector('button[title="探针面板"]') as HTMLButtonElement).click();
    // React 18 事件 → 状态更新需要 flush；vi.waitFor 等到 dock 翻开
    await vi.waitFor(() => {
      expect(useDockStore.getState().open['probe-panel']).toBe(true);
    });
    await fiber.dispose();
    await svcRoot[Symbol.asyncDispose]?.();
    cleanup();
  });

  it('左侧轨道不含右侧贡献（side 过滤）', async () => {
    const { root: svcRoot, fiber } = await bootWithProbePlugin();
    root.render(createElement(DockRail, { side: 'left' }));
    await vi.waitFor(() => {
      expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(0);
    });
    expect(container.querySelector('button[title="探针面板"]')).toBeNull();
    await fiber.dispose();
    await svcRoot[Symbol.asyncDispose]?.();
    cleanup();
  });
});

describe('S4-1.5 渲染面：DockPanel（插件面板组件实际挂载）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    resetDock();
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('{}');
  });

  function cleanup(): void {
    root.unmount();
    container.remove();
  }

  it('贡献组件渲染出内容；dispose 后卸载', async () => {
    const { root: svcRoot, fiber } = await bootWithProbePlugin();
    root.render(createElement(DockPanel));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="probe-panel-body"]')?.textContent).toBe('PROBE PANEL CONTENT');
    });
    await fiber.dispose();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="probe-panel-body"]')).toBeNull();
    });
    await svcRoot[Symbol.asyncDispose]?.();
    cleanup();
  });
});

describe('S4-1.5 渲染面：CommandPalette（命令贡献可见 + 可执行）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useShellStore.setState({ paletteOpen: true });
    resetDock();
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('{}');
  });

  function cleanup(): void {
    root.unmount();
    container.remove();
    useShellStore.setState({ paletteOpen: false });
  }

  it('命令贡献出现在面板列表（分组「插件」）', async () => {
    const { root: svcRoot, fiber } = await bootWithProbePlugin();
    root.render(createElement(CommandPalette));
    await vi.waitFor(() => {
      expect(container.textContent).toContain('渲染探针命令');
    });
    expect(container.textContent).toContain('插件');
    await fiber.dispose();
    await svcRoot[Symbol.asyncDispose]?.();
    cleanup();
  });

  it('点击命令贡献行 → local handler 执行 + 面板关闭', async () => {
    let fired = 0;
    const svcRoot = new Context();
    await svcRoot.plugin(compositionServicesPlugin);
    const plugin = {
      name: 'cmd-probe',
      inject: ['commands'],
      apply(ctx: Context) {
        ctx.effect(
          () =>
            ctx.commands.register({
              id: 'cmd-probe/fire',
              label: '点击探针',
              group: '插件',
              shortcut: '/fire',
              action: { type: 'local', handler: () => fired++ },
            }),
          'cmd-fire',
        );
      },
    };
    const fiber = svcRoot.plugin(plugin);
    await fiber;
    root.render(createElement(CommandPalette));
    await vi.waitFor(() => {
      expect(container.textContent).toContain('点击探针');
    });
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('点击探针'));
    expect(row).toBeTruthy();
    row?.click();
    await vi.waitFor(() => {
      expect(fired).toBe(1);
      expect(useShellStore.getState().paletteOpen).toBe(false);
    });
    await fiber.dispose();
    await svcRoot[Symbol.asyncDispose]?.();
    cleanup();
  });
});
