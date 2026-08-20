// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 插件内核（WO-S0B）单元测试：manifest 校验 / 失败隔离 / disabled 跳过 / fiber dispose。
// loader 的 fetch 与 dynamic import 均为注入面（URL 注入 mock）；
// Rust 侧通道行为（遍历防护 / MIME / 404 / junction）由 src-tauri 的
// plugin_assets cargo test 覆盖。

import { beforeEach, describe, expect, it } from 'vitest';
import { Context } from '../src/cordis';
import { loadExternalPlugins } from '../src/plugins/loader';
import { PluginManifestSchema, validateManifest } from '../src/plugins/types';
import { usePluginStore } from '../src/state/plugin-store';

const ORIGIN = 'http://127.0.0.1:14570/plugins';

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

const HELLO_MANIFEST = { name: 'hello', version: '1.0.0', entry: 'entry.js' };
const BAD_MANIFEST = { name: 'bad', version: '1.0.0', entry: 'entry.js' };

describe('manifest 校验（zod 单一来源）', () => {
  it('合法 manifest 通过', () => {
    expect(PluginManifestSchema.safeParse(HELLO_MANIFEST).success).toBe(true);
    const v = validateManifest(HELLO_MANIFEST);
    expect(v.ok).toBe(true);
  });

  it('缺 name / 坏 version / 坏 entry / 坏 name 全部拒绝', () => {
    expect(validateManifest({ version: '1.0.0', entry: 'entry.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: 'latest', entry: 'entry.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: '1.0.0', entry: '/abs/entry.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: '1.0.0', entry: '../escape.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: '1.0.0', entry: 'style.css' }).ok).toBe(false);
    expect(validateManifest({ name: 'Hello!', version: '1.0.0', entry: 'entry.js' }).ok).toBe(false);
    expect(validateManifest('not-an-object').ok).toBe(false);
  });
});

describe('loadExternalPlugins（失败隔离铁律）', () => {
  beforeEach(() => {
    usePluginStore.setState({ plugins: [] });
  });

  it('两个插件一个 import 抛错 → 另一个 active，store 有 error 记录', async () => {
    const root = new Context();
    const importCalls: string[] = [];
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello', 'bad'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
        [ORIGIN + '/bad/manifest.json']: BAD_MANIFEST,
      }),
      importModule: async (url: string) => {
        importCalls.push(url);
        if (url.endsWith('bad/entry.js')) throw new Error('disk boom');
        return { default: { name: 'hello', apply() {} } };
      },
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(2);
    expect(plugins.find((p) => p.name === 'hello')?.status).toBe('active');
    const bad = plugins.find((p) => p.name === 'bad');
    expect(bad?.status).toBe('error');
    expect(bad?.error).toContain('disk boom');
    expect(importCalls).toHaveLength(2);
  });

  it('apply 抛错 → error 记录（cordis fiber await reject）', async () => {
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule: async () => ({
        default: {
          name: 'hello',
          apply() {
            throw new Error('apply boom');
          },
        },
      }),
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.status).toBe('error');
    expect(plugins[0]?.error).toContain('apply boom');
  });

  it('disabled 跳过：plugins.json 列出 → 不 import，store 记 disabled', async () => {
    const root = new Context();
    const importModule = async (url: string): Promise<Record<string, unknown>> => {
      throw new Error('不应被调用: ' + url);
    };
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: ['hello'] },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule,
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.status).toBe('disabled');
  });

  it('inject 缺失 → error 记录（装载期存在性校验）', async () => {
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: { ...HELLO_MANIFEST, inject: ['nonexistent-service'] },
      }),
      importModule: async () => {
        throw new Error('不应被调用');
      },
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins[0]?.status).toBe('error');
    expect(plugins[0]?.error).toContain('nonexistent-service');
  });

  it('manifest 缺失 / 校验失败 → error 记录（不 import）', async () => {
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['ghost', 'broken'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/broken/manifest.json']: { name: 'broken', version: 'x', entry: 'entry.js' },
      }),
      importModule: async () => {
        throw new Error('不应被调用');
      },
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(2);
    expect(plugins.find((p) => p.name === 'ghost')?.error).toContain('缺失');
    expect(plugins.find((p) => p.name === 'broken')?.error).toContain('校验失败');
  });

  it('通道索引不可用 → loader 不 reject、store 不变', async () => {
    const root = new Context();
    await expect(loadExternalPlugins(root, { origin: ORIGIN, fetchImpl: mockFetch({}) })).resolves.toBeUndefined();
    expect(usePluginStore.getState().plugins).toEqual([]);
  });
});

describe('fiber 生命周期（cordis，workspace-fiber 测试同款模式）', () => {
  it('root.plugin(obj) 注册的 effect 在 fiber dispose 后清理', async () => {
    const root = new Context();
    const events: string[] = [];
    const fiber = root.plugin({
      name: 'probe',
      apply(ctx) {
        ctx.effect(() => {
          events.push('setup');
          return () => {
            events.push('dispose');
          };
        }, 'probe');
      },
    });
    await fiber;
    expect(events).toEqual(['setup']);
    await fiber.dispose();
    expect(events).toEqual(['setup', 'dispose']);
  });

  it('apply 抛错 → await root.plugin() reject（装载期可捕获，进 store）', async () => {
    const root = new Context();
    const fiber = root.plugin({
      name: 'bad',
      apply() {
        throw new Error('apply boom');
      },
    });
    await expect(Promise.resolve(fiber)).rejects.toThrow('apply boom');
  });
});
