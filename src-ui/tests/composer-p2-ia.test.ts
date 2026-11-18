// SPDX-License-Identifier: MIT

// 创作坞 P2 信息架构（2026-10-22）——静态钉值。
// 行为面在 composer-dock-desk（/ 内联面板仍通）与 composer-dock-work-ledger（空态一句 + 去处说明）；
// 本文件钉材质与源码接线：
//   ① 命令面板回纸（去 glass/blur；组题 11/600，行 13，脚 11）；
//   ② 坞内不再维护第二份命令清单（menuOpen / effectiveSlashQuery 恒不复活）；
//   ③ 律（快捷键总览）分组在册——**2026-11-28 起数据面搬去 app/help/shortcut-groups.ts**
//      （「案」抽屉退役，律册成为应用级帮助页；分组多了「全局」一组）；
//   ④ 役空态第二行存在（大号 0 / 段题只在真有活时出现）。

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDockSources } from './helpers/dock-source';

const SRC = join(__dirname, '..', 'src');
const SHELL_CSS = readFileSync(join(SRC, 'app', 'shell.css'), 'utf8');
// 2026-11-17 P6：坞拆成多件——源码级断言读**整个包**（断言字符串不动）。
const DOCK_TSX = readDockSources();
const WORK_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'compose-dock', 'WorkLedger.tsx'), 'utf8');
/** 律册数据面（2026-11-28 从 dock-copy.ts 搬到 app 层）。 */
const SHORTCUT_TS = readFileSync(join(SRC, 'app', 'help', 'shortcut-groups.ts'), 'utf8');

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

  // 2026-11-06 字阶批：11/13/11 → 字阶档 caption/body/caption（值由 tests/ui-type-scale 守）。
  it('组题 caption/600 去大写；行 body；脚 caption', () => {
    const group = ruleBody(SHELL_CSS, '.pal-group {');
    expect(group).toContain('font-size: var(--fs-caption)');
    expect(group).toContain('font-weight: 600');
    expect(group).toContain('text-transform: none');
    expect(ruleBody(SHELL_CSS, '.pal-row {')).toContain('font-size: var(--fs-body)');
    expect(ruleBody(SHELL_CSS, '.pal-foot {')).toContain('font-size: var(--fs-caption)');
  });
});

describe('创作坞 P2 · 翰 / 律 / 役接线', () => {
  it('坞内不再有命令面板入口（翰随「案」抽屉退役）；第二份斜杠清单恒不复活', () => {
    // 2026-11-28：「案」抽屉整只退役 ⇒ 翰钮没了，Ctrl+K 由全局快捷键/全局搜索承担。
    // 判据的**本意**没变——坞里不许再长第二份命令清单。
    expect(DOCK_TSX).not.toContain('setPaletteOpen');
    expect(DOCK_TSX).not.toContain('menuOpen');
    expect(DOCK_TSX).not.toContain('effectiveSlashQuery');
  });

  it('律（快捷键总览）分组在册：五组（2026-11-28 多一组「全局」）', () => {
    // 2026-11-28：律册随「案」抽屉退役搬去 app 层（应用级帮助页）——判据不变，读新落位。
    for (const title of ["title: '全局'", "title: '输入'", "title: '附卷'", "title: '画布'", "title: '纸面'"]) {
      expect(SHORTCUT_TS).toContain(title);
    }
    // 渲染面在 HelpSheet（.help-group-title），不再是坞内就地展开
    expect(SHELL_CSS).toContain('.help-group-title');
  });

  it('役空态有去处说明；大号读数只在 running > 0 时渲染', () => {
    expect(WORK_TSX).toContain('pp-work-empty-sub');
    expect(WORK_TSX).toContain('子代理与后台命令会在这里出现');
    const i = WORK_TSX.indexOf('pp-work-count');
    const before = WORK_TSX.slice(Math.max(0, i - 700), i);
    expect(before).toContain('running.length > 0');
  });
});
