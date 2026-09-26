// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 更新卡片（设置面板「关于」页 UpdateSection）显示行为测试——2026-09-26 可见性重构配套。
//
// 覆盖用户实际看得见的六种态：新版本面（版本 / 发布时间 / 来源 / 说明）、
// 下载中（有总量 → 百分比 + 速度 + 剩余时间；无总量 → 不确定条 + 已下载量）、
// 下载完成（等用户按安装，不偷偷装）、下载失败（说清续传限制）、自动检查开关。
// 直接渲染组件（不经整个 SettingsPanel）——状态编排走真实 update-store。

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../src/plugins/builtin/settings-domain/host';
import { UpdateSection } from '../../src/plugins/builtin/settings-domain/UpdateSection';
import { useUpdateStore } from '../../src/state/update-store';

const tick = () => new Promise((r) => setTimeout(r, 50));

const MB = 1024 * 1024;

function resetStore() {
  useUpdateStore.setState({
    status: 'idle',
    version: null,
    message: '',
    badgeDismissed: false,
    info: null,
    source: null,
    progress: null,
    errorStage: null,
    pending: null,
  });
}

describe('UpdateSection（设置面板更新卡片）', () => {
  let container: HTMLElement;
  let root: Root;
  let onAutoCheckChange: (enabled: boolean) => void;

  beforeEach(async () => {
    resetStore();
    onAutoCheckChange = vi.fn();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      createElement(UpdateSection, {
        currentVersion: '1.0.3',
        settings: { updates: { autoCheck: true } } as unknown as AppSettings,
        onAutoCheckChange,
      }),
    );
    await tick();
  });

  afterEach(() => {
    root?.unmount();
    resetStore();
    vi.restoreAllMocks();
  });

  it('有新版本：版本 / 发布时间 / 来源主机 / 直链 / 更新说明都在面上', async () => {
    useUpdateStore.setState({
      status: 'available',
      version: '1.1.0',
      info: {
        currentVersion: '1.0.3',
        version: '1.1.0',
        date: '2026-09-25T14:12:07Z',
        notes: '# Changelog\n\n- 修了个 bug',
      },
      source: {
        url: 'https://api.github.com/repos/o/r/releases/assets/2',
        host: 'api.github.com',
        signed: true,
      },
    });
    await tick();

    const text = container.textContent ?? '';
    expect(text).toContain('新版本 1.1.0');
    expect(text).toContain('当前版本 1.0.3');
    expect(text).toContain('api.github.com');
    expect(text).toContain('minisign');
    expect(text).toContain('修了个 bug'); // 更新说明（远端 notes 直出）
    expect(container.querySelector('.sp-upd-url')?.textContent).toContain('/releases/assets/2');
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toContain('下载更新');
  });

  it('下载中（有 Content-Length）：百分比 / 已下载 / 速度 / 剩余时间 + 可读进度条', async () => {
    useUpdateStore.setState({
      status: 'downloading',
      info: { currentVersion: '1.0.3', version: '1.1.0', date: null, notes: null },
      source: { url: null, host: 'api.github.com', signed: true },
      progress: {
        downloadedBytes: 61 * MB,
        totalBytes: 145 * MB,
        percent: 42.07,
        bytesPerSecond: 3.2 * MB,
        etaSeconds: 26,
      },
    });
    await tick();

    const text = container.textContent ?? '';
    expect(text).toContain('42.1%');
    expect(text).toContain('61.0 MB / 145.0 MB');
    expect(text).toContain('3.2 MB/s');
    expect(text).toContain('约 26 秒');
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('42');
    expect(bar?.querySelector('.sp-upd-bar-fill')?.textContent).toBe('');
    expect((bar?.querySelector('.sp-upd-bar-fill') as HTMLElement | null)?.style.width).toBe('42.07%');
  });

  it('下载中（服务端不给总量）：不假装百分比——不确定条 + 已下载量 + 说明', async () => {
    useUpdateStore.setState({
      status: 'downloading',
      info: { currentVersion: '1.0.3', version: '1.1.0', date: null, notes: null },
      source: { url: null, host: 'api.github.com', signed: false },
      progress: {
        downloadedBytes: 10240,
        totalBytes: null,
        percent: null,
        bytesPerSecond: null,
        etaSeconds: null,
      },
    });
    await tick();

    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuetext')).toBe('已下载 10.0 KB');
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false);
    expect(container.querySelector('.sp-upd-bar-fill')?.className).toContain('is-unknown');
    expect(container.textContent).toContain('10.0 KB');
    expect(container.textContent).toContain('更新器不支持断点续传');
  });

  it('下载完成：停在「立即安装并重启」——用户不按就不装', async () => {
    useUpdateStore.setState({
      status: 'downloaded',
      info: { currentVersion: '1.0.3', version: '1.1.0', date: null, notes: null },
      source: { url: null, host: 'api.github.com', signed: true },
      progress: {
        downloadedBytes: 145 * MB,
        totalBytes: 145 * MB,
        percent: 100,
        bytesPerSecond: null,
        etaSeconds: null,
      },
    });
    await tick();

    expect(container.textContent).toContain('下载完成 · 签名已校验');
    expect(container.textContent).toContain('145.0 MB');
    const install = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('立即安装并重启'));
    expect(install).toBeTruthy();

    const installSpy = vi.spyOn(useUpdateStore.getState(), 'installDownloaded').mockResolvedValue(undefined);
    install?.click();
    expect(installSpy).toHaveBeenCalledTimes(1);
  });

  it('下载失败：分阶段文案 + 已接收量 + 如实说断点续传限制 + 重试入口', async () => {
    useUpdateStore.setState({
      status: 'error',
      errorStage: 'download',
      message: 'connection reset',
      info: { currentVersion: '1.0.3', version: '1.1.0', date: null, notes: null },
      source: { url: null, host: 'api.github.com', signed: true },
      progress: {
        downloadedBytes: 512 * 1024,
        totalBytes: 145 * MB,
        percent: 0.3,
        bytesPerSecond: null,
        etaSeconds: null,
      },
    });
    await tick();

    const text = container.textContent ?? '';
    expect(text).toContain('下载失败：connection reset');
    expect(text).toContain('已接收 512.0 KB');
    expect(text).toContain('重试将从 0 开始');
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toContain('重新下载');
  });

  it('检查失败的文案与下载失败分开（不许都叫「更新失败」）', async () => {
    useUpdateStore.setState({ status: 'error', errorStage: 'check', message: 'offline' });
    await tick();
    expect(container.textContent).toContain('检查更新失败：offline');
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toContain('重试');
  });

  it('安装失败但句柄已失效：按钮退回「重试」，不谎称能重试安装（手上真有包才给重试安装）', async () => {
    useUpdateStore.setState({
      status: 'error',
      errorStage: 'install',
      message: '安装包句柄已失效，请重新下载',
      pending: null,
    });
    await tick();
    expect(container.textContent).toContain('安装失败：安装包句柄已失效，请重新下载');
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toContain('重试');
    expect(labels).not.toContain('重试安装');
  });

  it('自动检查开关：点击回报新值（保存仍由面板统一落盘）', async () => {
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.checked).toBe(true);
    box?.click();
    expect(onAutoCheckChange).toHaveBeenCalledWith(false);
  });
});
