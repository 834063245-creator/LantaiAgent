// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// office 活预览窗插件：**真实装载路径**守护（jsdom——loader 牵全内置插件图，jsdom 是其原生环境）。
// C 路改判后（2026-09-13）本插件只剩「活预览窗」一面：
//   · 真 manifest + 真 entry 经 loadExternalPlugins 装载（用户「设置→插件→安装目录」走的就是这条路）；
//   · 窗口定义登记 = 环回远端视图（kind remote / entryUrl 原样 / floating）；
//   · 工具行 plugin/office/office_preview_open 在册，执行调宿主桥 windows 设施开窗；
//   · **不再有 MCP 行**（plugin/office/mcp/* 必须为空——读写能力归内置 office 域工具）；
//   · 卸载收口：停用 → 窗口定义摘除 + 工具行消失。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { deactivateExternalPlugin, loadExternalPlugins, resetPluginRuntimeForTests } from '../src/plugins/loader';
import { usePluginStore } from '../src/state/plugin-store';
import { usePluginWindowStore } from '../src/state/plugin-window-store';

const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'plugins', 'office');
const MANIFEST = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'manifest.json'), 'utf8')) as Record<string, unknown>;
const ORIGIN = 'http://127.0.0.1:14570/plugins';

async function importRealEntry(): Promise<Record<string, unknown>> {
  const src = readFileSync(join(EXAMPLE_DIR, 'entry.js'), 'utf8');
  const url = 'data:text/javascript;charset=utf-8;base64,' + Buffer.from(src, 'utf8').toString('base64');
  return import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;
}

function routeTable(): Record<string, unknown> {
  return {
    [ORIGIN + '/']: ['office'],
    [ORIGIN + '/plugins.json']: { disabled: [] },
    [ORIGIN + '/office/manifest.json']: MANIFEST,
  };
}

async function loadOfficePlugin(): Promise<void> {
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  await loadExternalPlugins(root, {
    origin: ORIGIN,
    fetchImpl: async (url) => ({
      ok: url in routeTable(),
      json: async () => (url in routeTable() ? routeTable()[url] : null),
    }),
    // 入口 URL 自 2026-09-20（landmine H4）起带恒新版本号 `?v=`——按前缀判定产物寻址
    importModule: async (url) => (url.startsWith(ORIGIN + '/office/entry.js') ? await importRealEntry() : {}),
  });
}

beforeEach(() => {
  resetPluginRuntimeForTests();
  usePluginWindowStore.getState().resetPluginWindowsForTests();
  usePluginStore.setState({ plugins: [] });
});

describe('office 活预览窗插件：真实装载路径', () => {
  it('装载：窗口定义 = 环回远端视图 + 工具行在册 + **无 MCP 行**', async () => {
    await loadOfficePlugin();
    expect(usePluginWindowStore.getState().defs.office).toMatchObject({
      pluginName: 'office',
      entryUrl: 'http://127.0.0.1:26315/', // 原样声明值（不走资产前缀）
      kind: 'remote',
      mode: 'floating',
      title: 'Office 活预览',
    });
    const rows = pluginToolRows().map((r) => r.id);
    expect(rows).toContain('plugin/office/office_preview_open');
    // C 路改判：读写走内置 office 域工具，插件不再折算 MCP 工具行
    expect(rows.filter((id) => id.startsWith('plugin/office/mcp/'))).toEqual([]);
  });

  it('office_preview_open 执行 → 宿主桥 windows 设施开窗（工具语义归插件）', async () => {
    const openSpy = vi.fn(() => 'office#1');
    (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__ = { windows: { open: openSpy } };
    try {
      await loadOfficePlugin();
      const row = pluginToolRows().find((r) => r.id === 'plugin/office/office_preview_open');
      expect(row).toBeDefined();
      const tools = await row?.factory({} as never);
      const out = await tools?.[0].execute({});
      expect(openSpy).toHaveBeenCalledWith('office');
      expect(String(out)).toContain('Office 活预览窗已打开（office#1）');
      expect(String(out)).toContain('officecli watch'); // 失败自救指引
    } finally {
      delete (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__;
    }
  });

  it('卸载收口：停用 office → 窗口定义摘除 + 工具行消失', async () => {
    await loadOfficePlugin();
    expect(usePluginWindowStore.getState().defs.office).toBeDefined();
    await deactivateExternalPlugin('office');
    expect(usePluginWindowStore.getState().defs.office).toBeUndefined();
    expect(pluginToolRows().map((r) => r.id)).not.toContain('plugin/office/office_preview_open');
  });
});
