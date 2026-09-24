// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内核 ↛ 产物源码（批 8a 立规，2026-09-25）——**反向依赖守卫**。
//
// 病灶（批 8 侦察实测）：内核重查看器 `app/paper/viewers/*` 的 props 形状由产物
// `plugins/builtin/renderers/viewer-registry.ts` 定义，且 `model3d.tsx` 引的是**值** `normalizeExt`
// ⇒ 「内核 app 反向依赖产物包」；环上任何一侧改名都要两侧同改，且产物源码进壳 bundle 的
// 风险随每次 import 增加（§0.1 缺陷的同族）。
//
// 判据：`src/**` 去掉 `src/plugins/builtin/**` 之后，**不得** import 任何落进
// `src/plugins/builtin/<dir>/` 的源文件。白名单 = dev/source 域的**产物清单表**
// （`composition/first-party-*.ts`：它们的职责就是「列出产物插件对象」，dev 域装载用；
// 生产构建期被 vite 置换为 stub —— 见 `tests/product-source-not-in-bundle.test.ts`）。
//
// 反向自检（防守卫失灵）：① 扫描面必须真的覆盖到产物源码（计数 > 0）；
// ② 白名单条目必须**仍在** import 产物（清了就删行，防文本腐烂）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const PRODUCTS_ROOT = join(SRC, 'plugins', 'builtin');
/** 产物源码 = `plugins/builtin/<dir>/` **子目录**里的文件。目录直属的四个文件是**平台面**
 *  （`host-modules.ts` = faceDeps 宿主注册表 · `face-css.ts` = 产物 CSS 注入腰 ·
 *  `contribution-helpers.ts` · `react-bridge.cjs`），内核 import 它们是正常方向。 */
const PRODUCT_DIRS = readdirSync(PRODUCTS_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(PRODUCTS_ROOT, e.name));
const PRODUCT_PREFIXES = PRODUCT_DIRS.map((d) => d + (process.platform === 'win32' ? '\\' : '/'));
const inProductSource = (p: string): boolean => PRODUCT_PREFIXES.some((pre) => p.startsWith(pre));

/** 白名单：**dev 域的产物清单表**（唯一职责 = 列产物插件对象，生产构建期被置换）。 */
const ALLOWED_IMPORTERS = new Set([
  join(SRC, 'composition', 'first-party-tools.ts'),
  join(SRC, 'composition', 'first-party-prompts.ts'),
  join(SRC, 'composition', 'first-party-capabilities.ts'),
  join(SRC, 'plugins', 'factory-products.ts'),
]);

/** 首帧产品 CSS 白名单（`main.ts`）——只准 import **CSS**，不准 import 产物 TS/TSX：
 *  这条限制让「首帧样式随壳」的既有例外不变成「内核反向依赖实现」的后门
 *  （覆盖面见 tests/product-source-not-in-bundle.test.ts 的产品 CSS 覆盖段）。 */
const CSS_ONLY_IMPORTERS = new Set([join(SRC, 'main.ts')]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p === PRODUCTS_ROOT) continue; // 产物源码自身不参与扫描
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 相对 specifier → 物理文件（沿用 tests 既有解析口径：+.ts/.tsx/index）。 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** 文件里全部 import 目标（静态 import / re-export / 动态 import）。 */
function importTargets(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
    const r = resolveSpecifier(file, m[1]!);
    if (r) out.push(r);
  }
  return out;
}

describe('内核 ↛ 产物源码（批 8a 守卫）', () => {
  it('内核文件不得 import 产物源码（白名单外零命中）', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      for (const target of importTargets(file)) {
        if (!inProductSource(target)) continue;
        const rel = `${relative(SRC, file).replace(/\\/g, '/')} → ${relative(SRC, target).replace(/\\/g, '/')}`;
        if (ALLOWED_IMPORTERS.has(file)) continue;
        if (CSS_ONLY_IMPORTERS.has(file) && target.endsWith('.css')) continue;
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `内核反向依赖了产物源码（宿主→插件是禁反方向）：把共享形状上收内核契约（viewer-contract 先例），` +
        `或把实现整件搬进产物包：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('CSS 白名单不越界：main.ts 只 import 产物的 CSS（零 TS/TSX）', () => {
    const bad: string[] = [];
    for (const file of CSS_ONLY_IMPORTERS) {
      for (const target of importTargets(file)) {
        if (inProductSource(target) && !target.endsWith('.css')) {
          bad.push(`${relative(SRC, file).replace(/\\/g, '/')} → ${relative(SRC, target).replace(/\\/g, '/')}`);
        }
      }
    }
    expect(bad, '首帧白名单只准引产物 CSS').toEqual([]);
  });

  it('守卫自检：产物源码树非空（扫描面真的覆盖到产物）', () => {
    expect(existsSync(PRODUCTS_ROOT)).toBe(true);
    expect(readdirSync(PRODUCTS_ROOT).length).toBeGreaterThan(20);
  });

  it('守卫自检：白名单条目仍在 import 产物（清了就删行，防文本腐烂）', () => {
    const stale = [...ALLOWED_IMPORTERS].filter((f) => !importTargets(f).some((t) => inProductSource(t)));
    expect(
      stale.map((f) => relative(SRC, f)),
      '白名单条目已不再 import 产物——从守卫里删掉',
    ).toEqual([]);
  });
});
