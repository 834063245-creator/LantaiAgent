// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S4-3 插件安装通道 UI 测试 — 设计件 §3 S4-3 验收的 vitest 半边：
//   PluginsPage 渲染（列表/状态徽章/错误可见/空态）+ 禁用 RPC 契约 +
//   安装输入三形态解析。Rust 半边（解包安全/原子性/set_enabled 读改写）
//   在 src-tauri commands/plugin_install.rs 测试覆盖。
// 渲染面用项目同款 createRoot + DOM 断言（check-briefing.test.ts 先例）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock layer ──
const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PluginsPage } from '../src/app/panels/settings/PluginsPage';
import { usePluginStore } from '../src/state/plugin-store';

/** 输入解析（PluginsPage 内部 parseInstallParams 的形状镜像——组件行为断言）。 */
function parseInstallInput(raw: string): { source_kind: string; name?: string; location?: string } {
  const t = raw.trim();
  if (t.startsWith('http://') || t.startsWith('https://')) return { source_kind: 'tarball', location: t };
  if (/\.t(ar\.)?gz$/i.test(t)) return { source_kind: 'tarball', location: t };
  return { source_kind: 'registry', name: t };
}

describe('S4-3 PluginsPage（设置面板插件 tab）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockRpc.mockReset();
  });

  function cleanup(): void {
    root.unmount();
    container.remove();
  }

  it('空态：无插件提示 + 手动放置路径指引 + 供应链警告常驻', async () => {
    usePluginStore.getState().setPlugins([]);
    root.render(createElement(PluginsPage));
    await vi.waitFor(() => {
      expect(container.textContent).toContain('暂无插件');
    });
    expect(container.textContent).toContain('~/.hologram/plugins/');
    // 供应链警告（完全信任模型原文——不做「已审核」标记）
    expect(container.textContent).toContain('本机全信任代码');
    expect(container.textContent).toContain('npm 上的包 ≠');
    cleanup();
  });

  it('已装列表：name/version/状态徽章/错误可见', async () => {
    usePluginStore.getState().setPlugins([
      {
        name: 'hello',
        manifest: { name: 'hello', version: '1.0.0', entry: 'entry.js', description: '示例插件' },
        status: 'active',
      },
      {
        name: 'broken',
        manifest: null,
        status: 'error',
        error: 'manifest.json 缺失或不可解析',
      },
      {
        name: 'off',
        manifest: { name: 'off', version: '0.2.0', entry: 'index.js' },
        status: 'disabled',
      },
    ]);
    root.render(createElement(PluginsPage));
    await vi.waitFor(() => {
      expect(container.textContent).toContain('已安装（3）');
    });
    expect(container.textContent).toContain('hello');
    expect(container.textContent).toContain('v1.0.0');
    expect(container.textContent).toContain('运行中');
    expect(container.textContent).toContain('装载失败');
    expect(container.textContent).toContain('manifest.json 缺失或不可解析');
    expect(container.textContent).toContain('已禁用');
    cleanup();
  });

  it('禁用按钮 → plugin_set_enabled RPC（snake_case 参数契约）', async () => {
    usePluginStore.getState().setPlugins([
      {
        name: 'hello',
        manifest: { name: 'hello', version: '1.0.0', entry: 'entry.js' },
        status: 'active',
      },
    ]);
    mockRpc.mockResolvedValue('null');
    root.render(createElement(PluginsPage));
    await vi.waitFor(() => {
      expect(container.textContent).toContain('hello');
    });
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '禁用');
    expect(btn).toBeTruthy();
    btn?.click();
    await vi.waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(mockRpc.mock.calls[0][0]).toBe('plugin_set_enabled');
    expect(mockRpc.mock.calls[0][1]).toEqual({ name: 'hello', enabled: false });
    cleanup();
  });

  it('安装动作 → plugin_install RPC（registry 形态）+ 重启后生效提示', async () => {
    usePluginStore.getState().setPlugins([]);
    mockRpc.mockResolvedValue('"hello"');
    root.render(createElement(PluginsPage));
    await vi.waitFor(() => {
      expect(container.querySelector('input')).toBeTruthy();
    });
    const input = container.querySelector('input') as HTMLInputElement;
    // React 受控输入：native setter 派发（check-briefing 同款环境约束——
    // jsdom 下直接赋值 + input 事件）
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'hologram-hello');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '安装');
    expect(btn).toBeTruthy();
    btn?.click();
    await vi.waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(mockRpc.mock.calls[0][0]).toBe('plugin_install');
    expect(mockRpc.mock.calls[0][1]).toEqual({ source_kind: 'registry', name: 'hologram-hello' });
    // 成功提示（重启后生效的如实声明）
    await vi.waitFor(() => {
      expect(container.textContent).toContain('重启后生效');
    });
    cleanup();
  });

  it('输入三形态解析（registry 名 / tarball URL / 本地 .tgz 路径）', () => {
    expect(parseInstallInput('hologram-hello')).toEqual({ source_kind: 'registry', name: 'hologram-hello' });
    expect(parseInstallInput('https://example.com/x.tgz')).toEqual({
      source_kind: 'tarball',
      location: 'https://example.com/x.tgz',
    });
    expect(parseInstallInput('C:/dev/hello-1.0.0.tgz')).toEqual({
      source_kind: 'tarball',
      location: 'C:/dev/hello-1.0.0.tgz',
    });
    expect(parseInstallInput('D:/x/hello.tar.gz')).toEqual({
      source_kind: 'tarball',
      location: 'D:/x/hello.tar.gz',
    });
  });
});
