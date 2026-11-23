// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 内置手册与插件面的漂移守卫（2026-11-23，plasmid：skill 落后 6 个契约版本之后补的）。
//
// 病灶：`lantai-plugin-dev` 是内置 Agent 写插件时**唯一**读的东西，但它只是一段字符串——
// 契约升到 v76 时它还在教 v72 已删的 `async: true`（照写会被装载器具名拒载）。
// 没有任何东西把「schema 有哪些字段」和「手册写了哪些字段」对起来，于是漂移是静默的。
//
// 本守卫四查（全部静态、毫秒级）：
//   ① manifest 顶层字段 ⊆ 手册正文（新增字段没写进手册 = 红，逼迫同批更新）；
//   ② app 声明字段 ⊆ 手册正文（嵌套层同样会漂——v70 的 documents / v75 的 size）；
//   ③ 手册里出现退役形状时，那一行必须同时说「退役」（教旧写法 = 红）；
//   ④ 手册指向的路径真实存在（模板 / 一页纸 / JSON Schema——指针烂掉比没写更坏）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BUILTIN_SKILLS } from '../src/plugins/builtin/skill-domain/builtin-skills';
import { PluginManifestSchema } from '../src/plugins/types';

const ROOT = join(__dirname, '..', '..');

/** 手册正文（出厂技能里唯一讲插件的那本）。 */
function pluginDevPrompt(): string {
  const skill = BUILTIN_SKILLS.find((s) => s.name === 'lantai-plugin-dev');
  if (!skill) throw new Error('出厂技能 lantai-plugin-dev 不见了');
  return skill.prompt;
}

/** JSON Schema 节点（只声明本文件用到的成员）。 */
interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

const SCHEMA = z.toJSONSchema(PluginManifestSchema, { io: 'output' }) as SchemaNode;

/** 反引号词是否出现在手册里（手册用 `field` 的写法列字段）。 */
function mentions(text: string, token: string): boolean {
  return text.includes('`' + token + '`');
}

describe('内置手册 lantai-plugin-dev：与插件面不漂移', () => {
  const prompt = pluginDevPrompt();

  it('① manifest 每个顶层字段都在手册里出现（新增字段没写进手册 = 红）', () => {
    const missing = Object.keys(SCHEMA.properties ?? {}).filter((k) => !mentions(prompt, k));
    expect(missing, '这些 manifest 字段没写进手册——改 schema 时同批更新 PLUGIN_DEV_PROMPT').toEqual([]);
  });

  it('② app 声明的每个字段都在手册里出现（嵌套层同样会静默漂移）', () => {
    const app = Object.keys(SCHEMA.properties?.app?.properties ?? {});
    expect(app.length).toBeGreaterThan(3); // 自检：结构变了要有人看
    const missing = app.filter((k) => !mentions(prompt, k));
    expect(missing, '这些 app 字段没写进手册').toEqual([]);
  });

  it('③ 手册提到退役形状时，同一行必须说清「退役」（教旧写法 = 红）', () => {
    // 只看可能被当写法教的三个：工具口 async、受治三档 lifecycle、宿主桥 deferred
    const retired = ['deferred.complete', 'tools[].async', 'mcpServers[].lifecycle'];
    const lines = prompt.split('\n');
    /** 段落窗口（±1 行）：手册正文是折行散文，「退役」常被折到邻行。 */
    const contextOf = (i: number): string => [lines[i - 1] ?? '', lines[i], lines[i + 1] ?? ''].join('\n');
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      for (const token of retired) {
        if (!line.includes(token)) continue;
        const ctx = contextOf(i);
        if (ctx.includes('退役') || ctx.includes('已删')) continue;
        offenders.push(token + ' → ' + line.trim().slice(0, 80));
      }
    });
    expect(offenders, '手册在教退役形状（装载期会被具名拒载）').toEqual([]);
    // 硬负例：整段正文不许出现「加 async: true」这种可直接照抄的写法
    expect(prompt.includes('"async": true'), '手册正文里不应再出现可直接照抄的 "async": true').toBe(false);
  });

  it('④ 手册指向的路径真实存在（模板 / 一页纸 / JSON Schema / 范本）', () => {
    const targets = [
      'examples/plugins/_template',
      'docs/plugins/contract-card.md',
      'docs/plugins/manifest.schema.json',
      'docs/plugins/README.md',
      'examples/plugins/notes-app',
    ];
    for (const rel of targets) {
      expect(existsSync(join(ROOT, rel)), rel + ' 不存在——手册里的指针烂了').toBe(true);
      // 手册正文里必须真的提到它（防「守卫清单加了、正文没写」）
      expect(prompt.includes(rel.split('/').filter(Boolean).slice(-1)[0] ?? rel)).toBe(true);
    }
  });
});
