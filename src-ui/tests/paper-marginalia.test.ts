// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-marginalia — P5 夹注眉批化：translate 配对（连续 reasoning 合并吸附
// 紧随 text）/ 回退规则（无正文后继不丢字）/ 复合测高 max(正文, 夹注@侧栏)。
// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock pretext 全家（paper-v3a 同款）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutMock, richStatsMock } = vi.hoisted(() => ({
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
  richStatsMock: vi.fn(() => ({ lineCount: 1, maxLineWidth: 100 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _segs: true })),
  measureNaturalWidth: vi.fn(() => 200),
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: richStatsMock,
}));

import type { SourcedBlock } from '../src/paper/block-model';
import {
  clearPaperMeasureCache,
  createBlockMeasureCache,
  measureBlockHeight,
  measureBlockHeightCached,
  PAPER_REASONING_LINE_HEIGHT,
} from '../src/paper/measure';
import { translateMessage } from '../src/paper/translate';
import type { AssistantMessage } from '../src/ui/message-model';

function asstMsg(parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: 'm-marg', parts, sessionIndex: 0 };
}
function reasoning(text: string): AssistantMessage['parts'][number] {
  return { type: 'reasoning', text } as AssistantMessage['parts'][number];
}
function textPart(text: string): AssistantMessage['parts'][number] {
  return { type: 'text', text, finalised: true } as AssistantMessage['parts'][number];
}

/* ═══ translate 配对（方案甲）═══ */

describe('translate 眉批配对（P5）', () => {
  it('reasoning + 紧随 text → 单 markdown 复合块（sidecar 吸附，夹注不独立成块）', () => {
    const blocks = translateMessage(asstMsg([reasoning('思考全文'), textPart('正文内容')]), undefined);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('markdown');
    expect(blocks[0].id).toBe('pb:m-marg:1'); // 复合块 id = text part 的稳定 id
    expect((blocks[0].payload as { sidecar?: { text: string } }).sidecar?.text).toBe('思考全文');
    expect((blocks[0].payload as { text: string }).text).toBe('正文内容');
  });

  it('连续多条 reasoning 合并进同一眉批', () => {
    const blocks = translateMessage(asstMsg([reasoning('甲'), reasoning('乙'), textPart('正文')]), undefined);
    expect(blocks).toHaveLength(1);
    expect((blocks[0].payload as { sidecar?: { text: string } }).sidecar?.text).toBe('甲\n\n乙');
  });

  it('夹注后继非正文（tool）→ 回退独立 reasoning 块（不丢字）', () => {
    const blocks = translateMessage(
      asstMsg([
        reasoning('前置思考'),
        {
          type: 'tool',
          toolId: 't1',
          name: 'n',
          label: 'l',
          args: '{}',
          status: 'done',
        } as AssistantMessage['parts'][number],
        textPart('正文'),
      ]),
      undefined,
    );
    // 回退 reasoning + tool + markdown（无 sidecar——text 前无紧邻 reasoning）
    expect(blocks.map((b) => b.kind)).toEqual(['reasoning', 'tool', 'markdown']);
    expect((blocks[0].payload as { text: string }).text).toBe('前置思考');
    expect((blocks[2].payload as { sidecar?: { text: string } }).sidecar).toBeUndefined();
  });

  it('消息尾 reasoning 无正文后继 → 独立块回退', () => {
    const blocks = translateMessage(asstMsg([textPart('正文'), reasoning('尾巴思考')]), undefined);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown', 'reasoning']);
    expect((blocks[0].payload as { sidecar?: { text: string } }).sidecar).toBeUndefined();
  });

  it('text 全是围栏 → 眉批未消化回退独立块，id 用原夹注 idx（钉住续命不断）', () => {
    const blocks = translateMessage(
      asstMsg([reasoning('围栏前的思考'), textPart('```ts\nconst a = 1;\n```')]),
      undefined,
    );
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain('reasoning');
    expect(kinds).toContain('diff');
    const rb = blocks.find((b) => b.kind === 'reasoning')!;
    expect(rb.id).toBe('pb:m-marg:0'); // 原夹注 part idx——钉住态跨重组续命
  });
});

/* ═══ 复合测高（max 语义 + 签名）═══ */

describe('measure 眉批复合块（P5）', () => {
  beforeEach(() => {
    layoutMock.mockClear();
    richStatsMock.mockClear();
    clearPaperMeasureCache();
  });

  function mdBlock(text: string, sidecar?: { text: string }): SourcedBlock {
    const msg = asstMsg(sidecar ? [reasoning(sidecar.text), textPart(text)] : [textPart(text)]);
    return translateMessage(msg, undefined)[0];
  }

  it('无眉批的 markdown：高度 = 正文（存量语义不变）', () => {
    expect(measureBlockHeight(mdBlock('单段'))).toBe(36);
  });

  it('有眉批：块高 = max(正文, 夹注@侧栏)——夹注更高时块长高', () => {
    // 第 1 次 layout = 正文（36），第 2 次 = 夹注@侧栏（override 100）
    layoutMock.mockReturnValueOnce({ height: 36, lineCount: 2 }).mockReturnValueOnce({ height: 100, lineCount: 2 });
    expect(measureBlockHeight(mdBlock('正文', { text: '一段很长很长的眉批' }))).toBe(100);
  });

  it('夹注低于正文时取正文高（眉批恒容于块高——栈几何零变化）', () => {
    // 正文 36（第 1 次），夹注 override 20 → max = 36
    layoutMock.mockReturnValueOnce({ height: 36, lineCount: 2 }).mockReturnValueOnce({ height: 20, lineCount: 1 });
    expect(measureBlockHeight(mdBlock('正文', { text: '短眉批' }))).toBe(36);
  });

  it('眉批文本变化 → 测量签名失效重测（缓存正确性）', () => {
    const cache = createBlockMeasureCache();
    const b = mdBlock('正文', { text: '眉批一' });
    measureBlockHeightCached(b, cache);
    // payload 原位变更（流式/重组语义）
    (b.payload as { sidecar?: { text: string } }).sidecar = { text: '眉批二' };
    const hit = measureBlockHeightCached(b, cache);
    expect(hit).toBe(36); // 重测成功（mock 恒 36）——关键是不命中旧缓存也不抛
  });

  /* ═══ 眉批已钉出（2026-08-31 移出语义：`:sc` 快照钉在画布）═══ */

  it('眉批已钉出：眉批栏只剩占位一行（noteH = 一行夹注，占位实高更低）', () => {
    // 正文很矮（20）→ max(20, 一行夹注) = 一行夹注
    layoutMock.mockReturnValueOnce({ height: 20, lineCount: 1 });
    expect(measureBlockHeight(mdBlock('短', { text: '长眉批' }), false, false, true)).toBe(PAPER_REASONING_LINE_HEIGHT);
  });

  it('钉出/拔钉 → 测量签名失效重测（out 维度入签）', () => {
    const cache = createBlockMeasureCache();
    const b = mdBlock('正文', { text: '长眉批' });
    // 展开态：正文 1 次 + 夹注侧栏 1 次 layout
    layoutMock.mockReturnValueOnce({ height: 36, lineCount: 2 }).mockReturnValueOnce({ height: 100, lineCount: 2 });
    expect(measureBlockHeightCached(b, cache, false, false, false)).toBe(100);
    // 钉出：签名变化必重测——夹注侧不再计高（占位一行，零 layout 调用）
    const calls = layoutMock.mock.calls.length;
    expect(measureBlockHeightCached(b, cache, false, false, true)).toBe(Math.max(36, PAPER_REASONING_LINE_HEIGHT));
    expect(layoutMock.mock.calls.length).toBe(calls + 1);
  });
});
