// SPDX-License-Identifier: MIT

// 纸壳视觉定稿钉值（B 段审美循环，2026-08-23）——CSS 字面量断言防回漂。
// node 环境：readFileSync 读文件（jsdom 下 node: 模块 baseline 不可用，?raw 被 vitest css
// 管线吞成空串——两条替代路都试过，此文件头注释是唯一可行位）。
//
// 锁的定稿：
//   B3 环1（用户拍板 B 提墨）：信息承载五处 ink-3→ink-2
//   B4 环1（用户拍板 C）：来文身 18px→16px/1.9（seal-deep 不变，收正文 17 之下）
//   B5 环2（用户拍板 红绿墨色化）：diff add=松绿(--pass) / del=朱砂深(--seal-deep)+删除线
//   2026-09-02 贴纸纹理归属批（透明错觉根治）：纹理随纸走——桌面纹/流区纹各有其主；
//     帘纹不进流区（实机过审「横纹消失」）；文档级纹理/帘纹画布态退役，首页/面板照旧

// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const PANEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');
const HOME_CSS = readFileSync(join(SRC, 'app', 'foundation.css'), 'utf8');
const PANEL_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx'), 'utf8');
const ICONS_TS = readFileSync(join(SRC, 'ui', 'icons.ts'), 'utf8');
const MEASURE_TS = readFileSync(join(SRC, 'paper', 'measure.ts'), 'utf8');
const CANVAS_MATH_TS = readFileSync(join(SRC, 'paper', 'canvas-math.ts'), 'utf8');
const GROUP_TS = readFileSync(join(SRC, 'paper', 'group.ts'), 'utf8');
const TYPE_TOKENS_TS = readFileSync(join(SRC, 'paper', 'type-tokens.ts'), 'utf8');
const TOKENS_CSS = readFileSync(join(SRC, 'app', 'tokens.css'), 'utf8');
const FONTS_TS = readFileSync(join(SRC, 'app', 'fonts.ts'), 'utf8');
const NORMALIZE_PS1 = readFileSync(join(__dirname, '..', '..', 'scripts', 'normalize-paper-texture.ps1'), 'utf8');
const RENDERER_TS = readFileSync(join(SRC, 'composition', 'renderer-service.tsx'), 'utf8');

/** 从选择器名截取规则体（到下一个 `}` 为止——纸壳 CSS 规则无嵌套）。 */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

/** 截取 @keyframes 全体（含 from/to 嵌套块——花括号配平，规则体截取法够不着）。 */
function keyframesBody(css: string, name: string): string {
  const i = css.indexOf(`@keyframes ${name}`);
  if (i < 0) return '';
  let depth = 0;
  let started = false;
  for (let j = i; j < css.length; j++) {
    if (css[j] === '{') {
      depth += 1;
      started = true;
    } else if (css[j] === '}') {
      depth -= 1;
      if (started && depth === 0) return css.slice(i, j + 1);
    }
  }
  return '';
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

  it('界栏改档（2026-09-02 视觉迭代·用户拍板读法 B）：墨框退役 → 物理包边——纸缘 = 材料不是墨', () => {
    const region = ruleBody(PANEL_CSS, '.pp-region {');
    // 墨框全退役（旧案 2px 半墨 border + 飘浮 outline 实机判「难看又简陋」）
    expect(region).not.toContain('border:');
    expect(region).not.toContain('outline');
    // 物理包边：裱边带（纸色深一档）+ 受光缘 + 背光缘 + 接触落影，全走 token
    expect(region).toContain('var(--sheet-lit)');
    expect(region).toContain('var(--sheet-shade)');
    expect(region).toContain('var(--sheet-band)');
    expect(region).toContain('var(--shadow-sheet)');
    const active = ruleBody(PANEL_CSS, '.pp-region-active {');
    // 活跃卷「变色」判死：洗底退役，只走结构墨阶（落影加深一档）
    expect(active).not.toContain('background');
    expect(active).not.toContain('var(--seal)');
    expect(active).toContain('var(--shadow-sheet-active)');
  });

  it('物理包边 token 载入（tokens.css 真源）：band/lit/shade + 活跃落影一档', () => {
    expect(TOKENS_CSS).toContain('--sheet-band:');
    expect(TOKENS_CSS).toContain('--sheet-lit:');
    expect(TOKENS_CSS).toContain('--sheet-shade:');
    expect(TOKENS_CSS).toContain('--shadow-sheet-active:');
    // 剂量钉值（A/B 验证台 prototype/edge-ab.html 定档）：亮线 0.75 / 沉线 0.13
    expect(TOKENS_CSS).toContain('rgba(255, 250, 238, 0.75)');
    expect(TOKENS_CSS).toContain('rgba(38, 34, 28, 0.13)');
  });

  it('划词朱线（2026-09-02 视觉迭代）：流区原生洗底退役——选区以手写朱线呈现（纸不动、只落墨）', () => {
    // .pp-region 内 ::selection 透明化；UI 面（composer/菜单）照旧 seal-soft
    const sel = ruleBody(PANEL_CSS, '.pp-region ::selection');
    expect(sel).toContain('background: transparent');
    // 朱线层：固定视口层 z 62（纸内件带上沿之上、浮钮 70 之下）
    const ink = ruleBody(PANEL_CSS, '.pp-sel-ink {');
    expect(ink).toContain('position: fixed');
    expect(ink).toContain('pointer-events: none');
    expect(ink).toContain('z-index: 62');
    // 纯函数真源在册（行合并 + 手写路径）
    expect(existsSync(join(SRC, 'paper', 'sel-ink.ts'))).toBe(true);
    expect(PANEL_TSX).toContain('mergeSelectionLines');
    expect(PANEL_TSX).toContain('selInkPaths');
  });

  it('块入场（2026-08-30 流式生命感）：入场动画单次（尾笔已由用户拍板拆除）', () => {
    // 尾笔（pp-tail）2026-08-30 用户拍板拆除——见 taste-ledger 翻案；只钉入场
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-tail')).toBe('');
    const enter = ruleBody(PANEL_CSS, '.pp-block.pp-enter');
    expect(enter).toContain('animation: pp-enter');
  });

  it('块入场定位纪律（2026-09-03 生产事故立法）：pp-enter 帧内禁 transform——上浮只走独立 translate 属性', () => {
    // 事故：块定位是内联 transform（2026-09-02 换装），pp-enter 的 from 帧残留
    // left/top 时代的 transform: translateY(8px)——声明即顶掉内联槽位，新块入场
    // 被摆到流容器左上角再飞回槽位（发消息后排版乱掉/输入似消失/文字乱飞）。
    // 纪律：凡打在 transform 定位块上的 keyframes，任何一帧都不得声明 transform；
    // 相对上浮改走独立 translate 属性（与内联 transform 合成，Chrome 104+）。
    const kf = keyframesBody(PANEL_CSS, 'pp-enter');
    expect(kf).not.toBe('');
    expect(kf).not.toMatch(/transform\s*:/);
    expect(kf).toContain('translate: 0 8px');
    expect(kf).toContain('translate: 0 0');
  });
});

describe('卷首 folio-head 钉值（2026-08-30 原型转录：prototype/lantai.html .folio-head 族）', () => {
  it('卷首结构：玉徽居中钤印 + 硬规线底 + 朱砂版口钮（2026-09-02 改档：只挂活跃卷）；浮动标签带退役', () => {
    const head = ruleBody(PANEL_CSS, '.pp-folio-head {');
    expect(head).toContain('border-bottom: var(--rule-hard)');
    // pointer-events none：点击穿透流区背景，激活语义不变
    expect(head).toContain('pointer-events: none');
    const yuwei = ruleBody(PANEL_CSS, '.pp-yuwei');
    expect(yuwei).toContain('margin: 0 auto 12px');
    expect(yuwei).toContain('width: 24px');
    // 版口钮 2026-09-02 改档：只挂活跃卷（.pp-region-active 前缀）——整屏至多一处红，
    // 红在哪卷即活卷（对原型 .folio-head 的主动偏离：原型卷卷都挂，先于一纸多卷定案）
    const tab = ruleBody(PANEL_CSS, '.pp-region-active .pp-folio-head::after');
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

  it('纸层次（2026-09-01 真纸化）：真纹理双资产乘印 + SVG 微颗粒 + 顶光边沉帘纹（body 文档级 before/after）', () => {
    // 真纸纹理资产接线（feTurbulence 程序噪声退役——真纤维/斑点，cover 免接缝；
    // 挂 body 文档级——2026-09-01 实机打回：错挂 .sh-root 时纹理被困首页，画布/面板无纹理）
    expect(HOME_CSS).toContain('../assets/paper/paper-grain.jpg');
    expect(HOME_CSS).toContain('../assets/paper/paper-fiber.jpg');
    expect(HOME_CSS).toContain('background-blend-mode: normal, multiply, multiply');
    expect(HOME_CSS).toContain('mix-blend-mode: multiply');
    expect(HOME_CSS).toContain('body::after');
    // 极弱 SVG 微颗粒保留（抗色带）
    expect(HOME_CSS).toContain("opacity='0.05'");
    // 纸层次：顶光 + 帘纹 + 边沉
    expect(HOME_CSS).toContain('body::before');
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

  it('材质批（2026-09-01）：印章印泥分材质 + 墨迹洇边', () => {
    // 印泥：全局「局部禁挂纹理」的唯一例外——印泥≠纸，中性灰纹理乘 --seal 实色
    const seal = ruleBody(HOME_CSS, '.sh-seal {');
    expect(seal).toContain('url("../assets/paper/seal-paste.jpg")');
    expect(seal).toContain('background-blend-mode: multiply');
    expect(seal).toContain('background-color: var(--seal)');
    // 洇边：重墨大字墨渗（同 folio-title 的 ink-solid alpha 残影手法）
    expect(ruleBody(HOME_CSS, '.sh-h1 {')).toContain('text-shadow: 0 0 1.5px');
    expect(ruleBody(HOME_CSS, '.sh-section-title .t {')).toContain('text-shadow: 0 0 1px');
    const anchor = ruleBody(HOME_CSS, '.sh-section-title .t::before');
    expect(anchor).toContain('box-shadow: 0 0 2px');
  });

  it('流区真纸（2026-09-01 材质批二 + 2026-09-02 物理包边改档）：每卷一张纸——不透明底 + 纸纹乘印 + 纸性三参', () => {
    const region = ruleBody(PANEL_CSS, '.pp-region {');
    expect(region).toContain('paper-sheet.jpg');
    expect(region).toContain('background-blend-mode: multiply');
    expect(region).toContain('var(--sheet-ox');
    expect(region).toContain('var(--sheet-j');
    // 接触落影仍在列序末位（2026-09-02 起前面叠裱边带/受光缘/背光缘——物理包边）
    expect(region).toContain('var(--shadow-sheet)');
    expect(TOKENS_CSS).toContain('--shadow-sheet:');
    // active 2026-09-02 改档：洗底退役（「变色」判死）——不动任何 background，
    // 只换落影一档；background 简写禁令延续（会抹纸纹层）
    const active = ruleBody(PANEL_CSS, '.pp-region-active {');
    expect(active).not.toContain('background');
    expect(active).toContain('var(--shadow-sheet-active)');
  });
});

describe('贴纸纹理归属（2026-09-02 透明错觉根治批）', () => {
  // 真因复盘：流区一直在画（实机活体双盲——荧光绿/品红桌面均画得出），
  // 「透」= 视口固定层以「不动之纹」出卖空间隐喻：拖动时纸走纹不走。
  // 三层固定纹：body::after 颗粒 / body::before 帘纹 / （已被材质批移除的流区自纹缺失）。

  it('文档级颗粒层画布退役：body:has(.pp-root)::after 隐去（fixed 纹理 = 不动之纹，出卖拖动）', () => {
    const retire = ruleBody(HOME_CSS, 'body:has(.pp-root)::after');
    expect(retire).toContain('display: none');
    // 文档级配方本体保留（首页/面板照旧）
    expect(ruleBody(HOME_CSS, 'body::after {')).toContain('mix-blend-mode: multiply');
  });

  it('帘纹归属：画布态 body::before 只剩光照类（顶光+边沉，光滑无纹）；非画布态保留完整三件', () => {
    const before = ruleBody(HOME_CSS, 'body::before');
    expect(before).toContain('var(--light-fall)');
    expect(before).toContain('var(--vignette)');
    expect(before).not.toContain('var(--laid-lines)');
    const home = ruleBody(HOME_CSS, 'body:not(:has(.pp-root))::before');
    expect(home).toContain('var(--laid-lines)');
    expect(home).toContain('var(--light-fall)');
    expect(home).toContain('var(--vignette)');
  });

  it('桌垫：世界内纸面——四层配方（微颗粒×grain×fiber×帘纹）+ 无界巨幅 + 不与流区混合', () => {
    const desk = ruleBody(PANEL_CSS, '.pp-desk {');
    // 桌面纸配方：与 body::after 同源 + 帘纹归桌面
    expect(desk).toContain('background-color: var(--paper)');
    expect(desk).toContain('paper-grain.jpg');
    expect(desk).toContain('paper-fiber.jpg');
    expect(desk).toContain('var(--laid-lines)');
    expect(desk).toContain('normal, multiply, multiply, multiply');
    // 只混自身层（background-blend），不乘盖流区/纸条（无 mix-blend-mode）
    expect(desk).not.toContain('mix-blend-mode');
    // 无界近似：±200000px 世界坐标
    expect(desk).toContain('left: -200000px');
    expect(desk).toContain('width: 400000px');
    // 事件穿透（平移命中 .pp-world 语义）
    expect(desk).toContain('pointer-events: none');
    // TSX 挂载：world 第一子（DOM 序即层序，垫在一切世界内容之下）
    expect(PANEL_TSX).toContain('className="pp-desk"');
  });

  it('流区帘纹退役：单层纸纹（纸性由 paper-sheet 独自承载——帘纹叠乘读作屏纹，实机过审移除）', () => {
    const region = ruleBody(PANEL_CSS, '.pp-region {');
    expect(region).not.toContain('var(--laid-lines)');
    expect(region).toContain('paper-sheet.jpg');
  });

  it('中间形态退役：不留下任何视口级纹理覆盖层（pp-canvas-grain）', () => {
    expect(PANEL_CSS).not.toContain('pp-canvas-grain');
    expect(PANEL_TSX).not.toContain('pp-canvas-grain');
    expect(PANEL_TSX).not.toContain('grainStyle');
  });

  it('空态提层：桌垫入场后 pp-empty 须浮于世界单元之上', () => {
    expect(ruleBody(PANEL_CSS, '.pp-empty {')).toContain('z-index: 2');
  });

  it('贴纸纹预处理管道：-Sheet 模式线性扩幅回中（a=1.63/b=-0.555——振幅立得住、纸色不动）', () => {
    expect(NORMALIZE_PS1).toContain('[switch]$Sheet');
    expect(NORMALIZE_PS1).toContain('[double]$sheetA = 1.63');
    expect(NORMALIZE_PS1).toContain('[double]$sheetB = -0.555');
    expect(NORMALIZE_PS1).toContain('a=1.63 / b=-0.555');
  });
});

describe('会话流版式节奏钉值（stream-rhythm 刀2，2026-09-03——D1 试值待用户真机终审）', () => {
  it('间距三档 + 转折/阶段放空：canvas-math 真源（intra 32 < 块距 48 < unit 64 < recovery/stage 96）', () => {
    expect(CANVAS_MATH_TS).toContain('intraUnitGap: 32');
    expect(CANVAS_MATH_TS).toContain('unitGap: 64');
    expect(CANVAS_MATH_TS).toContain('recoveryLeadGap: 96');
    expect(CANVAS_MATH_TS).toContain('stageGap: 96');
    // B1 基线不动（无节奏信息的外部调用面）：块距 48 / 来文尾距 8
    expect(CANVAS_MATH_TS).toContain('blockGap: 48');
    expect(CANVAS_MATH_TS).toContain('userTailGap: 8');
  });

  it('阶段细线（D2 最素形态）：弱线落阶段间距中线，跨块宽', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-block.pp-stage-lead::before');
    expect(rule).toContain('top: -48px');
    expect(rule).toContain('border-top: var(--rule-soft)');
    expect(rule).toContain('left: 0');
    expect(rule).toContain('right: 0');
  });

  it('接线在册：工作单元 pass 进 PaperPanel 核心，来文块挂阶段类', () => {
    expect(PANEL_TSX).toContain('groupWorkUnits');
    expect(PANEL_TSX).toContain('unitMembership');
    expect(PANEL_TSX).toContain('sealedMessageIdsOf');
    expect(PANEL_TSX).toContain('pp-stage-lead');
    // 封口纪律 + 跨消息前瞻禁止（宪法条款在纯函数真源里在册）
    expect(GROUP_TS).toContain('跨消息前瞻禁止');
    expect(GROUP_TS).toContain('封口纪律');
  });
});

describe('Error 墨色家族（stream-rhythm 刀4c 确认，2026-09-03——现状合规零改动，钉防漂移）', () => {
  it('错误状态色 = --fail 墨浓红（非纯红、非朱砂——朱砂=人铁律不挪用）', () => {
    expect(TOKENS_CSS).toContain('--fail: #a9443f');
    // 纯红字面量不进纸面（B5 红绿墨色化纪律的延伸）
    expect(TOKENS_CSS).not.toMatch(/#f00;|#ff0000/i);
    expect(PANEL_CSS).not.toMatch(/#f00;|#ff0000/i);
  });

  it('错因墓碑（turn-error）：贴黄款——朱砂淡底只作纸晕（7%），墨身走 ink-2', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-block.pp-turn-error {');
    expect(rule).toContain('color-mix(in oklch, var(--seal) 7%, var(--paper))');
    const body = ruleBody(PANEL_CSS, '.pp-block.pp-turn-error .pp-body');
    expect(body).toContain('color: var(--ink-2)');
    expect(body).not.toContain('var(--seal)');
  });

  it('工具/程文错误输出与状态签：--fail 单一真源（渲染器两处 err 行内）', () => {
    expect(ruleBody(PANEL_CSS, '.pp-status.pp-error')).toContain('color: var(--fail)');
    // 渲染器错误输出恒两处（tool / code 同构）——新增错误面须过此钉改账
    expect(RENDERER_TS.match(/color: 'var\(--fail\)'/g)?.length).toBe(2);
  });
});
