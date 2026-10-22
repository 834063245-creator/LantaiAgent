// SPDX-License-Identifier: MIT

// 创作坞 P2 信息架构（2026-10-22）——静态钉值。
// 行为面在 composer-dock-desk（翰 → 全局面板 / 律四组 / / 内联面板仍通）与
// composer-dock-work-ledger（空态一句 + 去处说明）；本文件钉材质与源码接线：
//   ① 命令面板回纸（去 glass/blur；组题 11/600，行 13，脚 11）；
//   ② 翰 = 全局 Ctrl+K 面板（坞内不再维护 menuOpen 第二份清单）；
//   ③ 律四组（输入/附卷/画布/纸面）；
//   ④ 役空态第二行存在（大号 0 / 段题只在真有活时出现）。

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const SHELL_CSS = readFileSync(join(SRC, 'app', 'shell.css'), 'utf8');
const DOCK_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'compose-dock', 'ComposerDock.tsx'), 'utf8');
const WORK_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'compose-dock', 'WorkLedger.tsx'), 'utf8');

function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

describe('创作坞 P2 · 命令面板回纸', () => {
  it('pal-box 不透明纸 + 头线；毛玻璃退役', () => {
    const box = ruleBody(SHELL_CSS, '.pal-box {');
    expect(box).toContain('background: var(--paper)');
    expect(box).toContain('border-top: var(--rule-head)');
    expect(box).not.toContain('backdrop-filter');
    expect(SHELL_CSS).not.toContain('var(--glass-hi)');
  });

  it('组题 11/600 去大写；行 13；脚 11', () => {
    const group = ruleBody(SHELL_CSS, '.pal-group {');
    expect(group).toContain('font-size: 11px');
    expect(group).toContain('font-weight: 600');
    expect(group).toContain('text-transform: none');
    expect(ruleBody(SHELL_CSS, '.pal-row {')).toContain('font-size: 13px');
    expect(ruleBody(SHELL_CSS, '.pal-foot {')).toContain('font-size: 11px');
  });
});

describe('创作坞 P2 · 翰 / 律 / 役接线', () => {
  it('翰 = setPaletteOpen(true)；坞内 menuOpen / effectiveSlashQuery 退役', () => {
    expect(DOCK_TSX).toContain('setPaletteOpen(true)');
    expect(DOCK_TSX).not.toContain('menuOpen');
    expect(DOCK_TSX).not.toContain('effectiveSlashQuery');
  });

  it('律四组：输入 / 附卷 / 画布 / 纸面', () => {
    for (const title of ["title: '输入'", "title: '附卷'", "title: '画布'", "title: '纸面'"]) {
      expect(DOCK_TSX).toContain(title);
    }
    expect(DOCK_TSX).toContain('pp-help-group-title');
  });

  it('役空态有去处说明；大号读数只在 running > 0 时渲染', () => {
    expect(WORK_TSX).toContain('pp-work-empty-sub');
    expect(WORK_TSX).toContain('子代理与后台命令会在这里出现');
    const i = WORK_TSX.indexOf('pp-work-count');
    const before = WORK_TSX.slice(Math.max(0, i - 700), i);
    expect(before).toContain('running.length > 0');
  });
});
