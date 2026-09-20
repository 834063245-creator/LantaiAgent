// SPDX-License-Identifier: MIT

// 消息动作行 / 立枝握把的**悬停可达性 + 造型**守护（2026-09-19 → 2026-09-20）。
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
// 2026-09-20 造型批（用户报「这些按钮真的太丑了」；台架 `prototype/msg-ops-style-ab.html`
// 四栏并排出图出数，诊断与代价见同名 .NOTES.md）——**显式规格变更**，本文件同批改写：
//   甲/乙 两条纪律**原样保留**（行盒顶边贴块底 + 来文块的行落块内尾带），只是分母从
//   19px 换成 24px（去框后命中盒靠隐形 padding 撑高）；握把那条从「块外落位 + 2px
//   桥面」改为「行盒之内」——**旧形态的两段 CSS 已删除**，测试同步改写（不是放宽）。
//
// 本文件钉的**不是像素，是两条纪律**（改数值可以，改结构必须重跑台架并更新本条）：
//   甲 **行盒顶边贴块底**：`top: calc(100% + 2px)` 的缝 = 死带，视觉那 2px 并进容器
//      padding（桥面）——不许回退成"留缝"；
//   乙 **来文块的行落块内尾带**（花押之上那 30px 空白）：块下 8px 塞不进 24px 的行。
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

/** 剥掉注释的整份 CSS。断「某段规则不存在」必须用这一份：本批把「旧写法为什么
 *  退役」写进了批注（注里就带着旧选择器字面），对原文做 contains 会假红。 */
const PANEL_CSS_CODE = PANEL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** 动作行实测高（2026-09-20 造型批台架重测：11px 字 + line-height 16 + 按钮 padding
 *  2×4 + 行 padding-top 2 = 24px；旧形态 19px = 10px 字 + 2×2 padding + 2×1 border）。
 *  按钮字号/padding 一改就必须重跑台架并同步本值——它是"塞不塞得下"的分母。 */
const OPS_ROW_H = 24;
/** 行内六点握把实测高（同台架：16px——`height: 16` 走 border-box，六点 2×3 正好
 *  落在 content 10px 里）。它现在**住在行盒里**由行高承载（≤ OPS_ROW_H），
 *  不再是自己挂着的一条腿。 */
const GRIP_H = 16;

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

  it('握把住进动作行行盒（2026-09-20 造型批）——块外落位与 2px 缝桥面两段已退役', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-branch-grip {');
    // 进流：随行盒落位。旧形态是 `position: absolute; top: 100%; right: 0`（块右端独立方框）
    expect(rule).toContain('position: static');
    expect(rule).not.toContain('top: 100%');
    expect(rule).not.toContain('right: 0');
    // 显示随行（行的 opacity / pointer-events 管）
    expect(rule).not.toContain('opacity: 0');
    // 缝补丁随「块外落位」一起退役——行盒之内没有缝（那两段不许复活）
    expect(PANEL_CSS_CODE).not.toContain('.pp-block:not(.pp-user) .pp-branch-grip::before');
    expect(PANEL_CSS_CODE).not.toContain('.pp-block.pp-user .pp-branch-grip {');
  });

  it('造型批：来文块的行居中于版心轴（回复块左齐）', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-block.pp-user .pp-msg-ops {');
    expect(rule).toContain('left: 50%');
    expect(rule).toContain('transform: translateX(-50%)');
  });

  it('造型批：按钮去框去底——命中盒靠隐形 padding 撑到 24px，行盒自持纸色遮罩', () => {
    const btn = ruleBody(PANEL_CSS, '.pp-msg-ops button {');
    expect(btn).toContain('border: none');
    expect(btn).toContain('background: none');
    expect(btn).toContain('padding: 4px 7px');
    // 行越出块底时（回复块那条腿）盖住被越过的字：遮罩是纸色（同底同色 ⇒ 不显形）
    expect(ruleBody(PANEL_CSS, '.pp-msg-ops {')).toContain('background: var(--paper)');
    // 置灰降级归 :disabled（旧写法是 JSX 内联 opacity）
    expect(PANEL_CSS).toContain('.pp-msg-ops button:disabled');
    // 禁用件照样吃 :hover ⇒ 点亮规则必须排掉它（置灰件不许被 hover 转朱）
    expect(PANEL_CSS).toContain('.pp-msg-ops button:not(:disabled):hover');
  });
});
