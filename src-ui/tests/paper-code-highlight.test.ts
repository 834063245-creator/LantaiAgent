// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 科研渲染 #5（scientific-rendering-plan）：markdown 围栏码 hljs token 高亮。
//   1. render：带 lang 的代码块出 .pp-md-code 内 span.hljs-*（真实高亮）；
//      无 lang / 未知 lang → 纯 mono 原文，不误着色、不炸。
//   2. measure：高亮只包 span 不改行数/折行 → 高度镜像零变化（与 4A 纪律：
//      渲染层加表现不改源文本字符布局，测高同值）。
// 用户操作序列式断言；渲染 = 真实 react-dom createRoot（同 paper-math 范式）。

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

import { builtinRendererDefs } from '../src/app/paper/builtin-renderers';
import { createBlock, resetBlockIdCounterForTests, type SourcedBlock } from '../src/paper/block-model';
import { clearPaperMeasureCache, measureBlockHeight } from '../src/paper/measure';

function block(kind: Parameters<typeof createBlock>[0], payload: object) {
  return createBlock(kind, payload as never, { messageId: 'm', part: null });
}

function rendererFor(kind: string) {
  const def = builtinRendererDefs().find((d) => d.kind === kind);
  expect(def, `内置渲染器 ${kind} 存在`).toBeDefined();
  return def!.component;
}

/* ═══ render：hljs token 高亮 ═══ */

describe('MarkdownBody — 代码块高亮', () => {
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

  it('带 lang 的代码块出 .pp-md-code 内 hljs token span', () => {
    render(block('markdown', { text: '```ts\nconst x: number = 1;\n```' }));
    const pre = container!.querySelector('pre.pp-md-code');
    expect(pre).not.toBeNull();
    // ts 的关键字 const 被包成 .hljs-keyword（真实高亮非原样纯文本）
    const kw = pre!.querySelector('.hljs-keyword');
    expect(kw).not.toBeNull();
    expect(kw!.textContent).toBe('const');
  });

  it('无 lang 的代码块保持纯 mono 原文（无 token span）', () => {
    render(block('markdown', { text: '```\nconst x = 1;\n```' }));
    const pre = container!.querySelector('pre.pp-md-code');
    expect(pre).not.toBeNull();
    expect(pre!.querySelector('.hljs-keyword')).toBeNull();
    expect(pre!.textContent).toContain('const x = 1;');
  });

  it('未知 lang（如 foobar）不误着色、不炸块', () => {
    render(block('markdown', { text: '```foobar\nwhatever { text\n```' }));
    const pre = container!.querySelector('pre.pp-md-code');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain('whatever { text');
  });

  it('补注册科研语言（matlab）可高亮', () => {
    render(block('markdown', { text: '```matlab\nx = [1 2 3];\n```' }));
    const pre = container!.querySelector('pre.pp-md-code');
    expect(pre).not.toBeNull();
    // matlab 关键词/内置函数会被包 span（至少非纯原样）
    const spans = pre!.querySelectorAll('span[class^="hljs-"]');
    expect(spans.length).toBeGreaterThan(0);
  });

  it('流式半成型代码（围栏未闭合）不崩、容错渲染', () => {
    render(block('markdown', { text: '```ts\nconst a: str' }));
    // 未闭合 fence 流式容忍：内容仍在（parseMarkdown 未闭合收至文末）
    const pre = container!.querySelector('pre.pp-md-code');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain('const a: str');
  });
});

/* ═══ measure：高亮零测量镜像变化 ═══ */

describe('paper/measure — 代码块高亮零镜像变化', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('带 lang 代码块测高 === 无 lang（高亮不改行数/折行；mock 36）', () => {
    const hl = measureBlockHeight(block('markdown', { text: '```ts\nconst a = 1;\nconst b = 2;\n```' }));
    const plain = measureBlockHeight(block('markdown', { text: '```\nconst a = 1;\nconst b = 2;\n```' }));
    // .pp-md-code 镜像：padV 20 + mono 文本高（mock 36）——单 code 块为末元素
    // gap 归零（markdown 末元素 margin-bottom 0 镜像）
    expect(hl).toBe(20 + 36);
    expect(plain).toBe(hl); // 高亮前后零差异
  });
});
