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
const PANEL_TSX = readFileSync(join(SRC, 'app', 'panels', 'PaperPanel.tsx'), 'utf8');
const ICONS_TS = readFileSync(join(SRC, 'ui', 'icons.ts'), 'utf8');
const MEASURE_TS = readFileSync(join(SRC, 'paper', 'measure.ts'), 'utf8');

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

  it('界栏（规格书 §1 锁定件 2026-08-30 落地）：流区左右栏线走墨系不走朱砂', () => {
    const region = ruleBody(PANEL_CSS, '.pp-region {');
    // 左右栏线存在
    expect(region).toContain('border-left-color');
    expect(region).toContain('border-right-color');
    // 栏线是墨系结构件——朱砂=人铁律，栏线不沾朱砂
    expect(region).toContain('var(--ink-2)');
    expect(region).not.toContain('var(--seal)');
    const active = ruleBody(PANEL_CSS, '.pp-region-active');
    // 活跃卷示活走洗底朱砂 + 栏线提浓，栏线本体仍是墨
    expect(active).toContain('var(--seal) 4%');
    expect(active).toContain('var(--ink-2) 48%');
  });

  it('流式尾笔与块入场（2026-08-30 流式生命感）：尾笔绝对定位不入测高、石青运行态语义、入场动画单次', () => {
    const tail = ruleBody(PANEL_CSS, '.pp-block.pp-tail::after');
    // 挂件路线：绝对定位不占流内高度（测量镜像纪律——任何入流高度的视觉必须同步 measure.ts）
    expect(tail).toContain('position: absolute');
    // 运行态语义族恒石青（铁律：石青=机——机器仍在书写），朱砂=人不得挪用
    expect(tail).toContain('var(--indigo)');
    expect(tail).not.toContain('var(--seal');
    const enter = ruleBody(PANEL_CSS, '.pp-block.pp-enter');
    expect(enter).toContain('animation: pp-enter');
  });
});

describe('卷首 folio-head 钉值（2026-08-30 原型转录：prototype/lantai.html .folio-head 族）', () => {
  it('卷首结构：玉徽居中钤印 + 硬规线底 + 朱砂版口钮；浮动标签带退役', () => {
    const head = ruleBody(PANEL_CSS, '.pp-folio-head');
    expect(head).toContain('border-bottom: var(--rule-hard)');
    // pointer-events none：点击穿透流区背景，激活语义不变
    expect(head).toContain('pointer-events: none');
    const yuwei = ruleBody(PANEL_CSS, '.pp-yuwei');
    expect(yuwei).toContain('margin: 0 auto 12px');
    expect(yuwei).toContain('width: 24px');
    const tab = ruleBody(PANEL_CSS, '.pp-folio-head::after');
    expect(tab).toContain('width: 56px');
    expect(tab).toContain('height: 3px');
    // 版口钮是朱砂——卷首钤印语义（朱砂=人/仪式），非状态色挪用
    expect(tab).toContain('background: var(--seal)');
    // 标签带退役（卷首即卷名，不重复播报）
    expect(PANEL_CSS).not.toContain('.pp-region-label');
    expect(PANEL_TSX).toContain('pp-folio-head');
    expect(PANEL_TSX).not.toContain('pp-region-label');
  });

  it('卷首排印：眉行/题字/档行字号字距（原型逐字转录）', () => {
    const eyebrow = ruleBody(PANEL_CSS, '.pp-folio-eyebrow');
    expect(eyebrow).toContain('font-size: 10px');
    expect(eyebrow).toContain('letter-spacing: 0.26em');
    expect(eyebrow).toContain('var(--ink-3)');
    const title = ruleBody(PANEL_CSS, '.pp-folio-title');
    expect(title).toContain('font-size: 32px');
    expect(title).toContain('line-height: 1.2');
    expect(title).toContain('var(--f-song)');
    const sub = ruleBody(PANEL_CSS, '.pp-folio-sub');
    expect(sub).toContain('letter-spacing: 0.14em');
    expect(sub).toContain('font-variant-numeric: tabular-nums');
  });

  it('测量镜像：measure.ts 卷首常量与 CSS 逐字对映 + 亭徽图标在册', () => {
    expect(MEASURE_TS).toContain('FOLIO_TITLE_LINE_HEIGHT = 32 * 1.2');
    expect(MEASURE_TS).toContain('FOLIO_PAD_TOP = 24');
    expect(MEASURE_TS).toContain('FOLIO_HEAD_GAP = 28');
    expect(MEASURE_TS).toContain('export function measureFolioHeadHeight');
    expect(ICONS_TS).toContain('lantai: {');
    expect(ICONS_TS).toContain('M4 9.2 L12 3.4 L20 9.2');
  });
});
