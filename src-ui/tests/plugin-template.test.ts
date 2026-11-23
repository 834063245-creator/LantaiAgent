// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件模板与契约工具包（2026-11-23 批 2）：
//   ① examples/plugins/_template/ 真的可装载（四件文件齐全 + manifest 过校验 +
//      entry 导出 { name, apply } + toolHandlers 与声明一一对应）；
//   ② validate CLI 与装载器**同判据**（同一份 validateManifest；这里要求它对本
//      模板返回 ok，且字段路径错误能被拆成可读条目）；
//   ③ manifest.schema.json 是生成物且形状对得上（doc-sync 管字节漂移，这里管可读面）。
//
// 模板是「新贡献者 5 分钟路径」的第一站——它烂掉等于入口烂掉，故与代码同门禁。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseIssues, validatePluginDir } from '../scripts/validate-plugin';
import type { PluginManifest } from '../src/plugins/types';
import { validateManifest } from '../src/plugins/types';

const ROOT = join(__dirname, '..', '..');
const TEMPLATE_DIR = join(ROOT, 'examples', 'plugins', '_template');

function readManifest(): { raw: unknown; manifest: PluginManifest } {
  const raw = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'manifest.json'), 'utf8')) as unknown;
  const res = validateManifest(raw);
  if (!res.ok) throw new Error('模板 manifest 不合法：' + res.error);
  return { raw, manifest: res.manifest };
}

describe('插件模板：可装载形状（_template）', () => {
  it('四件文件齐全（manifest / entry / 窗内容 / README）', () => {
    for (const rel of ['manifest.json', 'entry.js', 'app/index.html', 'README.md']) {
      expect(existsSync(join(TEMPLATE_DIR, rel)), rel).toBe(true);
    }
  });

  it('manifest 过 validateManifest，且只声明它能兑现的字段', () => {
    const { manifest } = readManifest();
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.app?.entry).toBe('./app/index.html');
    expect(manifest.tools?.map((t) => t.name)).toEqual(['my_plugin_open']);
    // 模板不碰受治进程 / 数据地盘 / 权限——最小面
    expect(manifest.mcpServers).toBeUndefined();
    expect(manifest.dataDir).toBeUndefined();
    expect(manifest.permissions).toBeUndefined();
  });

  it('entry 导出 { name, apply }，且 name 与 manifest 一致（装载器硬契约）', async () => {
    const { manifest } = readManifest();
    const mod = (await import(/* @vite-ignore */ pathToFileURL(join(TEMPLATE_DIR, 'entry.js')).href)) as {
      default?: { name?: unknown; apply?: unknown };
      toolHandlers?: Record<string, unknown>;
    };
    expect(mod.default?.name).toBe(manifest.name);
    expect(typeof mod.default?.apply).toBe('function');
    // 声明与实现一一对应（缺/多都在装载期被拒）
    expect(Object.keys(mod.toolHandlers ?? {}).sort()).toEqual((manifest.tools ?? []).map((t) => t.name).sort());
    expect(typeof mod.toolHandlers?.my_plugin_open).toBe('function');
  });

  it('validate CLI 与装载器同判据：模板 ok，且给出「name ≠ 目录名」的装载前置提示', () => {
    const { report, code } = validatePluginDir(TEMPLATE_DIR);
    expect(report.issues).toEqual([]);
    expect(code).toBe(0);
    // 模板目录叫 _template、manifest.name = my-plugin —— 拷走后必须改名，
    // CLI 提前说清楚（装载器按目录名寻址，两处不一致会拒载）
    expect(report.hints.join('\n')).toContain('目录名');
  });

  it('字段路径错误被拆成可读条目（cli 输出面）', () => {
    const issues = parseIssues(
      'mcpServers.0.lifecycle: 已退役——改写成 governed: true; tools.0.async: 已退役——长任务改走 MCP',
    );
    expect(issues).toHaveLength(2);
    expect(issues[0].path).toBe('mcpServers.0.lifecycle');
    expect(issues[0].message).toContain('governed: true');
    expect(issues[1].path).toBe('tools.0.async');
  });
});

describe('契约工具包：manifest.schema.json 生成物', () => {
  const file = join(ROOT, 'docs', 'plugins', 'manifest.schema.json');

  it('存在、可解析，且自带「勿手改」说明 + 13 个顶层字段', () => {
    expect(existsSync(file)).toBe(true);
    const schema = JSON.parse(readFileSync(file, 'utf8')) as {
      $comment?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.$comment).toContain('勿手改');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'activation',
      'app',
      'dataDir',
      'description',
      'displace',
      'engines',
      'entry',
      'inject',
      'mcpServers',
      'name',
      'permissions',
      'tools',
      'version',
    ]);
  });
});
