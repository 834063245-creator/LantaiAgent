// SPDX-License-Identifier: MIT

// notes-app 范本守护 · loader 集成面（jsdom——与既有 plugin-loader 测试同
// 惯例：loader 牵全内置插件图，jsdom 是其原生环境；真 server 进程集成在
// tests/notes-app-example.test.ts 的 node 环境）：
//   - 装载即目录：dataDir ensure 以插件名调用；
//   - 窗口定义登记：app.entry → 资产通道 entryUrl（manifest 数据 → 注册表）；
//   - notes_open 走工具口端到端：manifest.tools 声明 + entry toolHandlers →
//     行 plugin/notes-app/notes_open → 执行调宿主桥 windows 设施开窗
//     （工具语义归插件——设施是宿主能力面非工具面）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { loadExternalPlugins, resetPluginRuntimeForTests } from '../src/plugins/loader';
import { validateManifest } from '../src/plugins/types';
import { usePluginStore } from '../src/state/plugin-store';
import { usePluginWindowStore } from '../src/state/plugin-window-store';

const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'plugins', 'notes-app');
const MANIFEST = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'manifest.json'), 'utf8')) as Record<string, unknown>;
const ORIGIN = 'http://127.0.0.1:14570/plugins';

/** 真 entry 模块导入：entry 在 src-ui 根外（examples/），file URL 会被 vite
 *  fs.allow 拒——自包含 ESM（零 import）经 data URL 装载，逐字节是范本真身。 */
async function importRealEntry(): Promise<Record<string, unknown>> {
  const src = readFileSync(join(EXAMPLE_DIR, 'entry.js'), 'utf8');
  const url = 'data:text/javascript;charset=utf-8;base64,' + Buffer.from(src, 'utf8').toString('base64');
  return await import(/* @vite-ignore */ url);
}

function routeTable(): Record<string, unknown> {
  return {
    [ORIGIN + '/']: ['notes-app'],
    [ORIGIN + '/plugins.json']: { disabled: [] },
    [ORIGIN + '/notes-app/manifest.json']: MANIFEST,
  };
}

/** mock fetch：真实 manifest 路由 + 真 entry 模块导入（范本全真装载）。
 *  根先挂组合层 service（notes-app 声明 tools/mcpServers/app——wrapper
 *  inject ['tools']，裸 Context 下 fiber PENDING、apply 静默不跑）。 */
async function loadNotesApp(pluginDataEnsure: (name: string) => Promise<string>): Promise<void> {
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  await loadExternalPlugins(root, {
    origin: ORIGIN,
    fetchImpl: async (url) => ({
      ok: url in routeTable(),
      json: async () => (url in routeTable() ? routeTable()[url] : null),
    }),
    // 入口 URL 自 2026-09-20（landmine H4）起带恒新版本号 `?v=`——按前缀判定产物寻址
    importModule: async (url) => (url.startsWith(ORIGIN + '/notes-app/entry.js') ? await importRealEntry() : {}),
    pluginDataEnsure,
  });
}

beforeEach(() => {
  resetPluginRuntimeForTests();
  usePluginWindowStore.getState().resetPluginWindowsForTests();
  usePluginStore.setState({ plugins: [] });
});

describe('notes-app 范本：loader 集成（装载即目录 + 工具口）', () => {
  it('装载：dataDir ensure 以插件名调用 + 窗口定义登记（entryUrl 资产通道寻址）', async () => {
    expect(validateManifest(MANIFEST).ok).toBe(true); // 真 manifest 过校验
    const ensureCalls: string[] = [];
    await loadNotesApp(async (name) => {
      ensureCalls.push(name);
      return '/data/notes-app';
    });
    expect(ensureCalls).toEqual(['notes-app']); // 装载即分配数据地盘
    expect(usePluginWindowStore.getState().defs['notes-app']).toMatchObject({
      entryUrl: ORIGIN + '/notes-app/app/index.html',
      mode: 'floating',
      title: '便签',
    });
    expect(pluginToolRows().some((r) => r.id === 'plugin/notes-app/notes_open')).toBe(true);
  });

  it('notes_open 执行 → 宿主桥 windows 设施开窗（工具语义归插件——设施非工具面）', async () => {
    const openSpy = vi.fn(() => 'notes-app#1');
    (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__ = {
      windows: { open: openSpy },
    };
    try {
      await loadNotesApp(async () => '/data/notes-app');
      const row = pluginToolRows().find((r) => r.id === 'plugin/notes-app/notes_open');
      expect(row).toBeDefined();
      const tools = await row?.factory({} as never);
      const out = await tools?.[0].execute({});
      expect(openSpy).toHaveBeenCalledWith('notes-app');
      expect(String(out)).toContain('便签窗口已打开（notes-app#1）');
    } finally {
      delete (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__;
    }
  });

  it('卸载收口：停用 notes-app → 窗口定义摘除（app 挂 ctx.effect 随 fiber dispose）', async () => {
    const { deactivateExternalPlugin } = await import('../src/plugins/loader');
    await loadNotesApp(async () => '/data/notes-app');
    expect(usePluginWindowStore.getState().defs['notes-app']).toBeDefined();
    await deactivateExternalPlugin('notes-app');
    expect(usePluginWindowStore.getState().defs['notes-app']).toBeUndefined();
  });
});
