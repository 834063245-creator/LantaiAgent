// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 产物源码不进壳 bundle 守护（插件化欠账总账 §0.1 / §5 第 3 条 · 批 0a）
//
// 病灶（2026-09-24 账本 §0.1 实测）：生产 bundle 曾整份带上 30 个出厂产物的源码
// （含 6 份 UI 产物的 CSS 与内联资产）+ 产物清单本体 `plugins/factory-products.ts`
// —— 与 `docs/plugins/README.md`「exe 只留 13 内核装配台」矛盾（后果：体积虚胖
// + 同一份产物在磁盘通道之外还带一份死副本）。
// 修法 = `vite.config.ts` 的 `stubFactoryProductsInBuild()`：构建期把装载链那处
// `./factory-products` 置换为语义等价空壳 ⇒ 30 个产物源码**根本不进 rollup 解析面**
// （不再赌任何 DCE 折叠——为什么 `treeshake.moduleSideEffects` 与 load 钩子两条路
// 都无效，见该文件头注的实测记录）。
//
// 本守卫三段（第二/三段要 dist 在场——本地 `npm run build` 之后才跑，仿
// tests/face-deps-seal.test.ts 的「dist 在场才跑第二段」范式）：
//   ① 静态：vite.config.ts 仍挂着那枚置换插件（防被顺手删掉而无人发现）；
//   ② 产物 JS：体内不得含**产物源码独有串**（探针从产物源码派生、逐个验过内核侧
//      不含——新产物自动纳入，无需手工登记）；
//   ③ 样式面：`main.ts` 显式声明的产品 CSS 必须在壳 CSS 里**真的有效**；
//      其余产品 CSS 的类选择器必须被**其所属产物的 entry.css** 覆盖
//      （漏了就是 landmine H2/H5 同族的**静默丢样式**：无报错、无回执）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROSTER } from '../src/plugins/builtin-roster';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = join(HERE, '..');
const SRC = join(UI_ROOT, 'src');
const BUILTIN_SRC = join(SRC, 'plugins', 'builtin');
const sep = process.platform === 'win32' ? '\\' : '/';
const DIST_ASSETS = join(UI_ROOT, 'dist', 'assets');
const DIST_PLUGINS = join(UI_ROOT, 'dist-plugins', 'builtin', 'hologram');
const VITE_CONFIG = join(UI_ROOT, 'vite.config.ts');

function walkFiles(dir: string, filter: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, filter));
    else if (filter(e.name)) out.push(p);
  }
  return out;
}

const read = (p: string): string => readFileSync(p, 'utf8');

/** 去掉 CSS 注释（注释里大量出现**已退役**的旧类名，留着会把守卫变成噪声源）。 */
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** CSS 文本里的类选择器全集。
 *  ⚠ 先抹掉 `url(...)` 里的资源路径与字符串字面量：批 9e 起产物 CSS 引二进制资产
 *  （`url("./sh-seal-mask.png")`），旧写法会把 `.png` 当成类名 ⇒ 假红。 */
function cssClasses(css: string): string[] {
  const set = new Set<string>();
  const decls = stripCssComments(css)
    .replace(/url\([^)]*\)/g, ' ')
    .replace(/"[^"\n]*"|'[^'\n]*'/g, ' ');
  for (const m of decls.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) set.add(m[1]!);
  return [...set];
}

/** 产物体内的探针串是否「够独特」。
 *  ⚠ 只有「内核源码里不出现」还不够：bundle 里还有**依赖的数据表**（分词器词表
 *  含几万条英文片段/单词——实测 `adaptive` 这种常见词会撞上，2026-09-24 批 2a 踩过）。
 *  故再要求：含非字母数字（标识符/路径/版本串）· 或含大写（camelCase 标识符）·
 *  或长纯小写词（≥14，词表里不会有的长度）。 */
function distinctiveProbe(lit: string): boolean {
  if (/[^a-zA-Z0-9]/.test(lit)) return true;
  if (/[A-Z]/.test(lit)) return true;
  return /^[a-z]{14,}$/.test(lit);
}

/** 产物源码里出现的字符串字面量（长度 ≥ 6、无模板插值）——探针候选。 */
function stringLiterals(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/'([^'\\\n]{6,})'|"([^"\\\n]{6,})"|`([^`$\\\n]{6,})`/g)) {
    const lit = m[1] ?? m[2] ?? m[3];
    if (lit) out.add(lit);
  }
  return [...out];
}

// ── ① 静态：置换插件仍在 ──
describe('产物源码不进壳 bundle（静态面）', () => {
  it('vite.config.ts 仍挂着构建期置换插件（删掉它 = 30 份产物源码随 exe 发货）', () => {
    const cfg = read(VITE_CONFIG);
    expect(cfg, 'vite.config.ts 缺 stubFactoryProductsInBuild 插件').toContain('stubFactoryProductsInBuild');
    expect(cfg, '置换插件必须只在 build 生效（dev/vitest 走源码域）').toContain("apply: 'build'");
    expect(cfg, '置换目标必须是装载链那处 ./factory-products').toContain("source !== './factory-products'");
    expect(cfg).toContain('if (id !== FACTORY_PRODUCTS_STUB) return null;');
  });
});

// ── ② 产物 JS：不含产物源码独有串 ──
const indexJs = existsSync(DIST_ASSETS)
  ? readdirSync(DIST_ASSETS)
      .filter((n) => /^index-.*\.js$/.test(n))
      .map((n) => join(DIST_ASSETS, n))
  : [];
const d = indexJs.length > 0 ? describe : describe.skip;

d('产物源码不进壳 bundle（dist 在场：JS 面）', () => {
  /** 内核侧全文（产物包之外的一切**会被打进 bundle 的东西**——ts/tsx/css/**json**）。
   *  ⚠ json 必须在内：`builtin-roster.json` 是内核数据模块（`impl`/`shared` 里的路径串
   *  会随 roster 进 bundle），漏掉它会把 roster 自己的字符串当「产物独有串」误报。
   *  ⚠ 前缀判据必须带分隔符：`plugins/builtin` 是 `plugins/builtin-roster.json` 的
   *  字符串前缀（少一个 `sep` 就把名册误判成包内文件——2026-09-24 实测踩过）。 */
  const kernelText = walkFiles(SRC, (n) => /\.(ts|tsx|css|json)$/.test(n))
    .filter((f) => !f.startsWith(BUILTIN_SRC + sep))
    .map(read)
    .join('\n');

  it('每个产物的**独有串**都不在壳产物体内（探针从产物源码派生，新产物自动纳入）', () => {
    // 载荷读一次（每个 ~4 MB × 30 产物 = 120 MB 的重复读会让本用例在满载下超 5s 默认超时）
    const bundles = indexJs.map((js) => ({ js, body: read(js) }));
    const hits: string[] = [];
    let probed = 0;
    for (const entry of BUILTIN_ROSTER) {
      const dir = join(BUILTIN_SRC, entry.dir);
      const literals = walkFiles(dir, (n) => /\.(ts|tsx)$/.test(n))
        .flatMap((f) => stringLiterals(read(f)))
        // 只留「内核侧绝不出现」且「够独特」的字面量 ⇒ 命中即证明该产物源码进了 bundle
        .filter((lit) => distinctiveProbe(lit) && !kernelText.includes(lit));
      const probes = [...new Set(literals)].slice(0, 5);
      if (probes.length === 0) continue; // 无独有串的产物：由 ③/其他用例兜底
      probed += 1;
      for (const { js, body } of bundles) {
        for (const probe of probes) {
          if (body.includes(probe)) hits.push(`${entry.dir} → ${probe}（命中 ${relative(UI_ROOT, js)}）`);
        }
      }
    }
    expect(
      hits,
      `壳 bundle 里出现产物源码独有串（构建期置换插件失效或产物被静态 import 回来了）：\n${hits.join('\n')}`,
    ).toEqual([]);
    expect(probed, '守卫自检：至少要能从产物源码派生出独有串探针（否则本用例是空转）').toBeGreaterThanOrEqual(20);
  }, 30_000);

  it('dist 在场但置换未生效的典型指纹：产物清单本体的错误串不得出现', () => {
    // factory-products.ts 的两句 fail-loud 文案只存在于该模块 ⇒ 它进 bundle 即命中
    const fingerprints = ['出厂产物名撞车', '名册条目缺插件对象映射'];
    for (const js of indexJs) {
      const body = read(js);
      for (const fp of fingerprints) {
        expect(body.includes(fp), `${relative(UI_ROOT, js)} 含产物清单本体文案「${fp}」`).toBe(false);
      }
    }
  });
});

// ── ③ 样式面：壳 CSS 面的有效 + 其余产品 CSS 由产物兜底 ──
const indexCss = existsSync(DIST_ASSETS)
  ? readdirSync(DIST_ASSETS)
      .filter((n) => /^index-.*\.css$/.test(n))
      .map((n) => join(DIST_ASSETS, n))
  : [];
const dc = indexCss.length > 0 ? describe : describe.skip;

dc('产物源码不进壳 bundle（dist 在场：样式面）', () => {
  const shellCss = indexCss.map(read).join('\n');
  /** main.ts 显式声明进壳的产品 CSS（首帧面——**这是壳 CSS 面的唯一真源**）。 */
  const declared = [...read(join(SRC, 'main.ts')).matchAll(/import\s+'\.\/(plugins\/builtin\/[^']+\.css)'/g)].map(
    (m) => m[1]!,
  );
  /** 全部产品 CSS（相对 plugins/builtin/）。 */
  const allProductCss = walkFiles(BUILTIN_SRC, (n) => n.endsWith('.css')).map((f) =>
    relative(BUILTIN_SRC, f).replace(/\\/g, '/'),
  );

  it('main.ts 声明的首帧产品 CSS 必须在壳 CSS 里真的生效（覆盖率 ≥ 90%）', () => {
    expect(declared.length, 'main.ts 未声明任何产品 CSS——首帧面清单不该为空').toBeGreaterThan(0);
    const bad: string[] = [];
    for (const rel of declared) {
      const sels = cssClasses(read(join(SRC, rel)));
      const hit = sels.filter((s) => shellCss.includes('.' + s));
      const rate = sels.length === 0 ? 1 : hit.length / sels.length;
      if (rate < 0.9) bad.push(`${rel}：${hit.length}/${sels.length}（${(rate * 100).toFixed(1)}%）`);
    }
    expect(bad, `首帧 CSS 面在壳 bundle 里缺规则（landmine H2/H5 同族：静默丢样式）：\n${bad.join('\n')}`).toEqual([]);
  });

  it('未进壳的产品 CSS，其类选择器必须被所属产物的 entry.css 覆盖（零未覆盖）', () => {
    const declaredSet = new Set(declared);
    const uncovered: string[] = [];
    for (const rel of allProductCss) {
      if (declaredSet.has(`plugins/builtin/${rel}`)) continue;
      const dir = rel.split('/')[0]!;
      const entryCssPath = join(DIST_PLUGINS, dir, 'entry.css');
      const entryCss = existsSync(entryCssPath) ? read(entryCssPath) : '';
      const lost = cssClasses(read(join(BUILTIN_SRC, rel))).filter((s) => {
        if (shellCss.includes('.' + s)) return false; // 别的 CSS 也在定义（壳或本产物）
        if (entryCss.includes('.' + s)) return false;
        // 允许：该选择器在**其它**产物 CSS 里也有定义（同族共享类名）
        return !allProductCss.some((other) => other !== rel && read(join(BUILTIN_SRC, other)).includes('.' + s));
      });
      if (lost.length > 0) uncovered.push(`${rel} → ${lost.slice(0, 8).join(', ')}（产物 ${dir || '?'}）`);
    }
    expect(
      uncovered,
      `产品 CSS 既没进壳、产物 entry.css 也没覆盖（改样式静默不生效）：\n${uncovered.join('\n')}`,
    ).toEqual([]);
  });
});
