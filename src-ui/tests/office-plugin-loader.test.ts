// office 载体插件 · **真实装载路径**守护（jsdom——loader 牵全内置插件图，jsdom 是其原生环境）：
// 对位 notes-app-loader.test.ts 的同款套路，但覆盖本插件独有的三面组合
// （app.url 环回远端视图 + 工具口开窗 + MCP 受治进程 三者并存）：
//   - 真 manifest + 真 entry 经 loadExternalPlugins 装载（用户「设置→插件→安装目录」走的就是这条路）；
//   - 窗口定义登记 = **环回远端视图**（kind remote / entryUrl 原样 / floating）；
//   - office_preview_open 工具口端到端：manifest.tools 声明 + entry toolHandlers →
//     行 plugin/office/office_preview_open → 执行调宿主桥 windows 设施开窗；
//   - MCP 行 plugin/office/mcp/office 在册（受治 lazy——**不调 factory 就不起进程**，
//     真进程语义在 tests/office-plugin-example.test.ts 覆盖）；
//   - 卸载收口：停用 → 窗口定义摘除 + 工具行消失。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { deactivateExternalPlugin, loadExternalPlugins, resetPluginRuntimeForTests } from '../src/plugins/loader';
import { validateManifest } from '../src/plugins/types';
import { usePluginStore } from '../src/state/plugin-store';
import { usePluginWindowStore } from '../src/state/plugin-window-store';

const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'plugins', 'office');
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
    [ORIGIN + '/']: ['office'],
    [ORIGIN + '/plugins.json']: { disabled: [] },
    [ORIGIN + '/office/manifest.json']: MANIFEST,
  };
}

/** 真范本全真装载（根先挂组合层 service：本插件声明 tools/app/mcpServers，
 *  裸 Context 下 wrapper 的 inject ['tools'] 不解析、apply 静默不跑）。 */
async function loadOfficePlugin(): Promise<void> {
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  await loadExternalPlugins(root, {
    origin: ORIGIN,
    fetchImpl: async (url) => ({
      ok: url in routeTable(),
      json: async () => (url in routeTable() ? routeTable()[url] : null),
    }),
    importModule: async (url) => (url === ORIGIN + '/office/entry.js' ? await importRealEntry() : {}),
  });
}

beforeEach(() => {
  resetPluginRuntimeForTests();
  usePluginWindowStore.getState().resetPluginWindowsForTests();
  usePluginStore.setState({ plugins: [] });
});

describe('office 载体插件：真实装载路径（app.url 环回远端视图 + 工具口 + MCP 三者并存）', () => {
  it('装载：窗口定义 = 环回远端视图（kind remote）+ 工具行 + MCP 行三者齐', async () => {
    expect(validateManifest(MANIFEST).ok).toBe(true); // 真 manifest 过校验（二态 url 形态）
    await loadOfficePlugin();
    expect(usePluginWindowStore.getState().defs.office).toMatchObject({
      pluginName: 'office',
      entryUrl: 'http://127.0.0.1:26315/', // 原样声明值（不走资产前缀）
      kind: 'remote',
      mode: 'floating',
      title: 'Office 活预览',
    });
    const rows = pluginToolRows().map((r) => r.id);
    expect(rows).toContain('plugin/office/office_preview_open'); // 工具口（宿主侧开窗）
    expect(rows).toContain('plugin/office/mcp/office'); // MCP 路（受治 lazy——不调 factory 不起进程）
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
      // 回执带失败自救指引（watch 未起时用户知道下一步做什么）
      expect(String(out)).toContain('officecli watch');
    } finally {
      delete (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__;
    }
  });

  it('宿主桥缺失时工具口不炸（回执点名原因）——非兰台宿主的装载面', async () => {
    await loadOfficePlugin();
    const row = pluginToolRows().find((r) => r.id === 'plugin/office/office_preview_open');
    const tools = await row?.factory({} as never);
    const out = String(await tools?.[0].execute({}));
    expect(out).toContain('宿主桥不可用');
  });

  it('卸载收口：停用 office → 窗口定义摘除 + 工具行与 MCP 行消失', async () => {
    await loadOfficePlugin();
    expect(usePluginWindowStore.getState().defs.office).toBeDefined();
    await deactivateExternalPlugin('office');
    expect(usePluginWindowStore.getState().defs.office).toBeUndefined();
    const rows = pluginToolRows().map((r) => r.id);
    expect(rows).not.toContain('plugin/office/office_preview_open');
    expect(rows).not.toContain('plugin/office/mcp/office');
  });
});
