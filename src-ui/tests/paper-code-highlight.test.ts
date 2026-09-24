// @vitest-environment jsdom

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

import { createBlock, resetBlockIdCounterForTests, type SourcedBlock } from '../src/paper/block-model';
import { clearPaperMeasureCache, measureBlockHeight } from '../src/paper/measure';
import { builtinRendererDefs } from '../src/plugins/builtin/paper-renderers/renderers';

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

/* ═══ render：抄录块代码体（2026-09-23 文类回归批）═══
 * 顶层围栏独立成 diff 块（文类「抄录 / CODE」），块体按语言分流：
 * 真差分 → 差分着色；其余语言（含裸围栏）→ hljs 代码体 `.pp-diff-code`。 */

describe('DiffBody — 抄录块语言分流', () => {
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

  const renderDiff = (payload: object) => {
    act(() => {
      root?.render(createElement(rendererFor('diff'), { block: block('diff', payload) }));
    });
  };

  it('```ts 围栏：出 .pp-diff-code + hljs token span + 语言签', () => {
    renderDiff({ lang: 'ts', text: 'const x: number = 1;' });
    const pre = container!.querySelector('pre.pp-diff-code');
    expect(pre).not.toBeNull();
    const kw = pre!.querySelector('.hljs-keyword');
    expect(kw).not.toBeNull();
    expect(kw!.textContent).toBe('const');
    // 语言行 = 抄录块既有语言签（.pp-lang，measure 的 DIFF_LANG_H 同判据）
    expect(container!.querySelector('.pp-lang')?.textContent).toBe('ts');
  });

  it('裸围栏（无 lang）：纯 mono 原文，无 token span、无语言行', () => {
    renderDiff({ text: 'M engine/grammars/build.sh' });
    const pre = container!.querySelector('pre.pp-diff-code');
    expect(pre).not.toBeNull();
    expect(pre!.querySelector('.hljs-keyword')).toBeNull();
    expect(pre!.textContent).toContain('M engine/grammars/build.sh');
    expect(container!.querySelector('.pp-lang')).toBeNull();
  });

  it('未知 lang（foobar）：不误着色、不炸块', () => {
    renderDiff({ lang: 'foobar', text: 'whatever { text' });
    const pre = container!.querySelector('pre.pp-diff-code');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain('whatever { text');
  });

  it('```diff 围栏仍走差分着色（不进代码体）', () => {
    renderDiff({ lang: 'diff', text: '- old line\n+ new line' });
    expect(container!.querySelector('pre.pp-diff-code')).toBeNull();
    expect(container!.querySelector('.pp-del')?.textContent).toBe('- old line');
    expect(container!.querySelector('.pp-add')?.textContent).toBe('+ new line');
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

  it('抄录块代码体（lang=ts）与差分路测高同值——分流不引入几何差', () => {
    const text = 'const a = 1;\nconst b = 2;';
    // 尺子同 paper-v3a：lang 行 16 + 图版 padding/border 30 + mock 文本 36
    expect(measureBlockHeight(block('diff', { lang: 'ts', text }))).toBe(16 + 30 + 36);
    expect(measureBlockHeight(block('diff', { lang: 'diff', text }))).toBe(16 + 30 + 36);
    expect(measureBlockHeight(block('diff', { text }))).toBe(30 + 36); // 裸围栏：无语言行
  });
});

/* ═══ mermaid 围栏认领（B6 · P2）═══
 * 只在模型**显式**写 ```mermaid 时触发；jsdom 里 mermaid 多半渲染不出 SVG，
 * 而那正是降级链要考的：出 `.pp-mermaid` 容器 + 「图渲染失败：」可读错误 + **原代码块回落**。 */
describe('MarkdownBody — mermaid 围栏认领', () => {
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

  it('```mermaid 围栏 → 交给 MermaidBlock（.pp-mermaid 容器）；普通围栏不误入', async () => {
    await act(async () => {
      root?.render(
        createElement(rendererFor('markdown'), {
          block: block('markdown', { text: '```mermaid\ngraph TD; A-->B;\n```' }),
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container!.querySelector('.pp-mermaid')).not.toBeNull();
    await act(async () => {
      root?.render(
        createElement(rendererFor('markdown'), { block: block('markdown', { text: '```ts\nconst a = 1;\n```' }) }),
      );
    });
    expect(container!.querySelector('.pp-mermaid')).toBeNull();
    expect(container!.querySelector('pre.pp-md-code')).not.toBeNull();
  });

  it('渲染失败时回落原代码块（不吞错、不空白）', async () => {
    await act(async () => {
      root?.render(
        createElement(rendererFor('markdown'), { block: block('markdown', { text: '```mermaid\n%% 非法图\n```' }) }),
      );
    });
    // mermaid 是动态分片 + 异步解析：轮询到状态落定（ok/fail），最多 2s
    const stateNow = (): string | null =>
      container!.querySelector('.pp-mermaid')?.getAttribute('data-mermaid-state') ?? null;
    for (let i = 0; i < 40 && stateNow() !== 'ok' && stateNow() !== 'fail'; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    }
    const host = container!.querySelector('.pp-mermaid');
    expect(host).not.toBeNull();
    const state = host!.getAttribute('data-mermaid-state');
    expect(state === 'ok' || state === 'fail', `状态未落定：${String(state)}`).toBe(true);
    if (state === 'fail') {
      expect(host!.querySelector('.pp-mermaid-error')?.textContent).toContain('图渲染失败：');
      expect(host!.querySelector('pre.pp-md-code')).not.toBeNull(); // 原代码块回落
    } else {
      expect(host!.querySelector('svg')).not.toBeNull();
    }
  });
});
