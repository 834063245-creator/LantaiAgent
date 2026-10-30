// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P5 结构化完成值（code-execution-upgrade-plan §7）：程序 `return {__view:'table'|'diff',…}`
// → 纸面把完成值段渲成真表格 / 差分块，而不是一坨 JSON 文本。
//
// 断言按**用户可见结果**写：一张程文卡展开后看到的是表头 + 行、或带增删墨色的差分；
// 折叠行读数是「表格 3×2」而不是字数。模型面零改动（工具返回值原样 JSON）——
// 视图是展示投影，证据是「translate 不改 output、只多一个 view 字段」。
//
// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock '@chenglou/pretext'（同 paper-code-output）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutMock } = vi.hoisted(() => ({
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import type { SourcedBlock } from '../src/paper/block-model';
import { codeViewOf, codeViewReadout, tableViewNote } from '../src/paper/code-view';
import { foldLabel } from '../src/paper/fold';
import { translateMessages } from '../src/paper/translate';
import { builtinRendererDefs } from '../src/plugins/builtin/paper-renderers/renderers';
import {
  blockHasView,
  inkSourcesFor,
  measureBlockHeight,
  needsObservedHeight,
} from '../src/plugins/builtin/paper-shell/measure';
import type { AssistantMessage, ToolCallPart } from '../src/ui/message-model';

/** 程文信封（真源 = agent/code-run/code-execution-tool.ts 的生成形状）。 */
const envelope = (result: string): string => `── result ──\n${result}`;

/** `return {__view:'table', …}` 的真实落盘形态。
 *  注意 **不是** 数组形态——数组会让纸面走 JSON 文本兜底（视图只认对象）。 */
const tableOut = (o: Record<string, unknown>, logs?: string): string => {
  const body = envelope(JSON.stringify({ __view: 'table', ...o }));
  return logs ? `── logs ──\n${logs}\n${body}` : body;
};

const diffOut = (o: Record<string, unknown>): string => envelope(JSON.stringify({ __view: 'diff', ...o }));

/** code_execution 的 tool part → 消息（子代理路径同构，用 name 区分不了——两个分支都过）。 */
function codeMessage(output: string | undefined): AssistantMessage {
  const part: ToolCallPart = {
    type: 'tool',
    toolId: 'tc1',
    name: 'code_execution',
    args: JSON.stringify({ code: 'return rows;', description: '盘点' }),
    label: 'code_execution',
    readOnly: false,
    status: 'done',
    output,
  };
  return { role: 'assistant', _id: 'm1', parts: [part], status: 'done', respondingTo: 'u1' };
}

/** 转译一条消息 → 单块（端到端：信封 → 视图 → payload）。 */
function blockOf(output: string | undefined): SourcedBlock {
  const blocks = translateMessages([codeMessage(output)]);
  expect(blocks).toHaveLength(1);
  return blocks[0];
}

/* ── ① 解析：完成值段 → 视图（形状不认识一律回落 JSON 文本）── */

describe('codeViewOf：完成值段 → 视图', () => {
  it('table：列/行归一（数字/布尔/null/对象都成文本）', () => {
    const view = codeViewOf(
      tableOut({
        columns: ['名', '数'],
        rows: [
          ['a', 1],
          [true, null],
          [{ k: 1 }, [1, 2]],
        ],
      }),
    );
    expect(view?.kind).toBe('table');
    if (view?.kind !== 'table') throw new Error('应为表格视图');
    expect(view.columns).toEqual(['名', '数']);
    expect(view.rows).toEqual([
      ['a', '1'],
      ['true', ''],
      ['{"k":1}', '[1,2]'],
    ]);
    expect(view.dropped).toEqual({ rows: 0, cols: 0, cells: 0 });
    expect(tableViewNote(view)).toBe('');
    expect(view.caption).toBeUndefined();
  });

  it('table：columns 缺省由最宽行派生 #1..#N；题签进视图', () => {
    const view = codeViewOf(
      tableOut({
        rows: [
          [1, 2, 3],
          [4, 5, 6],
        ],
        caption: '三列',
      }),
    );
    if (view?.kind !== 'table') throw new Error('应为表格视图');
    expect(view.columns).toEqual(['#1', '#2', '#3']);
    expect(view.caption).toBe('三列');
  });

  it('table：columns 比行窄 → 补空；比行宽 → 取到最宽', () => {
    const narrow = codeViewOf(tableOut({ columns: ['a'], rows: [['1', '2']] }));
    if (narrow?.kind !== 'table') throw new Error('应为表格视图');
    expect(narrow.columns).toEqual(['a', '']);
    const wide = codeViewOf(tableOut({ columns: ['a', 'b'], rows: [['1']] }));
    if (wide?.kind !== 'table') throw new Error('应为表格视图');
    expect(wide.columns).toEqual(['a', 'b']);
    expect(wide.rows[0]).toEqual(['1', '']);
  });

  it('table：行超上限 / 列超上限 / 单元格超长 → 出注记（不静默丢）', () => {
    const rows = Array.from({ length: 205 }, (_, i) => [String(i)]);
    const view = codeViewOf(tableOut({ columns: Array.from({ length: 14 }, (_, i) => `c${i}`), rows }));
    if (view?.kind !== 'table') throw new Error('应为表格视图');
    expect(view.rows).toHaveLength(200);
    expect(view.columns).toHaveLength(12);
    expect(view.dropped.rows).toBe(5);
    expect(view.dropped.cols).toBe(2);
    expect(tableViewNote(view)).toContain('其余 5 行未显示（共 205 行）');
    expect(tableViewNote(view)).toContain('其余 2 列未显示（共 14 列）');

    const long = codeViewOf(tableOut({ rows: [['x'.repeat(260)]] }));
    if (long?.kind !== 'table') throw new Error('应为表格视图');
    expect(long.dropped.cells).toBe(1);
    expect(long.rows[0][0].endsWith('…')).toBe(true);
    expect(tableViewNote(long)).toContain('1 格超长已截断');
  });

  it('diff：文本归一（尾空行去掉）+ 行首增删读数', () => {
    const view = codeViewOf(diffOut({ diff: '@@ -1 +1 @@\n-a\n+b\n' }));
    if (view?.kind !== 'diff') throw new Error('应为差分视图');
    expect(view.text).toBe('@@ -1 +1 @@\n-a\n+b');
    expect(codeViewReadout(view)).toBe('差分 +1 −1');
    // 空文本 / 纯空白不算差分（别支一个空段头）
    expect(codeViewOf(diffOut({ diff: ' \n ' }))).toBeNull();
  });

  it('只认「完成值」段：日志里带 __view 不算程序返回值', () => {
    const out = `── logs ──\n${JSON.stringify({ __view: 'table', rows: [[1]] })}`;
    expect(codeViewOf(out)).toBeNull();
  });

  it('形状不认识 / 未知 __view / 截断 JSON → null（调用方回落 JSON 文本）', () => {
    expect(codeViewOf(undefined)).toBeNull();
    expect(codeViewOf('裸文本')).toBeNull();
    expect(codeViewOf(envelope('{"count":2}'))).toBeNull();
    expect(codeViewOf(envelope(JSON.stringify({ __view: 'chart', rows: [[1]] })))).toBeNull();
    expect(codeViewOf(envelope(JSON.stringify({ __view: 'table' })))).toBeNull(); // 无 rows
    expect(codeViewOf(envelope(JSON.stringify({ __view: 'table', rows: [1, 2] })))).toBeNull(); // 行不是数组
    expect(codeViewOf(envelope(JSON.stringify({ __view: 'table', rows: [] })))).toBeNull(); // 零列零行
    expect(codeViewOf(envelope(JSON.stringify({ __view: 'diff', text: 'x' })))).toBeNull(); // 缺 diff
    // 预算截断：JSON 没闭口 → 解析失败 → 照旧当文本读
    expect(codeViewOf(envelope('{"__view":"table","rows":[[1,2'))).toBeNull();
  });

  it('数组完成值不误判（视图只认对象）', () => {
    expect(codeViewOf(envelope('[{"__view":"table","rows":[[1]]}]'))).toBeNull();
  });
});

/* ── ② 转译：视图进 payload（模型面字节零改动）── */

describe('translate：程文块带视图', () => {
  it('完成值段是 __view 对象 → payload.view；output 原文不动（模型面零改动）', () => {
    const out = tableOut({ columns: ['a'], rows: [['1']] });
    const block = blockOf(out);
    expect(block.kind).toBe('code');
    const p = block.payload as { output?: string; view?: { kind: string } };
    expect(p.output).toBe(out); // 原文逐字保留（卷里 / 模型看到的是同一串）
    expect(p.view?.kind).toBe('table');
  });

  it('普通完成值不带 view 字段（零回归——旧卡 payload 形状不变）', () => {
    const block = blockOf(envelope('{"count":2}'));
    expect('view' in (block.payload as object)).toBe(false);
  });

  it('子代理组内的程文块同构（同一构造点）', () => {
    const out = tableOut({ columns: ['a'], rows: [['1']] });
    const sub: AssistantMessage = {
      role: 'assistant',
      _id: 'm2',
      parts: [
        {
          type: 'subagent',
          agentId: 'a1',
          description: '子任务',
          status: 'done',
          parts: [
            {
              type: 'tool',
              toolId: 'tc2',
              name: 'code_execution',
              args: JSON.stringify({ code: 'return 1;', description: '子程序' }),
              label: 'code_execution',
              readOnly: false,
              status: 'done',
              output: out,
            },
          ],
        },
      ],
      status: 'done',
      respondingTo: 'u1',
    };
    const blocks = translateMessages([sub]);
    const code = blocks.find((b) => b.kind === 'code');
    expect(code, '子代理组内有程文块').toBeDefined();
    const p = code?.payload as { description?: string; view?: { kind: string } };
    expect(p.description).toBe('[子] 子程序');
    expect(p.view?.kind).toBe('table');
  });
});

/* ── ③ 渲染面：真表格 / 差分墨色（用户可见结果）── */

describe('渲染面 — 结构化完成值', () => {
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

  const renderBlock = (block: SourcedBlock, folded = false) => {
    const def = builtinRendererDefs().find((d) => d.kind === 'code');
    expect(def, '内置 code 渲染器存在').toBeDefined();
    act(() => {
      root?.render(createElement(def?.component, { block, folded }));
    });
  };

  it('表格视图：真 <table>（表头 + 行），JSON 原文不再出现在卡面', () => {
    renderBlock(
      blockOf(
        tableOut({
          columns: ['文件', '行数'],
          rows: [
            ['a.ts', 12],
            ['b.ts', 3],
          ],
        }),
      ),
    );
    const table = container?.querySelector('.pp-code-view-table');
    expect(table).not.toBeNull();
    expect([...(table?.querySelectorAll('th') ?? [])].map((el) => el.textContent)).toEqual(['文件', '行数']);
    expect([...(table?.querySelectorAll('tbody td') ?? [])].map((el) => el.textContent)).toEqual([
      'a.ts',
      '12',
      'b.ts',
      '3',
    ]);
    // 段头仍是「完成值」（段语义不变，只换体）；JSON 原文一个字都不上纸
    expect([...(container?.querySelectorAll('.pp-sec-label') ?? [])].map((el) => el.textContent)).toEqual(['完成值']);
    expect(container?.textContent).not.toContain('__view');
  });

  it('表格视图：题签与省略注记各占一行', () => {
    const rows = Array.from({ length: 203 }, (_, i) => [String(i)]);
    renderBlock(blockOf(tableOut({ columns: ['n'], rows, caption: '盘点' })));
    expect(container?.querySelector('.pp-code-view-caption')?.textContent).toBe('盘点');
    expect(container?.querySelector('.pp-code-view-note')?.textContent).toContain('其余 3 行未显示');
  });

  it('差分视图：三档墨色（增/删/块头）', () => {
    renderBlock(blockOf(diffOut({ diff: '@@ -1 +1 @@\n-old\n+new\n context' })));
    const sec = container?.querySelector('.pp-sec--result');
    expect(sec?.querySelector('.pp-add')?.textContent).toBe('+new');
    expect(sec?.querySelector('.pp-del')?.textContent).toBe('-old');
    expect(sec?.querySelector('.pp-hunk')?.textContent).toBe('@@ -1 +1 @@');
    expect(sec?.textContent).toContain('context');
    expect(sec?.textContent).not.toContain('__view');
  });

  it('折叠态：收程序体、视图照常留面（结果一眼可见）', () => {
    renderBlock(blockOf(tableOut({ rows: [['1']] })), true);
    expect(container?.querySelector('.pp-code-src')).toBeNull();
    expect(container?.querySelector('.pp-code-view-table')).not.toBeNull();
  });

  it('无视图的老卡：仍是 JSON 文本段（零回归）', () => {
    renderBlock(blockOf(envelope('{"count":2}')));
    expect(container?.querySelector('.pp-code-view-table')).toBeNull();
    expect(container?.querySelector('.pp-code-view')).toBeNull();
  });
});

/* ── ④ 测高与墨迹：表格几何 / 封顶 / 实测族 ── */

describe('测量镜像 — 结构化完成值', () => {
  const rowsOut = (n: number): string =>
    tableOut({ columns: ['n'], rows: Array.from({ length: n }, (_, i) => [String(i)]) });

  it('表格随行数长高；超滚动上限后封顶（与文本段同一道闸）', () => {
    const small = measureBlockHeight(blockOf(rowsOut(2)));
    const mid = measureBlockHeight(blockOf(rowsOut(4)));
    expect(mid).toBeGreaterThan(small);
    // 200 行与 60 行都越出 .pp-out 的 200px 上限 ⇒ 同高（滚动部分不占流内高）
    expect(measureBlockHeight(blockOf(rowsOut(200)))).toBe(measureBlockHeight(blockOf(rowsOut(60))));
  });

  it('每一行都真占高（不是被当成一行 JSON 压扁）', () => {
    const one = blockOf(tableOut({ rows: [['1']] }));
    const three = blockOf(tableOut({ rows: [['1'], ['2'], ['3']] }));
    expect((three.payload as { view?: unknown }).view, '视图已进 payload').toBeDefined();
    // 两行之差 ≈ 2 行盒（mock 行盒 36 + 单元内距 8 + 规线 1 = 45；不钉死到像素，钉「真占高」）
    expect(measureBlockHeight(three) - measureBlockHeight(one)).toBeGreaterThan(2 * 40);
  });

  it('墨迹：表头 + 逐行落位（y 递增，行数 = 行 + 表头 + 程序体）', () => {
    const block = blockOf(
      tableOut({
        columns: ['a', 'b'],
        rows: [
          ['1', '2'],
          ['3', '4'],
        ],
      }),
    );
    const sources = inkSourcesFor(block, false);
    expect(sources).toHaveLength(1 + 3); // 程序体 + 表头 + 2 数据行（一行一源，同 markdown 表格）
    for (let i = 1; i < sources.length; i++) expect(sources[i].y).toBeGreaterThan(sources[i - 1].y);
  });

  it('实测族：有视图的程文挂 RO（折行点只能实测），无视图不挂（零漂移）', () => {
    expect(needsObservedHeight('code', false, true)).toBe(true);
    expect(needsObservedHeight('code', false)).toBe(false);
    expect(needsObservedHeight('tool', false)).toBe(false);
    // 壳层同一判据（data-block-observed 的入参）——两处读同一份 payload 投影
    expect(blockHasView(blockOf(tableOut({ rows: [['1']] })))).toBe(true);
    expect(blockHasView(blockOf(envelope('{"count":2}')))).toBe(false);
  });
});

/* ── ⑤ 折叠行读数（用户 95% 时间看到的那一行）── */

describe('折叠读数 — 结构化完成值', () => {
  it('表格 = 行列数；差分 = 增删计数', () => {
    const table = blockOf(
      tableOut({
        rows: [
          ['1', '2'],
          ['3', '4'],
        ],
      }),
    );
    expect(foldLabel('code', table.payload, true)).toContain('表格 2×2');
    const diff = blockOf(diffOut({ diff: '@@ -1 +1 @@\n-a\n+b\n+c' }));
    expect(foldLabel('code', diff.payload, true)).toContain('差分 +2 −1');
  });

  it('无视图的程文仍走字数读数（零回归）', () => {
    const plain = blockOf(`── logs ──\nhi\n── result ──\nok`);
    expect(foldLabel('code', plain.payload, true)).toContain('输出');
  });
});
