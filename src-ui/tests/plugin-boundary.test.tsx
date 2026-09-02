// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 插件渲染面错误边界（保险丝 b，2026-09-03 生产事故立法）：
// 起因——产物与 exe 版本偏斜 → 插件贡献组件渲染期 TypeError → React 整树
// 卸载（应用此前零错误边界）。判据（用户操作序列式，不写实现形状）：
//   1. 子组件渲染抛错 → 边界捕获，宿主树存活，崩溃面显示标签 + 错误首行
//   2. 重试清错误态 → 子树重挂；再崩再捕获（不无限循环）
//   3. 正常子组件直通（零侵入）
//   4. 接线在册：面板槽 / 覆盖层槽 / 块渲染器三处挂边界 + host 三处同步
// 渲染 = 真实 react-dom createRoot（paper-streaming-fade 同款范式）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginBoundary } from '../src/app/PluginBoundary';

const SRC = join(__dirname, '..', 'src');

/** 只崩一次的组件（重试后恢复——验证重挂语义）。 */
let boomArmed = true;
function BoomOnce(): React.ReactNode {
  if (boomArmed) throw new Error('skew boom: groupWorkUnits is not a function');
  return <div id="recovered">恢复</div>;
}

function AlwaysBoom(): React.ReactNode {
  throw new Error('permanent boom');
}

describe('PluginBoundary（保险丝 b——渲染期崩溃隔离）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    boomArmed = true;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
  });

  it('子组件渲染抛错 → 边界捕获：崩溃面显示标签 + 错误首行，宿主不卸载', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      root?.render(
        <div id="host">
          <PluginBoundary label="面板 hologram/paper-shell">
            <AlwaysBoom />
          </PluginBoundary>
        </div>,
      );
    });
    // 宿主存活（此前这类错误直接卸整树——事故签名）
    expect(container?.querySelector('#host')).toBeTruthy();
    // 崩溃面：标签 + 错误首行 + 重试钮
    expect(container?.textContent).toContain('面板 hologram/paper-shell 渲染崩溃');
    expect(container?.textContent).toContain('permanent boom');
    expect(container?.querySelector('button')?.textContent).toContain('重试');
    errSpy.mockRestore();
  });

  it('重试清错误态 → 子树重挂：崩溃一次的组件恢复显示', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      root?.render(
        <PluginBoundary label="测试格">
          <BoomOnce />
        </PluginBoundary>,
      );
    });
    expect(container?.textContent).toContain('渲染崩溃');
    boomArmed = false;
    act(() => {
      container?.querySelector('button')?.click();
    });
    expect(container?.textContent).toContain('恢复');
    expect(container?.textContent).not.toContain('渲染崩溃');
    errSpy.mockRestore();
  });

  it('重试后再崩 → 再捕获（崩溃面复现，无无限循环）', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      root?.render(
        <PluginBoundary label="测试格">
          <AlwaysBoom />
        </PluginBoundary>,
      );
    });
    act(() => {
      container?.querySelector('button')?.click();
    });
    expect(container?.textContent).toContain('渲染崩溃');
    expect(container?.textContent).toContain('permanent boom');
    errSpy.mockRestore();
  });

  it('正常子组件直通渲染（零侵入）', () => {
    act(() => {
      root?.render(
        <PluginBoundary label="直通">
          <div id="ok">好的</div>
        </PluginBoundary>,
      );
    });
    expect(container?.querySelector('#ok')?.textContent).toBe('好的');
  });
});

describe('PluginBoundary 接线在册（源级钉——三处挂载点 + host 三处同步）', () => {
  it('面板槽（DockPanel）挂边界；覆盖层槽与块渲染器（PaperPanel）挂边界', () => {
    const dock = readFileSync(join(SRC, 'app', 'panels', 'DockPanel.tsx'), 'utf8');
    expect(dock).toContain('PluginBoundary');
    expect(dock).toContain('<C />');
    const paper = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx'), 'utf8');
    // 正则形态：字符串字面量含 ${ 会触发 noTemplateCurlyInString
    expect(paper).toMatch(/label=\{`块 \$\{block\.kind\}`\}/);
    expect(paper).toMatch(/label=\{`覆盖层 \$\{def\.id\}`\}/);
    expect(paper).toMatch(/label=\{`边缘层 \$\{def\.id\}`\}/);
  });

  it('host 三处同步：host.ts 导出 / host.aliased 镜像 / host-modules faceDeps 在册', () => {
    const hostTs = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'host.ts'), 'utf8');
    expect(hostTs).toContain('PluginBoundary');
    const aliased = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'host.aliased.ts'), 'utf8');
    expect(aliased).toContain('PluginBoundary');
    const hostModules = readFileSync(join(SRC, 'plugins', 'builtin', 'host-modules.ts'), 'utf8');
    expect(hostModules).toContain('PluginBoundary');
  });
});
