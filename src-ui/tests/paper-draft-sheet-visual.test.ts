// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸 · 视觉判据（2026-11-14 立项 v3 注疏三段式 → **2026-11-15 V2 重写**）。
//
// 这一组钉的不是像素，而是**几条被判过死刑的形态不许复活**：
//   · v2「题签套 1px 外框 + 落影」= 输入框组（§11 致死动作①「万物皆框」）；
//   · 玉徽套框 = 把钤印做成图标框（v2 实测更丑）；
//   · V1「纸高写死」= 输入面进纸后必然压线（V2 拆了 DRAFT_BODY_H）。
// 判据全部读 CSS 源码文本——与 tests/paper-visual-decisions 的源文本钉值同族。
// 真机手感仍以用户走查为准，这里只钉「方向不许漂回去」。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(__dirname, '..', 'src', 'plugins', 'builtin', 'paper-shell', 'draft-sheet.css'), 'utf8');

/** 取某个选择器的规则体（第一个匹配的 {...}）。 */
function ruleOf(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  if (at < 0) return '';
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('待题纸 · V2 形态（纸 = 卷首 + 这张卷的创作坞）', () => {
  it('① 纸不套外框（v2 判死的形态）：纸体与纸栈都没有 border', () => {
    expect(ruleOf('.pp-draft-sheet')).not.toContain('border:');
    expect(ruleOf('.pp-draft-stack')).not.toContain('border:');
  });

  it('② 玉徽不套框（v2 实测更丑）：卷首玉徽规则里没有 border', () => {
    const yuwei = CSS.slice(CSS.indexOf('.pp-draft-sheet .pp-yuwei'), CSS.indexOf('.pp-draft-sheet .pp-yuwei') + 300);
    expect(yuwei).not.toContain('border:');
  });

  it('③ 卷号是填空题：题字里是一条待填的线，不是真卷号', () => {
    const num = ruleOf('.pp-draft-num');
    expect(num).toContain('border-bottom');
    expect(num).toContain('dashed');
  });

  it('④ 纸上的坞**去匣**：纸即界面，不叠第二层壳（透明底 + 只留分区硬线）', () => {
    const dock = ruleOf('.pp-draft-sheet .pp-composer');
    expect(dock).toContain('background: transparent');
    // 版口钮（坞顶左端那 56px 朱砂）在纸上不存在——朱砂已被眉行占用
    expect(CSS).toContain('.pp-draft-sheet .pp-composer::before');
    expect(
      CSS.slice(
        CSS.indexOf('.pp-draft-sheet .pp-composer::before'),
        CSS.indexOf('.pp-draft-sheet .pp-composer::before') + 120,
      ),
    ).toContain('content: none');
  });

  it('⑤ 纸上没有第二个主动作：开卷按钮的样式整套退役', () => {
    expect(CSS).not.toContain('.pp-draft-open');
  });

  it('⑥ 版式：天头以下**一整块流式栈**，禁逐段手算 top', () => {
    const positioned = [...CSS.matchAll(/^\.(pp-draft-[a-z-]+) \{/gm)].map((m) => m[1]);
    const withPosition = positioned.filter((sel) => ruleOf(`.${sel}`).includes('position: absolute'));
    // V2 一处都不允许：纸高随内容长，任何绝对定位都会在增行时压线
    expect(withPosition).toEqual([]);
  });

  it('⑦ 纸体不得声明 transform/translate（纸律：整叶不动，纸纹与 InkLayer 对位）', () => {
    const sheet = ruleOf('.pp-draft-sheet');
    expect(sheet).not.toContain('transform');
    expect(sheet).not.toContain('translate');
  });
});
