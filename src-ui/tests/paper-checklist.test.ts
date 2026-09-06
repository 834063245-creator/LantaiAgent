// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 科研渲染 #15（scientific-rendering-plan）：markdown 任务列表 `- [ ]` / `- [x]`
// 的三侧对拍（同 4A math 纪律：parse/render/measure 共用单一解析模型）。
//   1. parse：GFM checkbox 剥为 MdListItem.check（待办 true / 已完成 false）；
//      非列表首位的 [x] 是普通文本；纯文本列表零变化。
//   2. render：真实渲染出复选框（.pp-md-check，完成态 --on），列表项正文保留。
//   3. measure：复选框项与普通项等高镜像（框不占行盒）；纯 `- [ ]` 无尾文
//      至少一行正文高（框 absolute 不占盒，空文本给最小行高防叠压）。
// 用户操作序列式断言；渲染 = 真实 react-dom createRoot（paper-math 同范式）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prepareMock, layoutMock } = vi.hoisted(() => ({
  prepareMock: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: prepareMock,
  layout: layoutMock,
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { builtinRendererDefs } from '../src/composition/renderer-service';
import { createBlock, resetBlockIdCounterForTests, type SourcedBlock } from '../src/paper/block-model';
import { type MdBlock, parseMarkdown } from '../src/paper/markdown';
import { clearPaperMeasureCache, measureBlockHeight } from '../src/paper/measure';

function block(kind: Parameters<typeof createBlock>[0], payload: object) {
  return createBlock(kind, payload as never, { messageId: 'm', part: null });
}

function rendererFor(kind: string) {
  const def = builtinRendererDefs().find((d) => d.kind === kind);
  expect(def, `内置渲染器 ${kind} 存在`).toBeDefined();
  return def!.component;
}

function firstList(text: string): Extract<MdBlock, { t: 'list' }> {
  const blocks = parseMarkdown(text);
  const list = blocks.find((b) => b.t === 'list');
  expect(list, `应解析出列表：${text}`).toBeDefined();
  return list as Extract<MdBlock, { t: 'list' }>;
}

/* ═══ parse：checkbox 剥为 check 语义 ═══ */

describe('paper/markdown — 任务列表 checkbox', () => {
  it('- [ ] 待办：check=true，正文剥定界符保留', () => {
    const list = firstList('- [ ] 收集数据');
    expect(list.items[0].check).toBe(true);
    expect(list.items[0].inl.map((s) => s.text).join('')).toBe('收集数据');
  });

  it('- [x] 已完成：check=false；- [X] 大写同样收', () => {
    const done = firstList('- [x] 已分析');
    expect(done.items[0].check).toBe(false);
    const cap = firstList('- [X] 大写勾');
    expect(cap.items[0].check).toBe(false);
  });

  it('混合清单：待办/已完成/普通项并存保序', () => {
    const list = firstList('- [ ] 甲\n- [x] 乙\n- 丙');
    expect(list.items.map((it) => it.check)).toEqual([true, false, undefined]);
    expect(list.items.map((it) => it.inl[0]?.text ?? '')).toEqual(['甲', '乙', '丙']);
  });

  it('非列表项首位的 [x] 是普通文本（如「先看 [x] 标记」不剥）', () => {
    const list = firstList('- 先看 [x] 标记');
    expect(list.items[0].check).toBeUndefined();
    expect(list.items[0].inl.map((s) => s.text).join('')).toBe('先看 [x] 标记');
  });

  it('有序列表带 checkbox 也收（1. [ ] 甲）', () => {
    const list = firstList('1. [ ] 甲\n2. [x] 乙');
    expect(list.ord).toBe(true);
    expect(list.items.map((it) => it.check)).toEqual([true, false]);
  });

  it('复选框项可带嵌套子列表（- [ ] 父\n  - 子）', () => {
    const list = firstList('- [ ] 父\n  - 子');
    expect(list.items[0].check).toBe(true);
    expect(list.items[0].sub?.[0]).toMatchObject({ t: 'list' });
  });

  it('普通列表（无 checkbox）解析零变化——项无 check 字段', () => {
    const list = firstList('- 甲\n- 乙');
    expect(list.items.every((it) => it.check === undefined)).toBe(true);
  });
});

/* ═══ render：真实复选框 ═══ */

describe('MarkdownBody — 任务列表渲染', () => {
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

  it('待办项出空复选框 .pp-md-check（无 --on）；已完成项出 --on', () => {
    render(block('markdown', { text: '- [ ] 待办\n- [x] 完成' }));
    const boxes = container!.querySelectorAll('.pp-md-check');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].classList.contains('pp-md-check--on')).toBe(false);
    expect(boxes[1].classList.contains('pp-md-check--on')).toBe(true);
  });

  it('复选框项正文保留；普通项仍出 .pp-md-mark（· 或序号）', () => {
    render(block('markdown', { text: '- [ ] 待办\n- 普通' }));
    const bodyText = container!.textContent ?? '';
    expect(bodyText).toContain('待办');
    expect(bodyText).toContain('普通');
    const marks = container!.querySelectorAll('.pp-md-mark');
    expect(marks).toHaveLength(1); // 只有普通项有 · 标记
  });
});

/* ═══ measure：测高镜像 ═══ */

describe('paper/measure — 复选框项测高', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('纯复选框项（无尾文）至少一行正文高（34 = body 17×lh2.0；两项 = 34+6+34）', () => {
    const b = block('markdown', { text: '- [ ]\n- [x]' });
    // 每个纯项最小高 = 正文行高 34（mock 的 36 只影响文本项——空项不 layout），
    // 两项 = 34 + liGap 6 + 34（末项 gap 归零）
    expect(measureBlockHeight(b)).toBe(34 + 6 + 34);
  });

  it('复选框项（带正文）与普通项测高相等——框不占行盒', () => {
    const withCheck = measureBlockHeight(block('markdown', { text: '- [ ] 甲\n- [x] 乙' }));
    const plain = measureBlockHeight(block('markdown', { text: '- 甲\n- 乙' }));
    expect(withCheck).toBe(plain);
  });
});
