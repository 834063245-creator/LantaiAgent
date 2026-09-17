// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ProviderSettings.headers（2026-09-17）设置边界：
//   写侧 saveSettings 原样保留；读侧 loadSettings 容忍毒化（坏条目丢弃 + warn，
//   合法条目保留），与 INVARIANTS #11「读取容忍毒化数据」同款纪律。

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSettings, saveSettings } from '../src/settings';

const STORAGE_KEY = 'hologram_settings';

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('headers 设置边界', () => {
  it('保存 → 读取往返保留请求头', () => {
    const s = loadSettings();
    s.providers[0].headers = { 'x-opencode-session': 'sess-1' };
    saveSettings(s);
    expect(loadSettings().providers[0].headers).toEqual({ 'x-opencode-session': 'sess-1' });
  });

  it('毒化数据：坏条目丢弃 + warn，合法条目保留', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeProvider: 'custom',
        providers: [
          {
            kind: 'openai',
            name: 'custom',
            apiKey: '',
            baseUrl: 'https://x.example/v1',
            model: 'm1',
            headers: { 'x-ok': 'v', 'bad name': 'v', 'x-num': 42, 'x-ok2': '' },
          },
        ],
      }),
    );
    const s = loadSettings();
    expect(s.providers[0].headers).toEqual({ 'x-ok': 'v', 'x-ok2': '' });
    expect(warn).toHaveBeenCalled();
  });

  it('毒化数据：headers 整体不是对象 → 字段清除，不崩', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeProvider: 'custom',
        providers: [
          {
            kind: 'openai',
            name: 'custom',
            apiKey: '',
            baseUrl: 'https://x.example/v1',
            model: 'm1',
            headers: 'oops',
          },
        ],
      }),
    );
    const s = loadSettings();
    expect(s.providers[0].headers).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
