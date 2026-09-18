// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置面板注疏行排布守卫（2026-09-18，配 Agent 页「文字叠印」修复——用户报
// 「设置面板 agent 页文字叠印，全堆一起了」）。
//
// 病灶：`.sp-field` 是双列网格（标签 200px / 控件 1fr），注疏 `.sp-hint-sub`
// 在有真标签时归位**左列标签下**（原型 .lbl .d 注疏语法）。旧规则给每一条注疏
// 都写死 `grid-row: 2` ⇒ 一个字段有 N 条注疏时 N 条同占一格（网格允许显式重叠，
// 不报错、不撑高）= 文字层叠互印。实测：Agent 页「组合」节的组合目录字段有 3 条
// 注疏，Chrome 无头量矩形得 9 对文字矩形互压（三条都落在 191,413，200px 宽）。
//
// 行号一律交给 `grid-auto-flow: row dense` 自适应（左列注疏逐条下叠、右列控件
// 自成一路），规则处只定「哪一列」。
//
// 为什么钉源码形态而不是钉像素：jsdom 没有排版引擎，量不出叠印（跑得再勤也永真）。
// 排版实证由无头浏览器做——真实渲染产物 + 逐件 getBoundingClientRect 互压检测
// （2026-09-18 实测：修前 Agent 页 9 对互压，修后 0 对；其余 6 个 tab 矩形零变化）。
// 本测试钉的是**产生叠印的那个源码形**，防回漂。

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS_PATH = join(__dirname, '..', 'src', 'plugins', 'builtin', 'settings-domain', 'settings-panel.css');
const CSS = readFileSync(CSS_PATH, 'utf8');

/** 规则面（选择器 → 规则体）：先去注释再逐条配平取块——本 CSS 无嵌套规则。 */
function rules(): Array<{ selector: string; body: string }> {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

/** 取指定选择器的规则体（本 CSS 无嵌套，到下一个 `}` 为止）。 */
function ruleBody(selector: string): string {
  const hit = rules().find((r) => r.selector === selector);
  return hit ? hit.body : '';
}

describe('设置面板注疏行排布（防「多条注疏同格叠印」）', () => {
  const all = rules();

  it('扫面非空（防路径漂移把守卫变成永真）', () => {
    expect(all.length).toBeGreaterThan(50);
    expect(all.some((r) => r.selector.includes('.sp-hint-sub'))).toBe(true);
    expect(ruleBody('.sp-field')).toContain('display: grid');
  });

  it('注疏规则不得写死网格行号（钉行 = 多条同占一格 = 叠印）', () => {
    const offenders = all
      .filter((r) => r.selector.includes('.sp-hint-sub') && /grid-row\s*:/.test(r.body))
      .map((r) => r.selector);
    expect(
      offenders,
      `注疏规则写死了 grid-row（多条注疏会落进同一格互相压印；行号交给 dense 自动排布）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('.sp-field 走 dense 回填（这是「逐条下叠」的机制本体）', () => {
    expect(ruleBody('.sp-field')).toMatch(/grid-auto-flow:\s*row\s+dense/);
  });

  it('注疏定列不定行：有真标签 → 左列；无标签 → 通栏', () => {
    const withLabel = ruleBody('.sp-field:has(> .sp-label:not(.sp-checkbox-label)) > .sp-hint-sub');
    expect(withLabel).toMatch(/grid-column:\s*1\s*;/);
    expect(withLabel).not.toMatch(/grid-row\s*:/);

    const noLabel = ruleBody('.sp-field:not(:has(> .sp-label)) > .sp-hint-sub');
    expect(noLabel).toMatch(/grid-column:\s*1\s*\/\s*-1\s*;/);
  });
});
