// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// plugin-prefs 测试：第一方禁用集 localStorage 持久化 + 毒化容忍 +
// 复位。jsdom 提供 localStorage；水合在模块导入期发生一次，故「重读磁盘」
// 类断言用 vi.resetModules + 动态 import 重建模块实例。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePluginPrefs } from '../src/state/plugin-prefs';

const KEY = 'lantai.pluginPrefs';

describe('plugin-prefs（第一方禁用集）', () => {
  beforeEach(() => {
    usePluginPrefs.getState().resetForTests();
  });

  it('初始空集；isDisabled 跟随 setDisabled', () => {
    expect(usePluginPrefs.getState().disabled).toEqual([]);
    expect(usePluginPrefs.getState().isDisabled('hologram/web-domain')).toBe(false);
    usePluginPrefs.getState().setDisabled('hologram/web-domain', true);
    expect(usePluginPrefs.getState().isDisabled('hologram/web-domain')).toBe(true);
    usePluginPrefs.getState().setDisabled('hologram/web-domain', false);
    expect(usePluginPrefs.getState().isDisabled('hologram/web-domain')).toBe(false);
  });

  it('持久化：写入落 localStorage；重建模块实例水合读回', async () => {
    usePluginPrefs.getState().setDisabled('hologram/paper-shell', true);
    usePluginPrefs.getState().setDisabled('hologram/space-demo', true);
    const raw = localStorage.getItem(KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw ?? '{}') as { disabled?: unknown };
    expect(parsed.disabled).toEqual(['hologram/paper-shell', 'hologram/space-demo']);
    // 重建模块实例（重新走 loadDisabled 水合）——模拟下次启动
    vi.resetModules();
    const fresh = await import('../src/state/plugin-prefs');
    expect(fresh.usePluginPrefs.getState().disabled).toEqual(['hologram/paper-shell', 'hologram/space-demo']);
  });

  it('毒化容忍（INVARIANTS #11）：坏 JSON / 非数组 / 非字符串元素 → 空集/过滤', async () => {
    vi.resetModules();
    localStorage.setItem(KEY, '{broken json');
    const m1 = await import('../src/state/plugin-prefs');
    expect(m1.usePluginPrefs.getState().disabled).toEqual([]);

    vi.resetModules();
    localStorage.setItem(KEY, JSON.stringify({ disabled: 'nope' }));
    const m2 = await import('../src/state/plugin-prefs');
    expect(m2.usePluginPrefs.getState().disabled).toEqual([]);

    vi.resetModules();
    localStorage.setItem(KEY, JSON.stringify({ disabled: ['ok', 42, null] }));
    const m3 = await import('../src/state/plugin-prefs');
    expect(m3.usePluginPrefs.getState().disabled).toEqual(['ok']);
  });

  it('去重：重复 setDisabled(true) 不产生重复条目', () => {
    usePluginPrefs.getState().setDisabled('hologram/web-domain', true);
    usePluginPrefs.getState().setDisabled('hologram/web-domain', true);
    expect(usePluginPrefs.getState().disabled).toEqual(['hologram/web-domain']);
  });

  it('resetForTests 清空 + 移除 localStorage', () => {
    usePluginPrefs.getState().setDisabled('hologram/web-domain', true);
    usePluginPrefs.getState().resetForTests();
    expect(usePluginPrefs.getState().disabled).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
