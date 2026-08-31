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
const PANEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');
const HOME_CSS = readFileSync(join(SRC, 'app', 'foundation.css'), 'utf8');
const PANEL_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx'), 'utf8');
const ICONS_TS = readFileSync(join(SRC, 'ui', 'icons.ts'), 'utf8');
const MEASURE_TS = readFileSync(join(SRC, 'paper', 'measure.ts'), 'utf8');
const TYPE_TOKENS_TS = readFileSync(join(SRC, 'paper', 'type-tokens.ts'), 'utf8');
const TOKENS_CSS = readFileSync(join(SRC, 'app', 'tokens.css'), 'utf8');
const FONTS_TS = readFileSync(join(SRC, 'app', 'fonts.ts'), 'utf8');

/** 从选择器名截取规则体（到下一个 `}` 为止——纸壳 CSS 规则无嵌套）。 */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

describe('纸壳视觉定稿钉值（B3/B4/B5）', () => {
  it('B4：来文 22px/1.65 朱砂深（token 化后守真源 + CSS 变量引用）', () => {
    // 真源钉值（type-tokens.ts）——2026-08-30 标题化：题 > 正文 17
    expect(TYPE_TOKENS_TS).toContain('user: { size: 22, lh: 1.65');
    // CSS 侧引用同一 token（不再写死字面量）
    const userBody = ruleBody(PANEL_CSS, '.pp-block.pp-user .pp-body');
    expect(userBody).toContain('font-size: var(--pp-type-user-size)');
    expect(userBody).toContain('line-height: var(--pp-type-user-lh)');
    expect(userBody).toContain('var(--seal-deep)');
  });

  it('B5：diff add 松绿 / del 朱砂深删除线', () => {
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

  it('界栏（规格书 §1 + 浸墨 §10 双线框）：流区 = 古籍叶，四边 2px 墨框 + 内衬发丝，框走墨系不走朱砂', () => {
    const region = ruleBody(PANEL_CSS, '.pp-region {');
    // 四边版框：外 2px 墨 + 内衬发丝（古籍双栏线）
    expect(region).toContain('border: 2px solid');
    expect(region).toContain('var(--ink-1)');
    expect(region).toContain('outline-offset: -5px');
    // 框是墨系结构件——朱砂=人铁律，框不沾朱砂
    expect(region).not.toContain('var(--seal)');
    const active = ruleBody(PANEL_CSS, '.pp-region-active');
    // 活跃卷示活走洗底朱砂 + 框提全墨，框本体仍是墨
    expect(active).toContain('border-color: var(--ink-1)');
    expect(active).toContain('var(--seal) 4%');
  });

  it('块入场（2026-08-30 流式生命感）：入场动画单次（尾笔已由用户拍板拆除）', () => {
    // 尾笔（pp-tail）2026-08-30 用户拍板拆除——见 taste-ledger 翻案；只钉入场
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-tail')).toBe('');
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

  it('测量镜像：type-tokens.ts 卷首真源与 CSS 逐字对映 + 亭徽图标在册', () => {
    // token 化后单一真源 = type-tokens.ts（measure 派生自它，CSS 走 --pp-* 注入）
    expect(TYPE_TOKENS_TS).toContain('titleSize: 32');
    expect(TYPE_TOKENS_TS).toContain('titleLh: 1.2');
    expect(TYPE_TOKENS_TS).toContain('padTop: 24');
    expect(TYPE_TOKENS_TS).toContain('headGap: 28');
    expect(MEASURE_TS).toContain('FOLIO_TOKENS.titleSize');
    expect(MEASURE_TS).toContain('export function measureFolioHeadHeight');
    expect(ICONS_TS).toContain('lantai: {');
    expect(ICONS_TS).toContain('M4 9.2 L12 3.4 L20 9.2');
  });
});

describe('浸墨法则钉值（规格书 §10，2026-08-31 用户拍板 B）', () => {
  it('法则入宪：tokens 载 --weight-display/--shadow-anchor/--vignette/--laid-lines，字体装载 900', () => {
    expect(TOKENS_CSS).toContain('--weight-display: 900');
    expect(TOKENS_CSS).toContain('--shadow-anchor: 2px 3px 0');
    expect(TOKENS_CSS).toContain('--vignette: radial-gradient');
    expect(TOKENS_CSS).toContain('--laid-lines: repeating-linear-gradient');
    expect(FONTS_TS).toContain('noto-serif-sc/900.css');
  });

  it('墨阶锚点：书眉/列顶/脚线/坞顶升硬线，主钮投影', () => {
    expect(ruleBody(HOME_CSS, '.sh-head {')).toContain('border-bottom: var(--rule-hard)');
    expect(ruleBody(HOME_CSS, '.sh-workspaces {')).toContain('border-top: var(--rule-hard)');
    expect(ruleBody(HOME_CSS, '.sh-foot {')).toContain('border-top: var(--rule-hard)');
    expect(ruleBody(PANEL_CSS, '.pp-topbar {')).toContain('border-bottom: var(--rule-hard)');
    expect(ruleBody(PANEL_CSS, '.pp-composer {')).toContain('border-top: var(--rule-hard)');
    const send = ruleBody(PANEL_CSS, '.pp-composer .pp-send');
    expect(send).toContain('box-shadow: var(--shadow-anchor)');
    expect(send).toContain('font-weight: 600');
  });

  it('版口钮：坞顶 56px 朱砂（全坞唯一暖色件）', () => {
    const btn = ruleBody(PANEL_CSS, '.pp-composer::before');
    expect(btn).toContain('width: 56px');
    expect(btn).toContain('var(--seal)');
  });

  it('字重极端：题字 900 / 卷首 700 / 卷名 600；句读点朱', () => {
    expect(ruleBody(HOME_CSS, '.sh-h1')).toContain('var(--weight-display)');
    expect(ruleBody(HOME_CSS, '.sh-h1 .sh-ju')).toContain('var(--seal)');
    expect(ruleBody(PANEL_CSS, '.pp-folio-title')).toContain('font-weight: 700');
    expect(ruleBody(PANEL_CSS, '.pp-composer-target')).toContain('font-weight: 600');
    expect(ruleBody(PANEL_CSS, '.pp-empty-title')).toContain('var(--weight-display)');
  });

  it('纸层次（2026-09-01 真纸化）：真纹理双资产乘印 + SVG 微颗粒 + 顶光边沉帘纹（sh-root::before/::after）', () => {
    // 真纸纹理资产接线（feTurbulence 程序噪声退役——真纤维/斑点，cover 免接缝）
    expect(HOME_CSS).toContain('../assets/paper/paper-grain.jpg');
    expect(HOME_CSS).toContain('../assets/paper/paper-fiber.jpg');
    expect(HOME_CSS).toContain('background-blend-mode: normal, multiply, multiply');
    expect(HOME_CSS).toContain('mix-blend-mode: multiply');
    // 极弱 SVG 微颗粒保留（抗色带）
    expect(HOME_CSS).toContain("opacity='0.05'");
    // 纸层次：顶光 + 帘纹 + 边沉
    expect(HOME_CSS).toContain('.sh-root::before');
    expect(HOME_CSS).toContain('var(--light-fall)');
    expect(HOME_CSS).toContain('var(--laid-lines)');
    expect(HOME_CSS).toContain('var(--vignette)');
    expect(TOKENS_CSS).toContain('--light-fall: linear-gradient');
  });

  it('选中态文字语言：重墨 + 朱砂底线（2026-09-01 重皮拍板：盒装黑块退役——设置行唯一墨底锚点只留拟文印）', () => {
    const sel = ruleBody(PANEL_CSS, '.pp-mode-opt.selected');
    expect(sel).toContain('background: transparent');
    expect(sel).toContain('color: var(--ink-1)');
    expect(sel).toContain('border-bottom-color: var(--seal)');
  });

  it('节题墨块锚点（首页）', () => {
    expect(ruleBody(HOME_CSS, '.sh-section-title .t::before')).toContain('background: var(--ink-1)');
    expect(ruleBody(HOME_CSS, '.sh-section-title .n')).toContain('var(--seal-deep)');
  });
});
