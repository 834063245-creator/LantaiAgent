// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件面形状预算（2026-11-23 减形，施工单 plugin-surface-slimming-plan 批 1C）。
//
// 这一轮删了 2 个形状（mcpServers[].lifecycle 三档 / tools[].async）+ 2 个枚举值
// （eager / with-window）。删掉的东西最容易以「顺手加回来」的形式回流——所以把
// **字段面本身**钉成一张白名单：
//   ① manifest 顶层 12 字段（增字段必须改本测试 → diff 可见，且被迫回答
//      「消费者是谁」——施工单第 7 条：新字段需 ≥2 个真实消费者或一个明确产品承诺）；
//   ② 四个子形状各自的白名单（mcpServers / tools / app / activation）；
//   ③ 退役形状不在 schema 里，且写进 manifest 得到**具名**拒绝（不静默剥掉）；
//   ④ examples/plugins/** 的每份 manifest 都过 validateManifest，且不含退役键。
//
// 白名单读面 = `z.toJSONSchema`（与批 2 的生成物同一份导出口径：测试钉的形状
// 就是编辑器里 JSON Schema 补全的形状，不存在第二份手抄）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PluginManifestSchema, validateManifest } from '../src/plugins/types';

/** JSON Schema 节点（只声明本文件用到的成员——不按生成器的全量形状建模）。 */
interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

/** 子形状白名单（键名排序后对拍；改 schema 必改这里 = diff 可见）。 */
const BUDGET = {
  'manifest 顶层': [
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
  ],
  'mcpServers 条目': [
    'args',
    'command',
    'failurePolicy',
    'governed',
    'headers',
    'name',
    'readOnly',
    'restart',
    'transport',
    'url',
  ],
  'tools 条目': ['description', 'name', 'parameters', 'readOnly'],
  'app 声明': ['documents', 'entry', 'mode', 'size', 'title', 'url', 'workspace'],
  'activation 声明': ['exclusive', 'lazy', 'resources'],
  'engines 声明': ['lantai'],
} as const;

const ROOT = z.toJSONSchema(PluginManifestSchema, { io: 'output' }) as SchemaNode;

function propsOf(node: SchemaNode | undefined): string[] {
  return Object.keys(node?.properties ?? {}).sort();
}

const EXAMPLES_DIR = join(__dirname, '..', '..', 'examples', 'plugins');

/** examples/plugins/<dir>/manifest.json 的 [目录名, 解析结果]（缺文件 = 非插件目录，跳过）。 */
function exampleManifests(): Array<[string, unknown]> {
  if (!existsSync(EXAMPLES_DIR)) return [];
  const out: Array<[string, unknown]> = [];
  for (const entry of readdirSync(EXAMPLES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(EXAMPLES_DIR, entry.name, 'manifest.json');
    if (!existsSync(file)) continue;
    out.push([entry.name, JSON.parse(readFileSync(file, 'utf8')) as unknown]);
  }
  return out;
}

describe('插件面形状预算：manifest 字段白名单（增字段必须改这里）', () => {
  it('顶层 13 字段 —— 与 schema 精确一致（v74 加 engines）', () => {
    expect(propsOf(ROOT)).toEqual([...BUDGET['manifest 顶层']].sort());
  });

  it('mcpServers 条目：受治面只剩 governed / restart（lifecycle 三档已删）', () => {
    expect(propsOf(ROOT.properties?.mcpServers?.items)).toEqual([...BUDGET['mcpServers 条目']].sort());
  });

  it('tools 条目：四字段（async 已删）', () => {
    expect(propsOf(ROOT.properties?.tools?.items)).toEqual([...BUDGET['tools 条目']].sort());
  });

  it('app / activation 声明：白名单精确（v75 给 app 加 size——首选窗尺寸）', () => {
    expect(propsOf(ROOT.properties?.app)).toEqual([...BUDGET['app 声明']].sort());
    expect(propsOf(ROOT.properties?.activation)).toEqual([...BUDGET['activation 声明']].sort());
  });

  it('engines 声明：只有一个 lantai 区间（v74 兼容声明，不是能力面）', () => {
    expect(propsOf(ROOT.properties?.engines)).toEqual([...BUDGET['engines 声明']].sort());
  });
});

describe('插件面形状预算：退役形状不回流', () => {
  const BASE = { name: 'probe', version: '1.0.0', entry: 'entry.js' };

  it('schema 里没有 lifecycle / async（白名单之外就是不存在）', () => {
    const serverKeys = propsOf(ROOT.properties?.mcpServers?.items);
    expect(serverKeys).not.toContain('lifecycle');
    expect(propsOf(ROOT.properties?.tools?.items)).not.toContain('async');
  });

  it('写进 manifest 仍然是具名拒绝（不是被静默剥掉）', () => {
    const lifecycle = validateManifest({
      ...BASE,
      mcpServers: [{ name: 's', transport: 'stdio', command: 'node', lifecycle: 'lazy' }],
    });
    expect(lifecycle.ok).toBe(false);
    expect(lifecycle.ok ? '' : lifecycle.error).toContain('governed: true');

    const async = validateManifest({
      ...BASE,
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' }, async: true }],
    });
    expect(async.ok).toBe(false);
    expect(async.ok ? '' : async.error).toContain('lantai/deferred');
  });
});

describe('插件面形状预算：examples/plugins/** 全部过校验且不含退役键', () => {
  const manifests = exampleManifests();

  it('样例目录非空（扫描面真的扫到了东西）', () => {
    expect(manifests.length).toBeGreaterThanOrEqual(3);
    expect(manifests.map(([dir]) => dir)).toEqual(expect.arrayContaining(['hello', 'notes-app', 'office']));
  });

  it.each(manifests)('%s/manifest.json 通过 validateManifest', (_dir, raw) => {
    const res = validateManifest(raw);
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
  });

  it.each(manifests)('%s/manifest.json 不出现退役键（lifecycle / tools[].async）', (_dir, raw) => {
    const manifest = raw as {
      mcpServers?: Array<Record<string, unknown>>;
      tools?: Array<Record<string, unknown>>;
    };
    for (const server of manifest.mcpServers ?? []) {
      expect(Object.keys(server)).not.toContain('lifecycle');
    }
    for (const tool of manifest.tools ?? []) {
      expect(Object.keys(tool)).not.toContain('async');
    }
  });

  it.each(manifests)('%s/manifest.json 的顶层键都在白名单内（顶层 schema 不 strict，靠这道闸）', (_dir, raw) => {
    const allow = new Set<string>(BUDGET['manifest 顶层']);
    const extra = Object.keys(raw as Record<string, unknown>).filter((k) => !allow.has(k));
    expect(extra).toEqual([]);
  });
});
