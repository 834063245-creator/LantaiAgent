// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 产物 CSS 通道守护（landmine H2 + H3，2026-09-19 修）。
//
// 病灶（修前实况）：面组件的 CSS 有两个运行时域——bundle 域由 vite 打进应用
// CSS、产物域由 esbuild 抽成 entry.css 经宿主桥 `loadCss` 注入。**产物域那条
// 从未通过**：`face-css.ts` 把产物域标记写成了局部别名 `flags.X`，而 esbuild 的
// define 按**表达式字面形态**匹配 `globalThis.X` ⇒ 永不命中 ⇒ 那句判定恒早退
// （实机 `link[id^="lantai-plugin-css"]` 计数 0）⇒ 插件 CSS 只经 vite 进壳
// bundle ⇒ **任何 CSS 改动都得重建 exe**。即便修好它，同文档内点「重新加载」
// 也只会得到「新 JS + 旧 CSS」（`<link>` 同 href 不重新请求）。
//
// 本文件钉三件事：
//   ① H2 三处同源（源码裸标识符 / 构建脚本同名裸键 / 构建期自检在场）；
//   ② bundle 域是 no-op（不产生死 link）；
//   ③ H3 真实注入行为：URL 带版本号、每产品一 link（重注换新）、停用即摘；
//   ④ 顺序审计守卫：5 个面产品跨产品 CSS 选择器零重复（H2 修好后到达序从
//      「壳 import 序」变成「产物装载序」——只有重复选择器才会让胜者翻盘）。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { injectFaceArtifactCss } from '../src/plugins/builtin/face-css';
import { deactivateExternalPlugin, installPluginHostBridge, resetPluginRuntimeForTests } from '../src/plugins/loader';

const REPO = join(__dirname, '..', '..');
const readSrc = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');
const FACE_CSS = readSrc('src-ui/src/plugins/builtin/face-css.ts');
const BUILD_SCRIPT = readSrc('scripts/build-builtin-plugins.mjs');
const VITE_CONFIG = readSrc('src-ui/vite.config.ts');

describe('H2 · 产物域标记三处同源（esbuild define 按字面形态匹配）', () => {
  it('face-css.ts：裸标识符 + typeof 守卫，不出现别名/成员表达式形态', () => {
    expect(FACE_CSS).toContain('typeof __LANTAI_FACE_ARTIFACT__');
    // 病灶形态（写回去即红）：别名 `flags.X` 与成员表达式都命不中 define
    expect(FACE_CSS).not.toContain('flags.__LANTAI_FACE_ARTIFACT__');
    expect(FACE_CSS).not.toContain('globalThis.__LANTAI_FACE_ARTIFACT__');
  });

  it('构建脚本：define 同名裸键（带 globalThis. 前缀即红）', () => {
    expect(BUILD_SCRIPT).toContain('define.__LANTAI_FACE_ARTIFACT__ = \'"1"\'');
    expect(BUILD_SCRIPT).not.toContain("'globalThis.__LANTAI_FACE_ARTIFACT__'");
  });

  it('构建期自检在场：define 没命中 = 构建失败（不静默交付一份 CSS 永不生效的产物）', () => {
    expect(BUILD_SCRIPT).toContain("entrySrc.includes('__LANTAI_FACE_ARTIFACT__')");
    expect(BUILD_SCRIPT).toContain('产物域标记未被替换');
  });

  it('bundle 域显式 define 成 undefined（应用 CSS 侧不注入死 link）', () => {
    expect(VITE_CONFIG).toContain("__LANTAI_FACE_ARTIFACT__: 'undefined'");
  });
});

describe('H2 · bundle 域行为：injectFaceArtifactCss 是 no-op', () => {
  it('bundle 域不注入 link（首帧样式由 vite 打进的应用 CSS 负责）', () => {
    const before = document.querySelectorAll('link[rel="stylesheet"]').length;
    injectFaceArtifactCss();
    expect(document.querySelectorAll('link[rel="stylesheet"]').length).toBe(before);
  });
});

describe('H3 · 宿主桥 loadCss：版本号 + 每产品一 link + 停用即摘', () => {
  const ORIGIN = 'http://127.0.0.1:9/';
  const links = (): HTMLLinkElement[] => [
    ...document.querySelectorAll<HTMLLinkElement>('link[id^="lantai-plugin-css:"]'),
  ];
  const loadCss = (url: string): void => {
    const host = (globalThis as unknown as { __lantai_plugin_host__?: { loadCss?: (u: string) => void } })
      .__lantai_plugin_host__;
    if (!host?.loadCss) throw new Error('宿主桥缺席（installPluginHostBridge 未跑）');
    host.loadCss(url);
  };

  beforeEach(() => {
    resetPluginRuntimeForTests(); // 清账（含摘掉上一用例的 link）
    installPluginHostBridge();
  });

  it('注入 = 真 link + 版本号（同 href 不再吃缓存）', () => {
    loadCss(ORIGIN + 'hologram/compose-dock/entry.css');
    const [link] = links();
    expect(link).toBeDefined();
    expect(link?.rel).toBe('stylesheet');
    expect(link?.href).toContain('entry.css?v='); // 版本号形态
    expect(link?.id).toBe('lantai-plugin-css:hologram/compose-dock'); // 键 = 产物路径
  });

  it('同产品重注 = 换新 link（旧 link 摘掉 ⇒ 新样式里删掉的规则不留场）', () => {
    const url = ORIGIN + 'hologram/paper-shell/entry.css';
    loadCss(url);
    const first = links()[0];
    loadCss(url);
    const after = links();
    expect(after).toHaveLength(1); // 不累积
    expect(after[0]?.href).not.toBe(first?.href); // 版本号变了 ⇒ 浏览器必重新请求
    expect(first?.isConnected).toBe(false); // 旧的已离开文档
  });

  it('两个产品各一 link；停用（未活跃也幂等）只摘本产品', async () => {
    loadCss(ORIGIN + 'hologram/compose-dock/entry.css');
    loadCss(ORIGIN + 'hologram/canvas-nav/entry.css');
    expect(links()).toHaveLength(2);

    await expect(deactivateExternalPlugin('hologram/compose-dock')).resolves.toBe(false); // 未活跃
    const left = links();
    expect(left).toHaveLength(1);
    expect(left[0]?.id).toBe('lantai-plugin-css:hologram/canvas-nav'); // 只摘本产品
  });
});

/* ── 顺序审计守卫（landmine H2 修法的前置对拍，2026-09-19 实测 0 条）──
 * H2 修好后，插件 CSS 的到达序从「壳 bundle 的 import 序」变成「产物装载序」。
 * 只有当**两个产品定义了同一选择器**、且声明冲突时，胜者才会随序翻盘；本用例
 * 把「零重复」钉成常驻不变量 —— 真出现重复时，先判它是否有意共享（有意则把
 * 这条守卫改成显式白名单并在 docs/dev-workflow.md 记明到达序），别默默放过。 */
describe('顺序审计：面产品跨产品 CSS 选择器零重复', () => {
  const FACE_DIRS = ['canvas-nav', 'compose-dock', 'paper-minimap', 'paper-shell', 'settings-domain'];

  /** 选择器集（递归进 @media/@supports/@layer；@keyframes 等声明块不算）。 */
  function selectorsOf(css: string): Set<string> {
    const out = new Set<string>();
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const walk = (s: string): void => {
      let i = 0;
      while (i < s.length) {
        const open = s.indexOf('{', i);
        if (open < 0) break;
        const prelude = s.slice(i, open).trim();
        let depth = 1;
        let j = open + 1;
        while (j < s.length && depth > 0) {
          if (s[j] === '{') depth++;
          else if (s[j] === '}') depth--;
          j++;
        }
        const body = s.slice(open + 1, j - 1);
        if (prelude.startsWith('@')) {
          if (/^@(media|supports|layer|container)/i.test(prelude)) walk(body);
        } else if (prelude) {
          for (const sel of prelude.split(',')) {
            const t = sel.trim().replace(/\s+/g, ' ');
            if (t) out.add(t);
          }
        }
        i = j;
      }
    };
    walk(src);
    return out;
  }

  function cssFilesOf(dir: string): string[] {
    const base = join(REPO, 'src-ui/src/plugins/builtin', dir);
    const acc: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.css')) acc.push(p);
      }
    };
    walk(base);
    return acc;
  }

  it('五个面产品两两无同名选择器（有重复即判归属，别放过）', () => {
    const per = new Map<string, Set<string>>();
    for (const dir of FACE_DIRS) {
      const sels = new Set<string>();
      for (const f of cssFilesOf(dir)) for (const s of selectorsOf(readFileSync(f, 'utf8'))) sels.add(s);
      expect(sels.size, `${dir} 未读到 CSS（目录/解析形态变了？）`).toBeGreaterThan(0);
      per.set(dir, sels);
    }
    const clashes: string[] = [];
    for (const [a, sa] of per) {
      for (const [b, sb] of per) {
        if (a >= b) continue;
        const both = [...sa].filter((s) => sb.has(s));
        if (both.length) clashes.push(`${a} ∩ ${b}: ${both.length} 条（例 ${both.slice(0, 3).join(' | ')}）`);
      }
    }
    expect(clashes, `跨产品重复选择器 ⇒ 产物到达序会决定胜者：\n${clashes.join('\n')}`).toEqual([]);
  });
});
