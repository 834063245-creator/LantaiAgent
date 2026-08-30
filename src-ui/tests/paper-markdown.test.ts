// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-markdown — 会话流渲染专项（2026-08-30）：markdown 单一解析 +
// 折叠机制（规则/文案/测高）。measure 依赖 Canvas 2D（jsdom 没有）→
// vi.mock '@chenglou/pretext'（paper-v3a 同款；只测结构记账面）。

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
// P3：measure 的富行内路径 → 子路径出口同样 mock（本文件文本全纯文本，rich 不触发）
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { createBlock, resetBlockIdCounterForTests } from '../src/paper/block-model';
import { defaultFolded, foldLabel, foldPreviewLine, isFoldable } from '../src/paper/fold';
import { type MdBlock, mdHasRichInline, mdPlainText, parseInline, parseMarkdown } from '../src/paper/markdown';
import {
  clearPaperMeasureCache,
  createBlockMeasureCache,
  FOLD_ROW_H,
  measureBlockHeight,
  measureBlockHeightCached,
  PAPER_REASONING_LINE_HEIGHT,
} from '../src/paper/measure';

function block(kind: Parameters<typeof createBlock>[0], payload: object) {
  return createBlock(kind, payload as never, { messageId: 'm', part: null });
}

/* ═══ 行内解析 ═══ */

describe('paper/markdown — parseInline', () => {
  it('纯文本单片段；加粗/斜体/删除线/行内码/链接打平为带标志片段', () => {
    expect(parseInline('plain')).toEqual([{ text: 'plain' }]);
    expect(parseInline('**加粗**')).toEqual([{ text: '加粗', b: true }]);
    expect(parseInline('*斜体*')).toEqual([{ text: '斜体', i: true }]);
    expect(parseInline('~~删了~~')).toEqual([{ text: '删了', s: true }]);
    expect(parseInline('`code()`')).toEqual([{ text: 'code()', c: true }]);
    expect(parseInline('[兰台](https://lantai.example)')).toEqual([{ text: '兰台', href: 'https://lantai.example' }]);
  });

  it('混合序列保序拆分；嵌套强调标志叠加（***粗斜***）', () => {
    const segs = parseInline('前 **粗** 后 *斜* 尾');
    expect(segs.map((s) => s.text)).toEqual(['前 ', '粗', ' 后 ', '斜', ' 尾']);
    expect(segs[1]).toMatchObject({ b: true });
    const both = parseInline('***粗斜***');
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ b: true, i: true, text: '粗斜' });
  });

  it('未配对标记按字面量保留（流式容忍）；行内码内不解析标记', () => {
    expect(parseInline('a ** b')).toEqual([{ text: 'a ** b' }]);
    expect(parseInline('`**不强调**`')).toEqual([{ text: '**不强调**', c: true }]);
    expect(parseInline('转义 \\*\\* 字面')).toEqual([{ text: '转义 ** 字面' }]);
  });

  it('snake_case 下划线不斜体（intraword `_` 边界约束）', () => {
    expect(parseInline('a _b_c_d')).toEqual([{ text: 'a _b_c_d' }]);
    expect(parseInline('词 _斜体_ 词')).toEqual([{ text: '词 ' }, { text: '斜体', i: true }, { text: ' 词' }]);
  });

  it('mdPlainText 拼纯文本；mdHasRichInline 判富行内', () => {
    const inl = parseInline('a `c` **b** [l](u)');
    expect(mdPlainText(inl)).toBe('a c b l');
    expect(mdHasRichInline(inl)).toBe(true);
    expect(mdHasRichInline(parseInline('纯文本'))).toBe(false);
  });
});

/* ═══ 块级解析 ═══ */

describe('paper/markdown — parseMarkdown', () => {
  it('标题 1-4 级（5/6 收 4）；段落按空行分块', () => {
    const blocks = parseMarkdown('# 一\n## 二\n### 三\n#### 四\n##### 五\n正文甲\n\n正文乙');
    expect(blocks.map((b) => (b as { t: string }).t)).toEqual(['h', 'h', 'h', 'h', 'h', 'p', 'p']);
    expect(blocks[4]).toMatchObject({ lv: 4 });
  });

  it('无序/有序列表；有序起始号保留', () => {
    const ul = parseMarkdown('- 甲\n- 乙');
    expect(ul[0]).toMatchObject({ t: 'list', ord: false, start: 1 });
    const ol = parseMarkdown('3. 丙\n4. 丁');
    expect(ol[0]).toMatchObject({ t: 'list', ord: true, start: 3 });
  });

  it('嵌套列表：深缩进归入父项 sub（递归块模型）', () => {
    const blocks = parseMarkdown('- 父\n  - 子\n- 兄弟');
    const list = blocks[0] as Extract<MdBlock, { t: 'list' }>;
    expect(list.items).toHaveLength(2);
    expect(list.items[0].sub?.[0]).toMatchObject({ t: 'list' });
    expect(list.items[1].sub).toBeUndefined();
  });

  it('引用剥标记递归；围栏码（未闭合流式容忍）；分隔线', () => {
    const quote = parseMarkdown('> 引一行\n> 引二行');
    expect(quote[0]).toMatchObject({ t: 'quote' });
    const code = parseMarkdown('```ts\nconst a = 1;');
    expect(code[0]).toMatchObject({ t: 'code', lang: 'ts', text: 'const a = 1;' });
    expect(parseMarkdown('---')[0]).toMatchObject({ t: 'hr' });
  });

  it('GFM 表格：表头 + 行；分隔行不进结果', () => {
    const blocks = parseMarkdown('| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ t: 'table' });
    const table = blocks[0] as Extract<MdBlock, { t: 'table' }>;
    expect(table.head.map((c) => mdPlainText(c))).toEqual(['名', '值']);
    expect(table.rows).toHaveLength(2);
  });

  it('空串 → 空模型；超出子集的行 → 段落兜底不丢字', () => {
    expect(parseMarkdown('')).toEqual([]);
    const weird = parseMarkdown('普通一句\n缩进   文本');
    expect(weird[weird.length - 1]).toMatchObject({ t: 'p' });
  });
});

/* ═══ 折叠规则（paper/fold）═══ */

describe('paper/fold — 默认规则与文案', () => {
  it('夹注恒折叠；脚注/程文 running|error 展开、done|pending 收起；其余不可折叠', () => {
    expect(defaultFolded('reasoning', {})).toBe(true);
    expect(defaultFolded('tool', { status: 'running' })).toBe(false);
    expect(defaultFolded('tool', { status: 'error' })).toBe(false);
    expect(defaultFolded('tool', { status: 'done' })).toBe(true);
    expect(defaultFolded('tool', { status: 'pending' })).toBe(true);
    expect(defaultFolded('code', { status: 'running' })).toBe(false);
    expect(defaultFolded('code', { status: 'done' })).toBe(true);
    expect(defaultFolded('markdown', {})).toBe(false);
    expect(defaultFolded('user', {})).toBe(false);
    expect(isFoldable('reasoning')).toBe(true);
    expect(isFoldable('tool')).toBe(true);
    expect(isFoldable('code')).toBe(true);
    expect(isFoldable('markdown')).toBe(false);
  });

  it('折叠行文案：折叠报「名字+参数摘要」（2026-08-30 会话流专项，纯字数退役），展开报收起', () => {
    expect(foldLabel('reasoning', { text: 'x'.repeat(214) }, true)).toBe('▸ 思考 214 字');
    expect(foldLabel('reasoning', { text: '思' }, false)).toBe('▾ 收起思考');
    expect(foldLabel('tool', { name: 'edit', label: 'edit', args: '{"file_path":"a.ts"}', output: 'ok' }, true)).toBe(
      '▸ edit a.ts · 输出 2 字',
    );
    expect(foldLabel('tool', { args: '', output: '', err: '' }, true)).toBe('▸ 工具 · 待执行');
    expect(foldLabel('tool', { args: 'a' }, false)).toBe('▾ 收起 工具');
    expect(foldLabel('code', { code: 'abcd' }, true)).toBe('▸ 程序');
    expect(foldLabel('code', { code: 'abcd' }, false)).toBe('▾ 收起 程序');
  });

  it('夹注预览取首个非空行', () => {
    expect(foldPreviewLine('\n\n第二行才是货\n第三行')).toBe('第二行才是货');
    expect(foldPreviewLine('   \n')).toBe('');
  });
});

/* ═══ 折叠/ markdown 测高（mock pretext：文本高恒 36）═══ */

describe('paper/measure — 折叠态计高', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('夹注：展开 = 折叠行 + 全文；折叠 = 折叠行 + 一行预览高', () => {
    const b = block('reasoning', { text: '思考全文' });
    expect(measureBlockHeight(b, false)).toBe(FOLD_ROW_H + 36);
    expect(measureBlockHeight(b, true)).toBe(FOLD_ROW_H + PAPER_REASONING_LINE_HEIGHT);
  });

  it('脚注：展开 = 折叠行 + 参数 + 输出 + 错误；折叠 = 折叠行（全部收起）', () => {
    const b = block('tool', { toolId: 't', name: 'n', label: 'l', args: 'a', status: 'done', output: 'o', err: 'e' });
    expect(measureBlockHeight(b, false)).toBe(10 + FOLD_ROW_H + 36 + 49 + 49);
    expect(measureBlockHeight(b, true)).toBe(10 + FOLD_ROW_H);
  });

  it('程文：折叠收程序体、留输出/错误（执行结果可见——与脚注的差异面）', () => {
    const b = block('code', { toolId: 't', description: 'd', code: 'c', status: 'done', output: 'o', err: 'e' });
    // 56 = 36 文本 + 20 程序体纵向内距（.pp-code-src 内距镜像，2026-08-30 溢出修复）
    expect(measureBlockHeight(b, false)).toBe(10 + FOLD_ROW_H + 56 + 49 + 49);
    expect(measureBlockHeight(b, true)).toBe(10 + FOLD_ROW_H + 49 + 49);
  });

  it('脚注参数测高消费 prettyToolArgs（渲染/测量同源变换）', () => {
    const raw = block('tool', { toolId: 't', name: 'n', label: 'l', args: '{"a":1}', status: 'done' });
    // pretty 后文本仍为一段（mock 恒 36）——此处只验证不因规整而炸
    expect(measureBlockHeight(raw, false)).toBe(10 + FOLD_ROW_H + 36);
  });

  it('折叠切换 = 签名变化 → 重测（缓存不以旧态命中）', () => {
    const cache = createBlockMeasureCache();
    const b = block('reasoning', { text: '思考' });
    measureBlockHeightCached(b, cache, true);
    measureBlockHeightCached(b, cache, true);
    expect(layoutMock).toHaveBeenCalledTimes(0); // 折叠态预览高 = 常量，零 canvas 测量
    measureBlockHeightCached(b, cache, false);
    expect(layoutMock).toHaveBeenCalledTimes(1); // 展开态真测一次
    measureBlockHeightCached(b, cache, false);
    expect(layoutMock).toHaveBeenCalledTimes(1); // 同态命中
  });
});

describe('paper/measure — markdown 计高（mock 36/段）', () => {
  beforeEach(() => {
    prepareMock.mockClear();
    layoutMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('单段 = 纯文本高；双段 = 段高 + MD_P_GAP(14) + 段高', () => {
    expect(measureBlockHeight(block('markdown', { text: '单段' }))).toBe(36);
    expect(measureBlockHeight(block('markdown', { text: 'p1\n\np2' }))).toBe(36 + 14 + 36);
  });

  it('标题计 padding 上下 + 文本；列表计条目缩进列与末项归零', () => {
    // h1：pt 22 + 文本 36 + pb 10
    expect(measureBlockHeight(block('markdown', { text: '# 题' }))).toBe(22 + 36 + 10);
    // 两项列表：(36+6)+(36+6) - 末项 gap 6 = 78
    expect(measureBlockHeight(block('markdown', { text: '- 甲\n- 乙' }))).toBe(78);
  });

  it('引用/图码/分隔线/表格各自记账（末元素 margin 归零镜像）', () => {
    expect(measureBlockHeight(block('markdown', { text: '> 引' }))).toBe(4 + 36);
    expect(measureBlockHeight(block('markdown', { text: '```\ncode\n```' }))).toBe(20 + 36);
    expect(measureBlockHeight(block('markdown', { text: '---' }))).toBe(19);
    expect(measureBlockHeight(block('markdown', { text: '| a |\n| --- |' }))).toBe(36 + 8 + 1);
  });

  it('嵌套列表 = 项文本 + 嵌套列表（+4 顶距）', () => {
    // 单项：36 + (4 + 子列表 36) = 76
    expect(measureBlockHeight(block('markdown', { text: '- 父\n  - 子' }))).toBe(76);
  });

  it('空 markdown = 0（零成本路径）', () => {
    expect(measureBlockHeight(block('markdown', { text: '' }))).toBe(0);
  });
});
