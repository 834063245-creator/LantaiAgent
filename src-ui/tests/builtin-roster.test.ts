// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// builtin-roster 守护（2026-09-06 单一真源立法）：
//   - 名册 dir 集 === 磁盘 builtin 目录集（加/删产物漏改名册 = 红）
//   - 名册 scope 名 / inject === 各源码 index.ts 插件对象（name/inject 派生零漂移）
//   - first-party-manifest feature 集 === 名册集（description 从名册读，勿双写）
//   - 名册无孤儿/重复/序断裂（buildOrder 连续；31→30 随图谱退役与后续产物，2026-09-14 核）
//   - M4：factory-products（dev 装载面）覆盖名册全集且序 = buildOrder

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROSTER, rosterDirs, rosterScopeNames } from '../src/plugins/builtin-roster';
import { factoryProductPlugins } from '../src/plugins/factory-products';
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
    // office-domain 新增（2026-09-13，C 路：OfficeCLI 一等域工具）：29 → 30
    // plan-mode 新增（2026-09-24 批 6a：规划模式实现归产物）：30 → 31
    // goal-mode 新增（2026-09-24 批 6b：goal 循环实现归产物）：31 → 32
    // state-hooks 新增（2026-09-24 批 6c：出厂 hook 四工厂归产物）：32 → 33
    // compaction 新增（2026-09-24 批 6d-2：压缩域实现归产物）：33 → 34
    // multiagent-comm 新增（2026-09-24 批 7b：通信族归产物）：34 → 35
    // paper-renderers 新增（2026-09-25 批 8b：纸面块渲染器归产物，required 不可禁用）：35 → 36
    // sessions-home 新增（2026-09-26 批 9e：案卷首页归产物，required 不可禁用——应用唯一入口页）：36 → 37
    // ask-cards 新增（2026-09-26 批 9e-3：ask/权限卡架归产物，required 不可禁用——唯一承接面）：37 → 38
    expect(roster.size).toBe(38);
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

  /* M4 收口（2026-09-14）：dev 装载面（factory-products 的源码域插件对象）
   * 此前只有运行期兜底（名册条目缺映射 → 装载时 throw），且它的"12 直接 +
   * 17 经通道"分区是**惰性**的——放错数组也照跑（两者只喂同一个并集）。
   * 这里把「覆盖名册全集 + 序 = 名册 buildOrder + 无同名/dir 撞车」钉成断言：
   * 加产物只改名册就够（漏 import 会在本用例红，而不是等到 dev 启动才炸）。 */
  it('factory-products 覆盖名册全集且序一致（dev 装载面 —— 无同名/dir 撞车）', () => {
    const products = factoryProductPlugins();
    const names = products.map((p) => p.name);
    const dirs = names.map((n) => n.replace(/^hologram\//, ''));

    expect(new Set(names).size, '两个插件对象同名').toBe(names.length);
    expect(new Set(dirs).size, '两个插件名派生同一 dir（名册寻址会歧义）').toBe(dirs.length);
    expect([...dirs].sort()).toEqual([...rosterDirs()].sort()); // 覆盖全集
    expect(dirs, '序必须 = 名册 buildOrder（贡献注册序 = 字节契约）').toEqual(BUILTIN_ROSTER.map((e) => e.dir));
  });
});
