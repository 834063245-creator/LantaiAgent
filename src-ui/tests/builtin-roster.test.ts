// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// builtin-roster 守护（2026-09-06 单一真源立法）：
//   - 名册 dir 集 === 磁盘 builtin 目录集（加/删产物漏改名册 = 红）
//   - 名册 scope 名 / inject === 各源码 index.ts 插件对象（name/inject 派生零漂移）
//   - first-party-manifest feature 集 === 名册集（description 从名册读，勿双写）
//   - 名册无孤儿/重复/序断裂（buildOrder 0..28 连续；31→29 随图谱退役，2026-09-09）

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROSTER, rosterDirs, rosterScopeNames } from '../src/plugins/builtin-roster';
import { FIRST_PARTY_MANIFEST } from '../src/plugins/first-party-manifest';

const BUILTIN_SRC = resolve(__dirname, '../src/plugins/builtin');

/** 磁盘 builtin 产物目录（有 index 入口的——产物定义）。 */
function diskBuiltinDirs(): string[] {
  return readdirSync(BUILTIN_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((d) =>
      ['index.ts', 'index.tsx'].some((f) => {
        try {
          readFileSync(resolve(BUILTIN_SRC, d, f), 'utf8');
          return true;
        } catch {
          return false;
        }
      }),
    )
    .sort();
}

/** 源码 index.ts(x) 全文。 */
function pluginSourceOf(dir: string): string {
  const entryFile = ['index.ts', 'index.tsx'].find((f) => {
    try {
      readFileSync(resolve(BUILTIN_SRC, dir, f), 'utf8');
      return true;
    } catch {
      return false;
    }
  });
  if (!entryFile) throw new Error(`源码缺入口: ${dir}`);
  return readFileSync(resolve(BUILTIN_SRC, dir, entryFile), 'utf8');
}

/** 源码 index.ts(x) 插件对象的 name。 */
function pluginNameFromSource(dir: string): string {
  const src = pluginSourceOf(dir);
  const m = /name:\s*'([^']+)'/.exec(src);
  if (!m) throw new Error(`index 无 name: ${dir}`);
  return m[1]!;
}

/** 源码 index.ts(x) 插件对象的 inject 数组。 */
function pluginInjectFromSource(dir: string): string[] {
  const src = pluginSourceOf(dir);
  const m = /inject:\s*\[([^\]]*)\]/.exec(src);
  if (!m) return [];
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('builtin-roster（名册单一真源守卫）', () => {
  it('名册 dir 集 === 磁盘 builtin 目录集（加/删产物只许动名册）', () => {
    const roster = rosterDirs();
    const disk = new Set(diskBuiltinDirs());
    expect([...roster].filter((d) => !disk.has(d))).toEqual([]); // 名册有磁盘无
    expect([...disk].filter((d) => !roster.has(d))).toEqual([]); // 磁盘有名册无
    expect(roster.size).toBe(29);
  });

  it('名册 buildOrder 连续 0..N-1 无重复（防序号断裂/误插）', () => {
    const orders = BUILTIN_ROSTER.map((e) => e.buildOrder);
    expect(new Set(orders).size).toBe(orders.length);
    for (let i = 0; i < orders.length; i++) expect(orders).toContain(i);
  });

  it('名册 scope 名 / inject === 各源码 index.ts 插件对象（派生零漂移）', () => {
    for (const e of BUILTIN_ROSTER) {
      expect(pluginNameFromSource(e.dir)).toBe('hologram/' + e.dir);
      expect(pluginInjectFromSource(e.dir).sort()).toEqual([...e.inject].sort());
    }
  });

  it('first-party-manifest feature 集 === 名册集', () => {
    const fpmFeatures = Object.entries(FIRST_PARTY_MANIFEST)
      .filter(([, m]) => m.kind === 'feature')
      .map(([name]) => name)
      .sort();
    const rosterNames = [...rosterScopeNames()].sort();
    expect(fpmFeatures).toEqual(rosterNames);
  });
});
