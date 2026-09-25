// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-markdown-incremental — 增量解析（2026-08-30 性能专项）守护。
// 流式追加时 parseMarkdownIncremental 必须与全量 parseMarkdown 逐字节一致，
// 且稳定前缀块跨追加引用不变（引用复用 = 渲染/测量跳过已稳定块的核心证据）。
// measure 侧：measureBlockHeightCached 的 markdown 走增量，结果必须等于
// measureBlockHeight 全量（mock pretext，paper-markdown 同款）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { createBlock, resetBlockIdCounterForTests } from '../src/paper/block-model';
import { type MdBlock, parseMarkdown, parseMarkdownIncremental } from '../src/paper/markdown';
import {
  clearPaperMeasureCache,
  createBlockMeasureCache,
  measureBlockHeight,
  measureBlockHeightCached,
} from '../src/plugins/builtin/paper-shell/measure';

function block(kind: Parameters<typeof createBlock>[0], payload: object) {
  return createBlock(kind, payload as never, { messageId: 'm', part: null });
}

/** 确定性 PRNG（mulberry32）——随机化对拍可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 流式追加的词元池：markdown 结构片段 + 普通词（覆盖块边界翻转/续行/围栏闭合）。 */
const TOKENS = [
  '普通词甲',
  '普通词乙',
  'A',
  'b',
  '  ',
  '\n',
  '\n\n',
  '# 标题',
  '## 小标题',
  '- 列表项',
  '1. 编号项',
  '> 引用行',
  '```',
  '```ts',
  'const x = 1;',
  '```',
  '| 列 | 值 |',
  '| --- | --- |',
  '| 甲 | 1 |',
  '**加粗**',
  '`code`',
  '[链接](https://x.dev)',
  '~~删~~',
];

/** 追加一轮 → 断言增量 === 全量；追加场景下最后一块之前的前缀块引用稳定。
 *  注意：增量语义 = 只复用「最后一块之前」的稳定块；最后一块本身允许重建
 *  （它可能被续行/换行改变），故引用断言只覆盖 prefix。 */
function stepIncremental(
  prev: { blocks: MdBlock[]; state: ReturnType<typeof parseMarkdownIncremental>['state'] } | null,
  text: string,
) {
  const res = parseMarkdownIncremental(text, prev?.state ?? null);
  const full = parseMarkdown(text);
  expect(res.blocks).toEqual(full);
  // 真正的尾部追加（text 以 prev.text 开头）→ 最后一块之前的前缀块必须引用稳定
  const appended = prev != null && text.startsWith(prev.state.text) && prev.blocks.length > 1 && res.blocks.length > 1;
  if (appended) {
    const reusedCount = prev.blocks.length - 1; // 最后一块之前全部复用
    for (let i = 0; i < reusedCount; i++) {
      expect(res.blocks[i]).toBe(prev.blocks[i]);
    }
  }
  return res;
}

/* ═══ 增量正确性：追加 === 全量 ═══ */

describe('paper/markdown — parseMarkdownIncremental 正确性', () => {
  it('空起始；追加整行块序列', () => {
    const text = '# 标题\n\n正文甲\n\n正文乙';
    const res = stepIncremental(null, text);
    // 引用复用断言：无 prev 时全量建立
    expect(res.state.text).toBe(text);
  });

  it('追加续行（段落尾部增长）只重建最后一块', () => {
    const t1 = '# 标题\n\n第一段\n第二段续';
    const r1 = stepIncremental(null, t1);
    const t2 = '# 标题\n\n第一段\n第二段续 更长';
    const r2 = stepIncremental(r1, t2);
    // 标题块引用不变
    expect(r2.blocks[0]).toBe(r1.blocks[0]);
  });

  it('追加换行开新块；最后一块之前的前缀块引用不变', () => {
    const t1 = '# 标题\n\n正文甲';
    const r1 = stepIncremental(null, t1);
    const t2 = t1 + '\n\n正文乙';
    const r2 = stepIncremental(r1, t2);
    expect(r2.blocks).toHaveLength(3);
    // 标题是稳定前缀（最后一块之前）→ 引用不变；正文甲是 prev 最后一块，允许重建
    expect(r2.blocks[0]).toBe(r1.blocks[0]);
    expect((r2.blocks[r2.blocks.length - 1] as Extract<MdBlock, { t: 'p' }>).inl[0].text).toBe('正文乙');
  });

  it('未闭合围栏追加内容/闭合：从围栏块重解析，前置块稳定', () => {
    const t1 = '# 头\n\n```ts\nconst a';
    const r1 = stepIncremental(null, t1);
    const t2 = t1 + ' = 1;';
    const r2 = stepIncremental(r1, t2);
    expect((r2.blocks[r2.blocks.length - 1] as Extract<MdBlock, { t: 'code' }>).text).toBe('const a = 1;');
    expect(r2.blocks[0]).toBe(r1.blocks[0]);
    const t3 = t2 + '\n```\n\n尾部段落';
    const r3 = stepIncremental(r1, t3);
    expect(r3.blocks[0]).toBe(r1.blocks[0]);
  });

  it('列表追加续项/子项：列表块整体重建但前置稳定', () => {
    const t1 = '# 头\n\n- 甲\n- 乙';
    const r1 = stepIncremental(null, t1);
    const t2 = t1 + '\n- 丙';
    const r2 = stepIncremental(r1, t2);
    expect((r2.blocks[r2.blocks.length - 1] as Extract<MdBlock, { t: 'list' }>).items).toHaveLength(3);
    expect(r2.blocks[0]).toBe(r1.blocks[0]);
  });

  it('表格追加行', () => {
    const t1 = '# 头\n\n| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |';
    const r1 = stepIncremental(null, t1);
    const t2 = t1 + '\n| 乙 | 2 |';
    const r2 = stepIncremental(r1, t2);
    expect((r2.blocks[r2.blocks.length - 1] as Extract<MdBlock, { t: 'table' }>).rows).toHaveLength(2);
    expect(r2.blocks[0]).toBe(r1.blocks[0]);
  });

  it('引用块续行', () => {
    const t1 = '# 头\n\n> 引一';
    const r1 = stepIncremental(null, t1);
    const t2 = t1 + '\n> 引二';
    const r2 = stepIncremental(r1, t2);
    expect((r2.blocks[r2.blocks.length - 1] as Extract<MdBlock, { t: 'quote' }>).blocks).toHaveLength(1);
    expect(r2.blocks[0]).toBe(r1.blocks[0]);
  });

  it('非追加（编辑/重置）自动回退全量', () => {
    const t1 = '# 头\n\n正文甲';
    const r1 = stepIncremental(null, t1);
    // 中间编辑：不是前缀追加 → 全量重建
    const edited = '# 头\n\n正文乙';
    const r2 = stepIncremental(r1, edited);
    expect(r2.blocks).toEqual(parseMarkdown(edited));
    // 全量后引用不复用（旧块被替换）
    expect(r2.blocks[1]).not.toBe(r1.blocks[1]);
  });

  it('文本未变（同一 token 重复）→ 引用全复用零重建', () => {
    const t1 = '# 头\n\n正文甲';
    const r1 = stepIncremental(null, t1);
    const r2 = stepIncremental(r1, t1);
    expect(r2.blocks).toBe(r1.blocks);
  });

  it('随机追加 200 轮：每步增量 === 全量（确定性种子）', () => {
    const rand = mulberry32(20260830);
    let text = '';
    let state: ReturnType<typeof parseMarkdownIncremental>['state'] | null = null;
    let prevBlocks: MdBlock[] = [];
    for (let round = 0; round < 200; round++) {
      const count = 1 + Math.floor(rand() * 4);
      const chunk: string[] = [];
      for (let k = 0; k < count; k++) chunk.push(TOKENS[Math.floor(rand() * TOKENS.length)]);
      text += chunk.join(' ');
      const res = parseMarkdownIncremental(text, state);
      expect(res.blocks).toEqual(parseMarkdown(text));
      // 引用复用：新增行之前的前缀块必须稳定（尾部增长时）
      if (prevBlocks.length > 0 && res.blocks.length > 0) {
        const reusedCount = Math.min(prevBlocks.length - 1, res.blocks.length - 1);
        for (let i = 0; i < reusedCount; i++) expect(res.blocks[i]).toBe(prevBlocks[i]);
      }
      state = res.state;
      prevBlocks = res.blocks;
    }
  });
});

/* ═══ 测量端增量：cached === 全量 ═══ */

describe('paper/measure — measureBlockHeightCached 增量', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('markdown 块 cached 增量测量 === 全量测量（mock pretext 高 36）', () => {
    const cache = createBlockMeasureCache();
    const b = block('markdown', { text: '# 标题\n\n正文甲' });
    const h1 = measureBlockHeightCached(b, cache);
    expect(h1).toBe(measureBlockHeight(b));
    // 追加文本（流式）→ 增量路径高度仍等于全量
    const b2 = block('markdown', { text: '# 标题\n\n正文甲\n\n正文乙续写更长的一段内容' });
    // 同 id 才走缓存；流式是同块增长——用 b 的 id 手动对齐：
    (b2 as { id: string }).id = b.id;
    const h2 = measureBlockHeightCached(b2, cache);
    expect(h2).toBe(measureBlockHeight(b2));
  });
});
