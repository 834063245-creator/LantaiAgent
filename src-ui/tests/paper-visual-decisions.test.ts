// SPDX-License-Identifier: MIT

// 纸壳视觉定稿钉值（B 段审美循环，2026-08-23）——CSS 字面量断言防回漂。
// node 环境：readFileSync 读文件（jsdom 下 node: 模块 baseline 不可用，?raw 被 vitest css
// 管线吞成空串——两条替代路都试过，此文件头注释是唯一可行位）。
//
// 锁的定稿：
//   B3 环1（用户拍板 B 提墨）：信息承载五处 ink-3→ink-2
//   B4 环1（用户拍板 C）：来文身 18px→16px/1.9（seal-deep 不变，收正文 17 之下）
//   B5 环2（用户拍板 红绿墨色化）：diff add=松绿(--pass) / del=朱砂深(--seal-deep)+删除线

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const PANEL_CSS = readFileSync(join(SRC, 'app', 'panels', 'PaperPanel.css'), 'utf8');
const HOME_CSS = readFileSync(join(SRC, 'app', 'foundation.css'), 'utf8');

/** 从选择器名截取规则体（到下一个 `}` 为止——纸壳 CSS 规则无嵌套）。 */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

describe('纸壳视觉定稿钉值（B3/B4/B5）', () => {
  it('B4+B5：来文 16px/1.9 朱砂深；diff add 松绿 / del 朱砂深删除线', () => {
    const userBody = ruleBody(PANEL_CSS, '.pp-block.pp-user .pp-body');
    expect(userBody).toContain('font-size: 16px');
    expect(userBody).toContain('line-height: 1.9');
    expect(userBody).toContain('var(--seal-deep)');

    expect(ruleBody(PANEL_CSS, '.pp-diff .pp-add')).toContain('var(--pass)');
    const del = ruleBody(PANEL_CSS, '.pp-diff .pp-del');
    expect(del).toContain('var(--seal-deep)');
    expect(del).toContain('line-through');
  });

  it('B3：信息承载五处 ink-2（tool/code 输出 + 案卷日期/卷号/页脚）', () => {
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-tool .pp-out')).toContain('color: var(--ink-2)');
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-code .pp-out')).toContain('color: var(--ink-2)');
    expect(ruleBody(HOME_CSS, '.sh-session-row .date')).toContain('color: var(--ink-2)');
    expect(ruleBody(HOME_CSS, '.sh-session-row .meta')).toContain('color: var(--ink-2)');
    expect(ruleBody(HOME_CSS, '.sh-foot')).toContain('color: var(--ink-2)');
  });
});
