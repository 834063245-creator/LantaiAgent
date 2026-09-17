// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 规线简写拼装守卫（2026-09-17，配 docs/plans/tool-image-context-plan.md §6 的修复）。
//
// 病灶：`tokens.css` 的规线三式（--rule-hard / --rule-strong / --rule-soft /
// --rule-dashed）是**整条 border 简写**（宽度+样式+颜色）。调用点若再拼一次
// （`border: 2px solid var(--rule-soft)`），var 替换后的值 = `2px solid 1px solid …`
// ⇒ 该边界属性在 computed-value 阶段失效、回落初始值（border-style: none）
// ⇒ **声明存在但一条线都不画**。2026-09-17 实测：这类声明全仓曾有 49 处
// （资产段落 9 / 正文·夹注族 8 / 壳·浮件族 32），像素对照 合法 484 边像素 vs 病灶 0。
//
// 本测试是**全仓扫面**（不只一个文件）——它是「声明从未生效」这一整类缺陷的钉子，
// 不是某条线的钉值。要配局部宽度就写颜色位（--rule-*-ink）。

// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

/** 递归收集 src/ 下全部 CSS 文件（跳 node_modules 之类不在 src 内的目录）。 */
function allCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allCssFiles(p));
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

/** 违规形态：声明里出现「别的 token/字面量 + solid|dashed + var(--rule-*)」。
 *  var 内嵌（如 var(--rule-soft, 1px solid red)）不算——那是回退值不是拼装。 */
const COMPOSED =
  /(border[a-z-]*|outline)\s*:\s*[^;{}]*\S\s+(solid|dashed)\s+var\(--rule-(soft|strong|hard|dashed)\)\s*[;}]/;

describe('规线简写拼装守卫（声明不得存在却不生效）', () => {
  const files = allCssFiles(SRC);

  it('扫面非空（防路径漂移把守卫变成永真）', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('全仓 CSS 无「整条规线简写 + 局部宽度」拼装', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (COMPOSED.test(line)) offenders.push(`${file.replace(SRC, 'src')}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders, `规线简写被拼装（展开后是非法声明 = 线画不出来）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('颜色位是真源：简写由 -ink 派生（改色只需改一处）', () => {
    const tokens = readFileSync(join(SRC, 'app', 'tokens.css'), 'utf8');
    expect(tokens).toContain('--rule-soft-ink:');
    expect(tokens).toContain('--rule-strong-ink:');
    expect(tokens).toContain('--rule-soft: 1px solid var(--rule-soft-ink)');
    expect(tokens).toContain('--rule-strong: 1px solid var(--rule-strong-ink)');
  });
});
