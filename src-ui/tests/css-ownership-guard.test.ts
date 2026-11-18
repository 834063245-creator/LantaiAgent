// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 样式归属守卫（2026-11-17 技术债批 A–C 的护栏）。
//
// 背景：一批样式归属债——组件在可热更产物里、样式却写在只能随 exe 走的壳层，
// 或者反过来（壳层组件向产物要样式）。扫库实测：壳层 151 个类名里 116 个是
// 单个产物的专属样式（provider 控制台 1435 行），另有 3 个壳层组件反向依赖
// 产物 CSS、9 条弹层样式被整组复制。这批已清（commit c3075eb3）。
//
// 为什么需要测试：代码依赖有构建期名册校验（内联未登记模块 ⇒ 构建失败），
// **CSS 没有等价校验**，所以样式跨界能悄悄长回来。本文件就是那条校验。
//
// 三条判据（对应三类债）：
//   ① 壳层 CSS（基座文件除外）不得定义「只被单个产物使用」的类 —— 专属样式
//      应随组件进产物，否则改一行也要重打 exe。
//   ② 壳层组件用到的类，必须在壳层 CSS 里有定义 —— 否则旧 exe + 新产物（或
//      产物被禁用）时壳层组件裸样式（反向依赖，最险）。
//   ③ 产物组件允许使用的壳层类，只能来自登记过的基座文件 —— 跨域共享必须
//      显式登记（基座 = 谁都能用、谁都不欠谁的公共设施）。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

/** 壳层基座：登记的跨域共享文件，其定义的类允许被任意域使用。
 *  ⚠ 新增基座 = 显式登记（并说明为什么它是跨域公共设施，而不是某个产物的私有样式）。 */
const SHELL_BASE_FILES = new Set([
  'app/controls.css', // 动作钮 / 输入件（设置页、确认框、创作坞共用）
  'app/viewer-base.css', // 查看器状态类（壳层 model3d/pdf + 产物 renderers 共用）
  'app/overlay-base.css', // .cd-* 确认弹层基座（壳层 ConfirmDialog + 设置页浮层共用）
  'app/tokens.css', // 设计 token
  'app/foundation.css', // 全局地基（纹理层 / 可访问性 / 选中）
  'app/shell.css', // 壳层全局（含 psh-host 宿主槽：产物卡片由壳层定位）
  'app/type-scale.css', // 字阶（产物 CSS @import 内联）
]);

const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(SRC);

const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');
const isProduct = (p: string) => rel(p).includes('plugins/builtin/');

/** CSS 类名（跳过注释与 url(...)——后者会误抓 `http://www.w3.org` 的 `.w3`）。 */
function cssClasses(path: string): Set<string> {
  let src = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  src = src.replace(/url\((?:[^()]|\([^()]*\))*\)/g, '');
  const out = new Set<string>();
  for (const m of src.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
  return out;
}

/** 组件里出现的 kebab-case 类名 token（字符串字面量 / 模板串 / 条件类名）。 */
function classTokens(path: string): Set<string> {
  const src = readFileSync(path, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    for (const tok of m[2].split(/[\s${}]+/)) {
      if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(tok)) out.add(tok);
    }
  }
  return out;
}

const cssFiles = files.filter((f) => f.endsWith('.css'));
const codeFiles = files.filter((f) => /\.(tsx|ts)$/.test(f));

// 类名 → 定义它的文件
const shellOwners = new Map<string, Set<string>>();
const productOwners = new Map<string, Set<string>>();
for (const f of cssFiles) {
  const bucket = isProduct(f) ? productOwners : shellOwners;
  for (const c of cssClasses(f)) {
    if (!bucket.has(c)) bucket.set(c, new Set());
    bucket.get(c)?.add(rel(f));
  }
}

// 类名 → 使用者（按产物目录聚合）
const shellUsers = new Map<string, Set<string>>();
const productUsers = new Map<string, Set<string>>();
for (const f of codeFiles) {
  const bucket = isProduct(f) ? productUsers : shellUsers;
  for (const t of classTokens(f)) {
    if (!bucket.has(t)) bucket.set(t, new Set());
    bucket.get(t)?.add(rel(f));
  }
}

describe('样式归属守卫（壳层 / 产物边界）', () => {
  it('① 壳层 CSS 不得定义「只被单个产物使用」的类（专属样式必须随产物走）', () => {
    const offenders: string[] = [];
    for (const [cls, owners] of shellOwners) {
      // 已登记基座 ⇒ 允许（基座类被单个产物使用是正常的）；非基座文件里的同名
      // 出现视为特化/组合规则（`#app-root > .cd-overlay` 之类），不改变归属。
      if ([...owners].some((f) => SHELL_BASE_FILES.has(f))) continue;
      const users = productUsers.get(cls);
      if (!users || users.size === 0) continue;
      const dirs = [...new Set([...users].map((u) => u.split('/').slice(0, 3).join('/')))];
      if (dirs.length === 1) offenders.push(`${cls}（只在 ${dirs[0]} 用，定义在 ${[...owners].join(', ')}）`);
    }
    expect(offenders, `专属样式错层：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('② 壳层组件用到的类必须在壳层 CSS 有定义（禁止向产物要样式）', () => {
    const offenders: string[] = [];
    for (const [cls, users] of shellUsers) {
      if (shellOwners.has(cls)) continue; // 壳层自给自足
      if (!productOwners.has(cls)) continue; // 谁都没定义 = 运行时拼出来的，不判
      offenders.push(
        `${cls}（壳层用：${[...users].slice(0, 3).join(', ')}；定义只在产物：${[...(productOwners.get(cls) ?? [])].join(', ')}）`,
      );
    }
    expect(offenders, `反向依赖：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('③ 产物组件使用的壳层类必须来自登记过的基座文件（跨域共享要显式登记）', () => {
    const offenders: string[] = [];
    for (const [cls, users] of productUsers) {
      const owners = shellOwners.get(cls);
      if (!owners) continue; // 不用壳层样式 = 自包含，最好
      // 已登记基座 ⇒ 允许跨域使用；非基座文件里出现的同名字符串若只是
      // 特化/组合规则（如 `#app-root > .cd-overlay`、`.pp-viewer-3d-stage .pp-viewer-note`），
      // 归属仍算基座，不构成新债。
      if ([...owners].some((f) => SHELL_BASE_FILES.has(f))) continue;
      offenders.push(
        `${cls}（产物用：${[...users].slice(0, 2).join(', ')}；定义在非基座壳层：${[...owners].join(', ')}）`,
      );
    }
    expect(offenders, `未登记的跨域样式：\n${offenders.join('\n')}`).toEqual([]);
  });
});
