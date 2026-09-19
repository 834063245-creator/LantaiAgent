// SPDX-License-Identifier: MIT

// 消息动作行 / 立枝握把的**悬停可达性**守护（2026-09-19）。
//
// 病灶（用户报「鼠标还没挪过去就消失」+「来文块的按钮和后续文字重合」）与证据：
// 真机复现台架 `prototype/msg-ops-hover-ab.html`（真 tokens.css + 真 PaperPanel.css +
// 真 Chrome 走位；A 栏复刻旧几何、B 栏现网）。旧几何实测三数：
//   ① 指针停在**块底 +1px 的缝里** → 行 opacity 0 / pointer-events none / 命中 `.flow`；
//   ② 再挪到**动作行正上方** → 仍 opacity 0，命中落回下一块的正文（`.pp-md-p`）——
//      揭示靠 hover、命中又要靠揭示（互为前提），按钮永不可命中；
//   ③ 来文块块下只有 `ANCHOR.userTailGap` 8px，19px 的行**越出块底 13px**（握把 15px）
//      压住下一块的题签与首行。
//
// 本文件钉的**不是像素，是两条纪律**（改数值可以，改结构必须重跑台架并更新本条）：
//   甲 **行盒顶边贴块底**：`top: calc(100% + 2px)` 的缝 = 死带，视觉那 2px 并进容器
//      padding（桥面）——不许回退成"留缝"；
//   乙 **来文块的行落块内尾带**（花押之上那 30px 空白）：块下 8px 塞不下 19px 的行。
//
// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANCHOR } from '../src/paper/canvas-math';
import { CHROME_TOKENS } from '../src/paper/type-tokens';

const SRC = join(__dirname, '..', 'src');
const PANEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');

/** 从选择器名截取规则体（到下一个 `}` 为止——纸壳 CSS 规则无嵌套），并**剥掉
 *  注释**：本批的规则体内联了「旧写法为什么是死带」的注（`calc(100% + 2px)` 字面
 *  出现在注里），断言只认声明。 */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i)).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 动作行实测高（台架量得 19px：mono 10px 行盒 + padding 2×2 + border 1×2）。
 *  按钮字号/padding 一改就必须重跑台架并同步本值——它是"塞不塞得下"的分母。 */
const OPS_ROW_H = 19;
/** 立枝握把实测高（同台架：21px——多 2px 来自 border + 行盒）。 */
const GRIP_H = 21;

describe('消息动作行 hover 可达性（2026-09-19 悬停可达性批）', () => {
  it('甲：动作行行盒顶边贴块底（缝 = 死带，视觉 2px 改走容器 padding 桥面）', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-msg-ops {');
    expect(rule).toContain('top: 100%');
    expect(rule).not.toContain('calc(100% + 2px)');
    // 视觉那 2px 呼吸仍在——只是并进了命中盒（透明桥面）
    expect(rule).toContain('padding-top: 2px');
    // 隐没态不吃指针（2026-08-31 纪律：透明按钮不许吃块下点击）
    expect(rule).toContain('pointer-events: none');
  });

  it('甲：hover 揭示与键盘路径（focus-within）都在册', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-block:hover .pp-msg-ops,');
    expect(rule).toContain('opacity: 1');
    expect(rule).toContain('pointer-events: auto');
    expect(PANEL_CSS).toContain('.pp-msg-ops:focus-within');
  });

  it('乙：来文块的动作行落**块内**尾带（花押行之上 2px），不回块外', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-block.pp-user .pp-msg-ops {');
    expect(rule).toContain('top: auto');
    expect(rule).toContain('bottom: calc(var(--pp-ch-user-asterismLine) + 2px)');
    expect(rule).toContain('padding-top: 0'); // 块内不需要桥面
  });

  it('乙：尾带塞得下——行底偏移 + 行高 ≤ 花押行 + 尾带空白（token 真源算的）', () => {
    const { asterismLine, asterismMarginTop } = CHROME_TOKENS.user;
    const offset = asterismLine + 2; // 行底 = 花押行之上 2px（CSS 同式）
    expect(offset + OPS_ROW_H).toBeLessThanOrEqual(asterismLine + asterismMarginTop);
    // 为什么非落块内不可：块下机械尾距（userTailGap）比行还矮
    expect(ANCHOR.userTailGap).toBeLessThan(OPS_ROW_H);
    expect(ANCHOR.userTailGap).toBeLessThan(GRIP_H);
  });

  it('握把同一条纪律：贴块底 + 桥面（实盒不能用 padding 补缝）+ 来文块落块内尾带', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-branch-grip {');
    expect(rule).toContain('top: 100%');
    expect(rule).not.toContain('calc(100% + 2px)');
    const bridge = ruleBody(PANEL_CSS, '.pp-block:not(.pp-user) .pp-branch-grip::before');
    expect(bridge).toContain('bottom: 100%');
    expect(bridge).toContain('height: 2px');
    const user = ruleBody(PANEL_CSS, '.pp-block.pp-user .pp-branch-grip {');
    expect(user).toContain('top: auto');
    expect(user).toContain('bottom: calc(var(--pp-ch-user-asterismLine) + 2px)');
  });
});
