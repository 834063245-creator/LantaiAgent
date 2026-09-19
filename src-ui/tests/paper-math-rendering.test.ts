// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 科研数学渲染（scientific-rendering-plan 4A）：markdown 数学单一解析 + KaTeX
// 渲染 + 测高记账的三侧对拍。
//   1. parse：块级 $$ / 行内 $...$ 界约束（不误伤货币/变量/转义）
//   2. render：MarkdownBody → KaTeX HTML 结构（.katex / .katex-display / 错误兜底）
//   3. measure：math 块静态预算 + 含公式 markdown 触发 RO（needsObservedHeight）
// 用户操作序列式断言；渲染 = 真实 react-dom createRoot（streaming-fade 同范式）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock '@chenglou/pretext'（同款范式）
const { prepareMock, layoutMock } = vi.hoisted(() => ({
  prepareMock: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: prepareMock,
  layout: layoutMock,
  clearCache: vi.fn(),
}));
// rich-inline（富行内测量出口）同款 mock
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { builtinRendererDefs } from '../src/app/paper/builtin-renderers';
import { createBlock, resetBlockIdCounterForTests, type SourcedBlock } from '../src/paper/block-model';
import {
  type MdInline,
  mdHasRichInline,
  mdPlainText,
  parseInline,
  parseMarkdown,
  textHasMath,
} from '../src/paper/markdown';
import { clearPaperMeasureCache, measureBlockHeight, needsObservedHeight } from '../src/paper/measure';

function block(kind: Parameters<typeof createBlock>[0], payload: object) {
  return createBlock(kind, payload as never, { messageId: 'm', part: null });
}

function rendererFor(kind: string) {
  const def = builtinRendererDefs().find((d) => d.kind === kind);
  expect(def, `内置渲染器 ${kind} 存在`).toBeDefined();
  return def!.component;
}

/* ═══ parse：块级 + 行内数学 ═══ */

describe('paper/markdown — 块级数学 $$', () => {
  it('跨行 $$ fence：收集到闭行，内容剥定界符', () => {
    const blocks = parseMarkdown('前文\n\n$$\n\\hat{y} = \\sigma(Wx + b)\n$$\n\n后文');
    const types = blocks.map((b) => b.t);
    expect(types).toEqual(['p', 'math', 'p']);
    const math = blocks[1] as Extract<(typeof blocks)[number], { t: 'math' }>;
    expect(math.text).toBe('\\hat{y} = \\sigma(Wx + b)');
  });

  it('单行 $$x=y$$ 同行闭合收为 math 块', () => {
    const blocks = parseMarkdown('$$E = mc^2$$');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ t: 'math', text: 'E = mc^2' });
  });

  it('未闭合 $$ 流式容忍：按到文末产出（对齐围栏语义）', () => {
    const blocks = parseMarkdown('$$\n\\frac{a}{b}');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ t: 'math', text: '\\frac{a}{b}' });
  });

  it('空 $$（无内容）不产块（段落兜底不丢字）', () => {
    const blocks = parseMarkdown('$$\n\n$$\n\n正文');
    // 首 $$ 无内容 → 不产 math；正文独立成段
    const mathBlocks = blocks.filter((b) => b.t === 'math');
    expect(mathBlocks).toHaveLength(0);
    expect(blocks.some((b) => b.t === 'p')).toBe(true);
  });
});

describe('paper/markdown — 行内 $...$ 界约束', () => {
  it('英文行内公式：$E=mc^2$ → math 段；邻接正文保持', () => {
    const inl = parseInline('能量 $E=mc^2$ 守恒');
    expect(inl).toHaveLength(3);
    expect(inl[0]).toMatchObject({ text: '能量 ' });
    expect(inl[1]).toMatchObject({ math: 'E=mc^2' });
    expect(inl[2]).toMatchObject({ text: ' 守恒' });
  });

  it('中文混排：公式夹在汉字间（开闭两侧非汉字/数字）正常解析', () => {
    const inl = parseInline('回归系数为$\\beta_1$时显著');
    const mathSeg = inl.find((s) => s.math !== undefined);
    expect(mathSeg?.math).toBe('\\beta_1');
  });

  it('公式内空格合法（$ a = b $ 去首尾空白存源码）', () => {
    const inl = parseInline('式 $ x + y $ 成立');
    expect(inl.find((s) => s.math !== undefined)?.math).toBe('x + y');
  });

  it('界约束不误伤：货币 $5、变量 $foo、转义 \\$ 全字面保留', () => {
    const money = parseInline('价 $5 与 $10');
    expect(money.find((s) => s.math !== undefined)).toBeUndefined();
    const variable = parseInline('成本 $cost 因子');
    expect(variable.find((s) => s.math !== undefined)).toBeUndefined();
    const escaped = parseInline('转义 \\$x$ 字面');
    expect(escaped.find((s) => s.math !== undefined)).toBeUndefined();
  });

  it('行内公式在强调包裹内保留为独立 math 原子（KaTeX 字形完整，不套粗斜变形）', () => {
    // 渲染端 InlineRuns：math 段先转 MathInline 再按 b/i 套层——但解析端 math
    // 分支不带 flags（对齐行内码 c 语义：原子内无标记嵌套），故 **$x$** 产出
    // 单 math 段无 b。行为 = 公式不被粗体/斜体字形变形（KaTeX 字形自足）。
    const inl = parseInline('**$x_i$**');
    expect(inl).toHaveLength(1);
    expect(inl[0]).toMatchObject({ math: 'x_i' });
    expect(inl[0].b).toBeUndefined();
    // 混合：粗体文字 + 公式 → 粗体段与 math 段并列
    const mixed = parseInline('**关键** $x_i$');
    expect(mixed.find((s) => s.b === true)).toBeDefined();
    expect(mixed.find((s) => s.math !== undefined)).toBeDefined();
  });

  it('mdPlainText 对公式段取源码；mdHasRichInline 判真', () => {
    const inl: MdInline[] = parseInline('能量 $E=mc^2$ 守恒');
    expect(mdPlainText(inl)).toBe('能量 E=mc^2 守恒');
    expect(mdHasRichInline(inl)).toBe(true);
  });

  it('textHasMath：含 $$ 或 $ 即真（RO 判据——多挂无副作用方向安全）', () => {
    expect(textHasMath('普通文本')).toBe(false);
    expect(textHasMath('有 $x$ 公式')).toBe(true);
    expect(textHasMath('$$块级$$')).toBe(true);
    expect(textHasMath('价 $5 是货币')).toBe(true); // 近似误报可接受（安全方向）
  });
});

/* ═══ render：KaTeX HTML ═══ */

describe('MarkdownBody — 数学渲染', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  const render = (b: SourcedBlock) => {
    act(() => {
      root?.render(createElement(rendererFor('markdown'), { block: b }));
    });
  };

  it('块级公式 → .pp-md-math 内 KaTeX display 结构', () => {
    render(block('markdown', { text: '$$\n\\hat{y} = \\sigma(Wx + b)\n$$' }));
    const wrapper = container!.querySelector('.pp-md-math');
    expect(wrapper).not.toBeNull();
    const display = wrapper!.querySelector('.katex-display');
    expect(display).not.toBeNull();
    // KaTeX 渲染出实际排版（非源码原样）：math 源码在输出里被拆分
    const html = display!.innerHTML;
    expect(html).not.toContain('$$');
  });

  it('行内公式 → .pp-md-math-inline 内 KaTeX span', () => {
    render(block('markdown', { text: '能量 $E=mc^2$ 守恒' }));
    const inline = container!.querySelector('.pp-md-math-inline');
    expect(inline).not.toBeNull();
    expect(inline!.querySelector('.katex')).not.toBeNull();
  });

  it('错误公式不崩块：KaTeX 错误标记可见（流式半成型不破版）', () => {
    render(block('markdown', { text: '$$\\notacommand{$$' }));
    const wrapper = container!.querySelector('.pp-md-math');
    expect(wrapper).not.toBeNull();
    // throwOnError:false → 不抛错，页面存活
    expect(container!.querySelector('.pp-body')).not.toBeNull();
  });
});

/* ═══ measure：测高记账 + RO 判据 ═══ */

describe('paper/measure — 数学块测高', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('单行公式预算 = 正文行高 × display 系数 + 块 gap（末元素 gap 归零）', () => {
    // $$x=y$$ 独占 → math 是唯一块（last）→ gap 归零
    const single = measureBlockHeight(block('markdown', { text: '$$x = y$$' }));
    // 预算 = 1 × 34 × 2.2 ≈ 74.8；精度断言用 toBeCloseTo
    expect(single).toBeCloseTo(34 * 2.2, 1);
    // 公式 + 后文 → math 非末元素，加 gap 12
    const withAfter = measureBlockHeight(block('markdown', { text: '$$x = y$$\n\n后文' }));
    expect(withAfter).toBeCloseTo(34 * 2.2 + 12 + 36, 1);
  });

  it('跨行公式按显式行数 × maxLines 封顶预算', () => {
    const h = measureBlockHeight(block('markdown', { text: '$$\na\nb\nc\nd\n$$' }));
    // 5 显式行截 3 → 3 × 34 × 2.2
    expect(h).toBeCloseTo(3 * 34 * 2.2, 1);
  });

  it('含公式 markdown 挂 RO 实测（2026-09-19 起：正文**恒**入实测族，内容感知判据退役）', () => {
    // 旧行为是「含公式/表格才挂」（needsObservedHeight 内容感知）——真机对拍证明
    // 正文块整体受 canvas↔DOM 折行分歧影响（163 条真会话正文：27 条块高有差），
    // 与是否含公式无关 ⇒ 判据收敛为按 kind，公式只是其中一例。
    expect(needsObservedHeight('markdown', false)).toBe(true);
  });
});
