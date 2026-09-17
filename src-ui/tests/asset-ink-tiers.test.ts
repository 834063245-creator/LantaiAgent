// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 资产段落墨阶守卫（D 墨分层，2026-09-17）——B 图版签主干已落地，本文件把用户选定的
// 另一半「D 墨分层」从审美判断降成**可复算的纪律**：
//
//   ① 资产段落只用 token 上色（var(--ink-*) / var(--indigo) / var(--seal*) / --pass / --fail），
//      不出现裸色值——裸色是「十二原语不成族」的另一半成因（同一批卡片各写各的灰）；
//   ② 墨阶三级各就各位：
//        签/机器语汇 = --indigo（石青：机器的声音；朱砂留给人的批注）
//        题名/卡标题 = --ink-2（中墨）
//        主体值/正文   = --ink-1（重墨）
//        次要读数（标签/图例/注记）= --ink-3 或 --ink-4（淡墨）
//   ③ color-mix 只允许混 token（不混裸色）。
//
// 这些断言都可被旧实现证伪：把任一 token 换成裸 hex 即红。

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(__dirname, '..', 'src', 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');

/** 资产段落（表现原语族）：从 .pp-plate 起到 board/timeline 段结束——用类名前缀圈定。 */
const ASSET_PREFIXES = [
  'pp-plate',
  'pp-grid',
  'pp-chart',
  'pp-metric',
  'pp-board',
  'pp-timeline',
  'pp-citation',
  'pp-chem',
  'pp-media',
  'pp-html',
  'pp-json',
];

/** 拆规则块：先剥注释（注释里有大括号会毁掉括号配对），再按 '}' 切块取最后一个 '{' 之前为选择器。
 *  逗号多选择器拆成多条（每条独立判定），@media 等外层块的前缀文本不影响 `.foo` 匹配。 */
function rules(css: string): Array<{ selector: string; body: string }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ selector: string; body: string }> = [];
  for (const chunk of stripped.split('}')) {
    const at = chunk.lastIndexOf('{');
    if (at < 0) continue;
    const selText = chunk.slice(0, at);
    const body = chunk.slice(at + 1);
    if (!body.trim()) continue;
    for (const sel of selText.split(',')) {
      const s = sel.trim().replace(/^[^{}]*?(?=\.)/, ''); // 去掉 @media 之类外层前缀
      if (s) out.push({ selector: s, body });
    }
  }
  return out;
}

/** 该规则是否属于资产段落（选择器含任一资产前缀；含连字符派生类：.pp-plate → .pp-plate-sign）。 */
function isAssetRule(selector: string): boolean {
  return ASSET_PREFIXES.some((p) => selector.includes(`.${p}`));
}

describe('资产段落墨阶守卫（D 墨分层）', () => {
  const assetRules = rules(CSS).filter((r) => isAssetRule(r.selector));

  it('扫面非空（防选择器改名把守卫变成永真）', () => {
    expect(assetRules.length).toBeGreaterThan(40);
  });

  it('① 只用 token 上色：资产段落不出现裸色值', () => {
    const offenders: string[] = [];
    for (const r of assetRules) {
      // 允许 token 引用、color-mix/calc 里的 token、transparent/none/currentColor 关键字
      const decls = r.body
        .split(';')
        .map((d) => d.trim())
        .filter((d) => /^(color|background|border|box-shadow|fill|stroke|outline)/.test(d));
      for (const d of decls) {
        if (/#[0-9a-fA-F]{3,8}\b/.test(d) || /\b(rgba?|hsla?|oklch)\(/.test(d.replace(/color-mix\(in oklch,/g, ''))) {
          // color-mix(in oklch, var(--x) …) 合法；裸 oklch( 才违规——上面已把合法的剥掉
          offenders.push(`${r.selector} { ${d} }`);
        }
      }
    }
    expect(offenders, `资产段落出现裸色值（应走 token）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('② 墨阶三级各就各位：签=石青 / 题名=中墨 / 值与正文=重墨 / 次要=淡墨', () => {
    const bySelector = new Map(assetRules.map((r) => [r.selector.replace(/\s+/g, ' '), r.body]));
    const colorOf = (sel: string): string => {
      const body = bySelector.get(sel);
      if (body === undefined) throw new Error(`规则不存在：${sel}`);
      const m = body.match(/color:\s*([^;]+);/);
      if (!m) throw new Error(`规则无 color：${sel}`);
      return m[1].trim();
    };
    // 签（机器语汇）
    expect(colorOf('.pp-plate-sign')).toContain('var(--indigo)');
    // 题名（中墨）
    expect(colorOf('.pp-plate-title')).toBe('var(--ink-2)');
    expect(colorOf('.pp-grid-caption')).toBe('var(--ink-2)');
    // 值/正文（重墨）
    expect(colorOf('.pp-metric-value')).toBe('var(--ink-1)');
    expect(colorOf('.pp-grid-table')).toBe('var(--ink-1)');
    // 次要读数（淡墨）
    expect(colorOf('.pp-metric-label')).toBe('var(--ink-3)');
    // .pp-plate 自身只画规线不上色——防后人给它误加颜色（该规则无 color 声明即合规）
    expect((bySelector.get('.pp-plate') ?? '').includes('color:')).toBe(false);
  });

  it('③ color-mix 只混 token（不混裸色）', () => {
    const offenders: string[] = [];
    for (const r of assetRules) {
      const mixes = r.body.match(/color-mix\([^)]*\)/g) ?? [];
      for (const m of mixes) {
        if (/#[0-9a-fA-F]{3,8}\b/.test(m) || m.includes('rgb(') || m.includes('hsl(')) {
          offenders.push(`${r.selector} { ${m} }`);
        }
      }
    }
    expect(offenders, `color-mix 混了裸色：\n${offenders.join('\n')}`).toEqual([]);
  });
});
