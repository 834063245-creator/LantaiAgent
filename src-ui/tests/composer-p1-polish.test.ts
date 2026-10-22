// SPDX-License-Identifier: MIT

// 创作坞 P1 视觉系统（2026-10-22）——静态钉值。
// 这一批是「看起来不精致」的视觉口径，行为测试在 DOM 行序（composer-dock-row-order）：
//   ① 字号下限：模型菜单人读名 12 / 机器 id 10、分组题 11、律册键 12、文件路径 11、
//      文件签 11、脚注 11——9/10px 的「瞎眼档」退出人读面；
//   ② 主次反转：模型菜单旧态 id(10) > 人读名(9)，现在 name(12/600) > id(10/ink-3)；
//   ③ 红色预算：厂商章去实心朱砂（纸色底 + 墨字 + 发丝框）——朱砂留给人的动作；
//   ④ 去装饰蓝：律册键位 / 翰快捷键 / 文件签不再用石青（蓝=机器在跑/语义引注）；
//   ⑤ 左轴：textarea 是输入行第一个布局件（DOM 顺序测试在 row-order）；
//   ⑥ 设置行吃 --font-scale（此前模型/权限/思考/读数件写死 px）。

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const PANEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');
const MODEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'compose-dock', 'model-selector.css'), 'utf8');
const COMP_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'compose-dock', 'composition-chip.css'), 'utf8');

function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

describe('创作坞 P1 · 模型菜单主次与字号', () => {
  it('人读名 12/600；机器 id 10/ink-3——主次不再倒置', () => {
    const name = ruleBody(MODEL_CSS, '.ms-item-name {');
    expect(name).toContain('calc(12px * var(--font-scale))');
    expect(name).toContain('font-weight: 600');
    const id = ruleBody(MODEL_CSS, '.ms-item-id {');
    expect(id).toContain('calc(10px * var(--font-scale))');
    expect(id).toContain('--ink-3');
  });

  it('分组题 11px / 正常大小写 / 二级墨（旧 9px 全大写 mono 退役）', () => {
    const head = ruleBody(PANEL_CSS, '.pp-composer-settings .ms-dropdown .ms-group-head {');
    expect(head).toContain('calc(11px * var(--font-scale))');
    expect(head).toContain('text-transform: none');
    expect(head).toContain('--ink-2');
  });

  it('模型触发器 215px + 名称 600 + 吃 font-scale', () => {
    expect(ruleBody(PANEL_CSS, '.pp-composer-settings .ms-container {')).toContain('flex: 0 0 215px');
    const trigger = ruleBody(PANEL_CSS, '.pp-composer-settings .ms-container .ms-trigger {');
    expect(trigger).toContain('calc(12px * var(--font-scale))');
    const name = ruleBody(PANEL_CSS, '.pp-composer-settings .ms-trigger-name {');
    expect(name).toContain('font-weight: 600');
    expect(name).toContain('--ink-1');
  });
});

describe('创作坞 P1 · 红色预算与去装饰蓝', () => {
  it('厂商章不再实心朱砂（纸色底 + ink-2 字 + ink-4 框）', () => {
    const mark = ruleBody(PANEL_CSS, '.pp-composer-settings .ms-provider-mark {');
    expect(mark).toContain('background: var(--paper-deep)');
    expect(mark).toContain('color: var(--ink-2)');
    expect(mark).toContain('border: 1px solid var(--ink-4)');
    expect(mark).not.toContain('background: var(--seal)');
  });

  it('律册键位 / 翰快捷键 / 文件签不再用石青；文件签改 11px 二级墨', () => {
    const key = ruleBody(PANEL_CSS, '.pp-help-key {');
    expect(key).toContain('calc(12px * var(--font-scale))');
    expect(key).toContain('--ink-2');
    expect(key).not.toContain('--indigo');
    expect(ruleBody(PANEL_CSS, '.pp-slash-shortcut {')).not.toContain('--indigo');
    const chip = ruleBody(PANEL_CSS, '.pp-attach-chip {');
    expect(chip).toContain('calc(11px * var(--font-scale))');
    expect(chip).toContain('--ink-2');
    expect(chip).not.toContain('--indigo');
  });
});

describe('创作坞 P1 · 只读件与设置行字号', () => {
  it('组合芯片只读态 ink-2（只读不等于读不清）', () => {
    const locked = ruleBody(COMP_CSS, '.pp-composer-settings .pp-comp-pill[data-locked] {');
    expect(locked).toContain('--ink-2');
    expect(locked).toContain('cursor: default');
  });

  it('设置行主要控件吃 --font-scale（模型/权限/思考/墨/役）', () => {
    for (const selector of [
      '.pp-composer .pp-mode-opt {',
      '.pp-composer-settings .pp-thinking-pill {',
      '.pp-composer-settings .pp-ink-trigger {',
      '.pp-composer-settings .pp-work-trigger {',
    ]) {
      expect(ruleBody(PANEL_CSS, selector)).toContain('var(--font-scale)');
    }
  });

  it('透明文字控件的键盘焦点 = 朱砂底线（模型触发器不画 2px 红框）', () => {
    expect(PANEL_CSS).toContain('.pp-composer-settings .ms-trigger:focus-visible');
    const i = PANEL_CSS.indexOf('.pp-composer-settings .ms-trigger:focus-visible');
    const block = PANEL_CSS.slice(i, PANEL_CSS.indexOf('}', i));
    expect(block).toContain('outline: none');
    expect(block).toContain('inset 0 -2px 0 var(--seal)');
  });
});
