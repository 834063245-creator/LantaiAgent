// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 程文卡流式预览 · 呈现面（2026-11-22 卷 165 后续）：
//   - 展开态也看得见「正在生成的程序体」（折叠行是另一种读法：最新一行）；
//   - 测高 / 墨迹 / 内容签名与渲染端**同源**（preview 参与体高，且入签名）——
//     漏了任何一面都会让流式增长的卡「按 0 高排、压到下一块」（帖那起事故的形状）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* 文本测量桩（同 paper-* 族既有范式）：node/happy-dom 无 canvas，pretext 起不来。 */
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { builtinRendererDefs } from '../src/plugins/builtin/paper-renderers/renderers';
import { FOLD_ROW_H, measureBlockHeight, measureSignature } from '../src/plugins/builtin/paper-shell/measure';

const PREVIEW =
  'const [a, b] = await Promise.all([\n  tools.fs({ action: "list" }),\n  tools.fs({ action: "read" }),\n]);';

function codeBlock(payload: Record<string, unknown>): SourcedBlock {
  return createBlock('code', payload as never, { messageId: 'm1', part: null });
}

describe('测高 — preview 与 code 走同一条路径', () => {
  it('展开态：preview 参与体高（等于同一段文本当 code 的高）', () => {
    const previewOnly = codeBlock({ code: '', preview: PREVIEW });
    const asCode = codeBlock({ code: PREVIEW });
    expect(measureBlockHeight(previewOnly, false)).toBe(measureBlockHeight(asCode, false));
    expect(measureBlockHeight(previewOnly, false)).toBeGreaterThan(FOLD_ROW_H);
  });

  it('折叠态：preview 不改折叠行高（与无 preview 的折叠卡同高，且低于展开态）', () => {
    const withPreview = codeBlock({ code: '', preview: PREVIEW });
    const without = codeBlock({ code: '' });
    expect(measureBlockHeight(withPreview, true)).toBe(measureBlockHeight(without, true));
    expect(measureBlockHeight(withPreview, true)).toBeLessThan(measureBlockHeight(withPreview, false));
  });

  it('内容签名含 preview：流式增长不得吃旧缓存高', () => {
    const short = codeBlock({ code: '', preview: 'a' });
    const longer = codeBlock({ code: '', preview: 'a\nb' });
    expect(measureSignature(short, false)).not.toBe(measureSignature(longer, false));
  });
});

describe('渲染面 — 展开的程文卡流式显示程序体', () => {
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

  const render = (block: SourcedBlock, folded = false) => {
    const def = builtinRendererDefs().find((d) => d.kind === 'code');
    expect(def, '内置 code 渲染器存在').toBeDefined();
    act(() => {
      root?.render(createElement(def?.component, { block, folded } as never));
    });
  };

  it('展开 + preview：卡体里是已生成的程序体原文', () => {
    render(codeBlock({ code: '', preview: PREVIEW }));
    const src = container?.querySelector('.pp-code-src');
    expect(src, '展开态应渲染 .pp-code-src').not.toBeNull();
    expect(src?.textContent).toContain('tools.fs({ action: "list" })');
  });

  it('折叠 + preview：体不渲染（折叠行即本体）', () => {
    render(codeBlock({ code: '', preview: PREVIEW }), true);
    expect(container?.querySelector('.pp-code-src')).toBeNull();
  });

  it('args 到齐（code 就位）：文本一致且上色（hljs span）', () => {
    render(codeBlock({ code: 'const a = 1;' }));
    const src = container?.querySelector('.pp-code-src');
    expect(src?.textContent).toContain('const a = 1;');
    expect(src?.querySelector('span'), '终态应走 hljs').not.toBeNull();
  });
});
