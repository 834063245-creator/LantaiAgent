// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// S1 插件数据目录（app shell 四件套 · 件 B）：schema 形状 + 装载即分配
// （wrapper ensure 挂接 / 失败隔离 / 缺省不分配）+ 宿主桥 fs 面注入。
// Rust 侧围栏与回收（越界拒绝、junction 逃逸、.trash 回收、卸载钩子）由
// src-tauri commands/plugin_data.rs cargo test 覆盖（plugin_assets 同款分工）。

import { beforeEach, describe, expect, it } from 'vitest';
import { Context } from '../src/cordis';
import { pluginDataFs } from '../src/plugins/data-fs';
import { loadBuiltinPlugins, loadExternalPlugins, resetPluginRuntimeForTests } from '../src/plugins/loader';
import { validateManifest } from '../src/plugins/types';
import { usePluginStore } from '../src/state/plugin-store';

const ORIGIN = 'http://127.0.0.1:14570/plugins';
const HELLO = { name: 'hello', version: '1.0.0', entry: 'entry.js' };

interface MockResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

function jsonResponse(body: unknown): MockResponse {
  return { ok: true, json: async () => body };
}

function notFound(): MockResponse {
  return { ok: false, json: async () => null };
}

/** 按 URL 精确路由的 mock fetch（未登记的 URL 一律 404）。 */
function mockFetch(routes: Record<string, unknown>): (url: string) => Promise<MockResponse> {
  return async (url: string) => (url in routes ? jsonResponse(routes[url]) : notFound());
}

describe('S1 数据目录：manifest.dataDir schema', () => {
  it('true / false / 缺省均合法（缺省与 false = 不分配不侵入）', () => {
    expect(validateManifest({ ...HELLO, dataDir: true }).ok).toBe(true);
    expect(validateManifest({ ...HELLO, dataDir: false }).ok).toBe(true);
    expect(validateManifest(HELLO).ok).toBe(true);
  });

  it('非布尔拒绝（字符串/数字是手误——错误不静默）', () => {
    expect(validateManifest({ ...HELLO, dataDir: 'true' }).ok).toBe(false);
    expect(validateManifest({ ...HELLO, dataDir: 1 }).ok).toBe(false);
  });
});

describe('S1 数据目录：装载即分配（wrapper ensure 挂接）', () => {
  beforeEach(() => {
    usePluginStore.setState({ plugins: [] });
    resetPluginRuntimeForTests();
  });

  it('dataDir:true → 装载期 ensure 以 manifest.name 调用一次，record active', async () => {
    const ensureCalls: string[] = [];
    await loadExternalPlugins(new Context(), {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: { ...HELLO, dataDir: true },
      }),
      importModule: async () => ({ default: { name: 'hello', apply() {} } }),
      pluginDataEnsure: async (name) => {
        ensureCalls.push(name);
        return '/data/hello';
      },
    });
    expect(ensureCalls).toEqual(['hello']);
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
  });

  it('ensure 失败 → error 记录（失败隔离 + 语境化错误，不拖累后续插件）', async () => {
    await loadExternalPlugins(new Context(), {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: { ...HELLO, dataDir: true },
      }),
      importModule: async () => ({ default: { name: 'hello', apply() {} } }),
      pluginDataEnsure: async () => {
        throw new Error('disk full');
      },
    });
    const record = usePluginStore.getState().plugins[0];
    expect(record?.status).toBe('error');
    expect(record?.error).toContain('分配失败');
    expect(record?.error).toContain('disk full');
  });

  it('缺省不分配：无 dataDir 声明 → ensure 不被调用', async () => {
    const ensureCalls: string[] = [];
    await loadExternalPlugins(new Context(), {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: HELLO,
      }),
      importModule: async () => ({ default: { name: 'hello', apply() {} } }),
      pluginDataEnsure: async (name) => {
        ensureCalls.push(name);
        return '/data/hello';
      },
    });
    expect(ensureCalls).toEqual([]);
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
  });

  it('dataDir:false 与缺省同义 → ensure 不被调用', async () => {
    const ensureCalls: string[] = [];
    await loadExternalPlugins(new Context(), {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: { ...HELLO, dataDir: false },
      }),
      importModule: async () => ({ default: { name: 'hello', apply() {} } }),
      pluginDataEnsure: async (name) => {
        ensureCalls.push(name);
        return '/data/hello';
      },
    });
    expect(ensureCalls).toEqual([]);
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
  });
});

describe('S1 数据目录：宿主桥 fs 面', () => {
  it('loadBuiltinPlugins 注入 fs 面（五方法在桥上，与 data-fs 真源同源）', () => {
    loadBuiltinPlugins(new Context());
    const host = (globalThis as { __lantai_plugin_host__?: { fs?: Record<string, unknown> } }).__lantai_plugin_host__;
    expect(host?.fs).toBeDefined();
    expect(host?.fs).toBe(pluginDataFs);
    for (const key of ['ensure', 'list', 'read', 'write', 'delete']) {
      expect(typeof host?.fs?.[key]).toBe('function');
    }
  });
});
