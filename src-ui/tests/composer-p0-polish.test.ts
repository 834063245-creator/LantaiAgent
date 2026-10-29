// SPDX-License-Identifier: MIT

// 创作坞 P0 精修（2026-10-21）——CSS/接线字面量钉值。
// 这一批全是「看起来差一点」的硬细节，行为测试（滚动条、浮层朝向、禁用印）
// 在各自组件文件里；本文件只钉那些 jsdom 量不到的静态决定，防回漂：
//   ① 输入框不再出现原生滚动条（1px 溢出 + 全局 standard 属性双因）
//   ② 空输入 = 空心印（禁用态），不再冒充可点的主动作
//   ③ 坞内浮层随坞位换向（data-pop-side + --dock-room-*）
//   ④ 模型菜单选中行归队 --sel-wash + 朱砂左脊（禁 seal-soft 第三色）
//   ⑤ 小热区用伪元素撑到 ≥28×28（视觉尺寸不动）

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const PANEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');
const MODEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'compose-dock', 'model-selector.css'), 'utf8');
const FOUNDATION_CSS = readFileSync(join(SRC, 'app', 'foundation.css'), 'utf8');
const DOCK_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'compose-dock', 'ComposerDock.tsx'), 'utf8');
const PAPER_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx'), 'utf8');
const FLOAT_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'use-composer-float.ts'), 'utf8');
const FLOAT_GEOM_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'composer-float.ts'), 'utf8');

/** 从首个选择器出现处截到规则体结束（本仓 CSS 无嵌套；够用且不误伤 @media）。 */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

describe('创作坞 P0 · 滚动条', () => {
  it('输入框不再挂原生滚动条（scrollbar-width:none + WebKit 隐藏）', () => {
    /* 精确取第二个 textarea 块（基础块的选择器是 `input,\ntextarea`，首匹配会拿错）。 */
    const i = PANEL_CSS.indexOf('.pp-composer textarea {\n  resize: none;');
    expect(i).toBeGreaterThan(-1);
    const block = PANEL_CSS.slice(i, PANEL_CSS.indexOf('}', i));
    expect(block).toContain('scrollbar-width: none');
    expect(PANEL_CSS).toContain('.pp-composer textarea::-webkit-scrollbar');
    expect(ruleBody(PANEL_CSS, '.pp-composer textarea::-webkit-scrollbar')).toContain('display: none');
  });

  it('全局 standard 属性侧不再压过 WebKit 纸面滚动条', () => {
    expect(FOUNDATION_CSS).not.toMatch(/\*\s*\{[^}]*scrollbar-width:\s*thin/);
  });
});

describe('创作坞 P0 · 空印禁用', () => {
  it('空输入 = 空心印（无墨底、无硬投影）', () => {
    const block = ruleBody(PANEL_CSS, '.pp-composer .pp-send:disabled');
    expect(block).toContain('background: transparent');
    expect(block).toContain('box-shadow: none');
    expect(block).toContain('--ink-4');
  });

  it('按钮由 inputText.trim() 驱动禁用；点空输入不发消息', () => {
    expect(DOCK_TSX).toContain('disabled={!inputText.trim()}');
    expect(DOCK_TSX).toContain('有内容才可拟文');
  });
});

describe('创作坞 P0 · 浮层随坞位换向', () => {
  it('槽下发 data-pop-side，两侧余量走 --dock-room-*（坞本体一字不知）', () => {
    expect(PAPER_TSX).toContain('data-pop-side={composer.popSide}');
    expect(FLOAT_GEOM_TS).toContain('composerPopSide');
    expect(FLOAT_TS).toContain("'--dock-room-up'");
    expect(FLOAT_TS).toContain("'--dock-room-down'");
    expect(DOCK_TSX).not.toContain('data-pop-side');
    expect(PANEL_CSS).toMatch(/data-pop-side=('|")down\1/);
    expect(PANEL_CSS).toContain('--dock-room-down');
    expect(PANEL_CSS).toContain('--dock-room-up');
  });

  it('向下面板解除 bottom、改贴 top（原 4/6/8 间隙分组保留）', () => {
    expect(PANEL_CSS).toContain('top: calc(100% + 4px)');
    expect(PANEL_CSS).toContain('top: calc(100% + 6px)');
    expect(PANEL_CSS).toContain('top: calc(100% + 8px)');
    expect(PANEL_CSS).toContain('bottom: auto');
  });
});

describe('创作坞 P0 · 选中语言', () => {
  it('模型菜单选中行 = --sel-wash + 朱砂左脊，不再用 seal-soft', () => {
    const block = ruleBody(MODEL_CSS, '.ms-item.selected {');
    expect(block).toContain('--sel-wash');
    expect(block).toContain('inset 2px 0 0 var(--seal)');
    expect(block).not.toContain('--seal-soft');
  });
});

describe('创作坞 P0 · 热区与无障碍名', () => {
  it('单字钮/读数件用伪元素撑命中面（视觉尺寸不变）', () => {
    expect(PANEL_CSS).toContain('.pp-composer .pp-dock-tools .pp-tool-btn::after');
    expect(PANEL_CSS).toContain('inset: -4px');
    expect(PANEL_CSS).toContain('min-height: 28px');
  });

  it('单字工具钮有完整无障碍名', () => {
    expect(DOCK_TSX).toContain('aria-label="翰——打开命令面板"');
    expect(DOCK_TSX).toContain('aria-label="律——快捷键总览"');
    expect(DOCK_TSX).toContain('解锁创作坞（可拖动）');
  });
});
