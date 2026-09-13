// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// office 活预览窗插件范本守护（C 路改判后，2026-09-13）：
//   · 形状：manifest 过 validateManifest；**不含 mcpServers**（读写能力已归兰台内置
//     office 域工具，MCP 挂接退役——回归若重新挂上 MCP 会被本用例挡住）；
//     app.url = 环回远端视图（watch 默认口）；tools = office_preview_open 且 readOnly；
//   · entry：导出 { name, apply, toolHandlers.office_preview_open }（开窗动作必须住宿主侧）；
//   · 二进制不再进插件目录（走标准安装位），故本文件不涉及进程面——office 域工具的真机
//     语义在 tests/office-domain.test.ts 覆盖。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/plugins/types';

const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'plugins', 'office');
const MANIFEST_RAW = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'manifest.json'), 'utf8')) as Record<string, unknown>;
const VALIDATED = validateManifest(MANIFEST_RAW);
if (!VALIDATED.ok) throw new Error(`office 活预览窗 manifest 不通过校验：${VALIDATED.error}`);
const MANIFEST = VALIDATED.manifest;

/** 真 entry 模块导入：entry 在 src-ui 根外（examples/），file URL 会被 vite
 *  fs.allow 拒——自包含 ESM（零 import）经 data URL 装载，逐字节是范本真身。 */
async function importRealEntry(): Promise<Record<string, unknown>> {
  const src = readFileSync(join(EXAMPLE_DIR, 'entry.js'), 'utf8');
  const url = 'data:text/javascript;charset=utf-8;base64,' + Buffer.from(src, 'utf8').toString('base64');
  return import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;
}

describe('office 活预览窗插件范本：形状守护', () => {
  it('manifest 合法：环回远端视图 + 开窗工具口，且**不再挂 MCP**（C 路改判）', () => {
    expect(MANIFEST.name).toBe('office');
    expect(MANIFEST.entry).toBe('entry.js');
    expect(MANIFEST.app).toMatchObject({
      url: 'http://127.0.0.1:26315/', // 环回白名单内；officecli watch 默认口
      mode: 'floating',
      title: 'Office 活预览',
    });
    expect(MANIFEST.app?.entry).toBeUndefined(); // 二态：url 形态不给 entry
    // 读写能力归内置 office 域工具（office(action,…)）——插件不再声明 mcpServers
    expect(MANIFEST.mcpServers).toBeUndefined();
    // 开窗动作必须住宿主侧（窗口设施只有 webview 摸得到）
    expect(MANIFEST.tools?.map((t) => t.name)).toEqual(['office_preview_open']);
    expect(MANIFEST.tools?.[0]?.readOnly).toBe(true);
  });

  it('entry 导出 { name, apply } + office_preview_open handler', async () => {
    const mod = await importRealEntry();
    expect(mod.name).toBe('office');
    expect(typeof mod.apply).toBe('function');
    const handlers = mod.toolHandlers as Record<string, unknown> | undefined;
    expect(typeof handlers?.office_preview_open).toBe('function');
  });

  it('二进制不进插件目录（走标准安装位）——bin/ 不应存在', () => {
    expect(existsSync(join(EXAMPLE_DIR, 'bin'))).toBe(false);
  });

  it('宿主桥缺失时开窗不炸（回执点名原因）', async () => {
    const mod = await importRealEntry();
    const handlers = mod.toolHandlers as Record<string, (a: unknown) => Promise<string>>;
    const out = await handlers.office_preview_open?.({});
    expect(String(out)).toContain('宿主桥不可用');
  });
});
