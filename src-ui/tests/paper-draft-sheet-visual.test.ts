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

/** 取某个选择器的规则体。
 *  ⚠ 按**行首**锚定（2026-11-19）：卷首档行里存在 `.pp-draft-sheet .pp-folio-sub .pp-folio-picks`
 *  这种「以同一串结尾」的复合选择器，裸 indexOf 会先撞上它、取回别人的规则体
 *  （实测把 ⑨ 判成「没有 justify-content」）。 */
function ruleOf(selector: string): string {
  const anchored = `\n${selector} {`;
  const at = CSS.indexOf(anchored);
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

  /* ⚠ 2026-11-28 第二次报障（用户：「题签的组合和权限下拉点不开」）的病灶形状。
   * 绝对定位盒**同时**拿到 top 与 bottom 且 height:auto ⇒ 高度由等式解出
   * （容器高 − top − bottom）；旧签上这两个值都是「100% + 4px」⇒ 解出负数夹 0
   * ⇒ 菜单是个 0 高的空盒，点开等于没开。
   * **2026-11-19 题签重画批**：那枚「贴在纸上的签」整段退役，三笔搬进卷首第三行
   * （.pp-folio-pick），病灶形状与治法**原样保留**——本组改成钉新的宿主。
   * 缺一件（撤 bottom / 给 top / pop-down）就是又白改一次。 */
  it('⑧ 题签行下拉向下开：撤 bottom + 给 top + pop-down（缺 bottom:auto = 盒高解成 0）', () => {
    const menu = ruleOf('.pp-folio-pick-menu');
    expect(menu).toContain('position: absolute');
    expect(menu).toContain('bottom: auto');
    expect(menu).toContain('top: calc(100% + 5px)');
    expect(menu).toContain('animation: pop-down');
    // 每一格各自有定位盒（挂整行 = 窄纸上开在版心之外）
    const at = CSS.indexOf('.pp-folio-pick {');
    expect(at).toBeGreaterThan(-1);
    expect(CSS.slice(CSS.indexOf('{', at), CSS.indexOf('}', at))).toContain('position: relative');
  });

  /* 2026-11-19 题签重画批的**形态判据**（用户：「题签有点丑爆了」）：
   * 那枚纸签的材质（深底色 / 朱印 / 假歪 / 硬投影 / 预演句）一律不许写回来。 */
  it('⑨ 题签不进纸身：没有纸签材质（底色 / 朱印 / 假歪 / 硬投影 / 预演句）', () => {
    expect(CSS).not.toContain('.pp-composer-settings[data-variant="sheet"]');
    expect(CSS).not.toContain('.pp-sheet-prev');
    expect(CSS).not.toContain('.pp-sheet-comp');
    expect(CSS).not.toContain('rotate(-0.22deg)');
    // 三笔落进卷首第三行：行内、与卷首同轴（justify-content: center），且不画框
    const row = ruleOf('.pp-folio-picks');
    expect(row).toContain('justify-content: center');
    expect(row).not.toContain('background:');
    expect(row).not.toContain('box-shadow');
    // 卷首本体 pointer-events:none，本行是唯一例外（同组合芯片）
    expect(row).toContain('pointer-events: auto');
    // 小字签 / 值 / caret 的墨阶：值墨二、签墨四、caret 静止不可见（§11 锚点型）
    expect(ruleOf('.pp-folio-pick-v')).toContain('var(--ink-2)');
    expect(ruleOf('.pp-folio-pick-k')).toContain('var(--ink-4)');
    expect(ruleOf('.pp-folio-pick-caret')).toContain('opacity: 0');
  });

  /* ⚠ 2026-11-19 真机返工（用户：「UI 错位，模型下拉菜单缩成一团，权限切换弹窗鼠标操作被吞」）。
   * 三条都是「坞期规则被 .pp-composer 祖先限定、卷首不在坞里」的连带后果——钉住它们，
   * 免得下次「统一到坞期那套」时又踩同一脚。 */
  it('⑩ 模型那格不折行、不缩（错位的根因：子件各自 block 会把一行拆三行）', () => {
    const trig = ruleOf('.pp-folio-pick-model .ms-trigger');
    expect(trig, '缺触发器显式 display（坞期那条被祖先限定）').toContain('display: inline-flex');
    expect(trig, '缺 nowrap（140px 里字会被折成两行）').toContain('white-space: nowrap');
    expect(trig, '行高必须与档行一致').toContain('line-height: 15px');
    // 子件不许缩：只给容器 nowrap 不够，收缩发生在 flex item 内部
    const kids = ruleOf('.pp-folio-pick-model .ms-trigger > *');
    expect(kids).toContain('flex: 0 0 auto');
    expect(kids).toContain('white-space: nowrap');
  });

  it('⑪ 模型下拉在卷首的宽度契约（缩成一团 = 坞期 left/right 拉扯被搬进 140px 的行）', () => {
    const menu = ruleOf('.pp-folio-pick-model .ms-dropdown');
    expect(menu, '必须撤掉坞期那条 right 拉扯').toContain('right: auto');
    expect(menu).toContain('width: max-content');
    expect(menu, '下限要够两级菜单读').toContain('min-width: 260px');
  });
});
