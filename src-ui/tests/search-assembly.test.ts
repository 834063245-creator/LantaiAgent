// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// search 输出组装层测试（R2-d(2)，kernel-capability-r2-search-pilot.md §8：
// search_cap 收窄为纯扫描后，三形态组装/分页/行号显示/截断判定在 TS 编排层
// 重建）。输出键序 = R2-d(2) 前 Rust search_cap.rs 组装分支的 serde_json 构造序
// ——消费方 parseJson 语义不变。

import { describe, expect, it } from 'vitest';

import {
  assembleSearchOutput,
  parseScanOutput,
  type ScanOutput,
  toScanParams,
} from '../src/agent/tools/search-assembly';

function scanOf(overrides: Partial<ScanOutput> = {}): ScanOutput {
  return {
    pattern: 'hello',
    scanned_files: 3,
    budget_truncated: false,
    files: [
      {
        file: 'D:/x/src/b.ts',
        match_count: 2,
        matches: [
          {
            line: 3,
            content: 'hello world',
            context: [
              { line: 2, content: 'x' },
              { line: 3, content: 'hello world' },
              { line: 4, content: 'y' },
            ],
          },
          { line: 7, content: 'say hello', context: [{ line: 7, content: 'say hello' }] },
        ],
      },
      {
        file: 'D:/x/src/a.ts',
        match_count: 1,
        matches: [{ line: 1, content: 'hello first', context: [{ line: 1, content: 'hello first' }] }],
      },
    ],
    ...overrides,
  };
}

describe('toScanParams（编排键折算收窄键）', () => {
  it('content 形态：max_matches 行级断 + collect_lines 携行', () => {
    expect(
      toScanParams({
        directory: 'D:/x',
        pattern: 'hello',
        maxResults: 100,
        contextLines: 2,
        outputMode: 'content',
      }),
    ).toEqual({
      directory: 'D:/x',
      pattern: 'hello',
      context_lines: 2,
      max_matches: 100,
      collect_lines: true,
    });
  });

  it('files/count 形态：max_files 文件级断 + 不携行', () => {
    const base = { directory: 'D:/x', pattern: 'hello' } as const;
    expect(toScanParams({ ...base, outputMode: 'files_with_matches', maxResults: 30 })).toEqual({
      directory: 'D:/x',
      pattern: 'hello',
      context_lines: 0,
      max_files: 30,
      collect_lines: false,
    });
    expect(toScanParams({ ...base, outputMode: 'count', maxResults: 30 })).toEqual({
      directory: 'D:/x',
      pattern: 'hello',
      context_lines: 0,
      max_files: 30,
      collect_lines: false,
    });
  });

  it('缺省与上限同退役前口内逻辑：max 50/上限 200；ctx 0/上限 10', () => {
    expect(toScanParams({ directory: 'D:/x', pattern: 'q' })).toEqual({
      directory: 'D:/x',
      pattern: 'q',
      context_lines: 0,
      max_matches: 50,
      collect_lines: true,
    });
    expect(toScanParams({ directory: 'D:/x', pattern: 'q', maxResults: 999, contextLines: 99 })).toEqual({
      directory: 'D:/x',
      pattern: 'q',
      context_lines: 10,
      max_matches: 200,
      collect_lines: true,
    });
  });
});

describe('assembleSearchOutput（三形态组装）', () => {
  it('content：键序 = 原 Rust 组装序；context_block 携 is_match 与行号', () => {
    const out = JSON.parse(
      assembleSearchOutput({ directory: 'D:/x', pattern: 'hello', contextLines: 1 }, scanOf()),
    ) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual([
      'pattern',
      'count',
      'truncated',
      'scanned_files',
      'budget_truncated',
      'context_lines',
      'results',
    ]);
    expect(out.count).toBe(3);
    expect(out.context_lines).toBe(1);
    const first = (out.results as Array<Record<string, unknown>>)[0];
    expect(first).toMatchObject({
      file: 'D:/x/src/b.ts',
      match_line: 3,
      match_content: 'hello world',
      context: 1,
    });
    expect(first.context_block).toEqual([
      { line: 2, content: 'x', is_match: false },
      { line: 3, content: 'hello world', is_match: true },
      { line: 4, content: 'y', is_match: false },
    ]);
  });

  it('content + showLineNumbers=false：context_block 行号 null，is_match 照判', () => {
    const out = JSON.parse(
      assembleSearchOutput({ directory: 'D:/x', pattern: 'hello', showLineNumbers: false }, scanOf()),
    ) as { results: Array<{ context_block: Array<{ line: number | null; is_match: boolean }> }> };
    const block = out.results[0].context_block;
    expect(block.length).toBe(3);
    expect(block.every((c) => c.line === null)).toBe(true);
    expect(block[1].is_match).toBe(true);
  });

  it('files_with_matches：文件名排序 + count + 分页截断位', () => {
    const out = JSON.parse(
      assembleSearchOutput(
        { directory: 'D:/x', pattern: 'hello', outputMode: 'files_with_matches', headLimit: 1 },
        scanOf(),
      ),
    ) as Record<string, unknown> & { files: string[] };
    expect(Object.keys(out)).toEqual(['pattern', 'count', 'truncated', 'scanned_files', 'budget_truncated', 'files']);
    expect(out.count).toBe(2);
    // 排序后 a.ts 在前；headLimit=1 只取一页，且 skip+head < total → truncated
    expect(out.files).toEqual(['D:/x/src/a.ts']);
    expect(out.truncated).toBe(true);
  });

  it('count：total_matches 求和 + 每文件计数降序', () => {
    const out = JSON.parse(
      assembleSearchOutput({ directory: 'D:/x', pattern: 'hello', outputMode: 'count' }, scanOf()),
    ) as Record<string, unknown> & { files: Array<{ file: string; matches: number }> };
    expect(Object.keys(out)).toEqual([
      'pattern',
      'total_matches',
      'file_count',
      'truncated',
      'scanned_files',
      'budget_truncated',
      'files',
    ]);
    expect(out.total_matches).toBe(3);
    expect(out.file_count).toBe(2);
    expect(out.files[0]).toEqual({ file: 'D:/x/src/b.ts', matches: 2 });
    expect(out.files[1]).toEqual({ file: 'D:/x/src/a.ts', matches: 1 });
  });

  it('content 分页：offset 跳过 + head 截取；head=0 不分页', () => {
    const page = JSON.parse(
      assembleSearchOutput({ directory: 'D:/x', pattern: 'hello', headLimit: 1, offset: 1 }, scanOf()),
    ) as { results: unknown[]; count: number; truncated: boolean };
    expect(page.results.length).toBe(1);
    expect(page.count).toBe(3);
    expect(page.truncated).toBe(true);
    const all = JSON.parse(assembleSearchOutput({ directory: 'D:/x', pattern: 'hello', headLimit: 0 }, scanOf())) as {
      results: unknown[];
      truncated: boolean;
    };
    expect(all.results.length).toBe(3);
    expect(all.truncated).toBe(false);
  });

  it('budget_truncated 透传截断位（扫描预算/文件级触顶）', () => {
    const out = JSON.parse(
      assembleSearchOutput(
        { directory: 'D:/x', pattern: 'hello', outputMode: 'count' },
        scanOf({ budget_truncated: true }),
      ),
    ) as { truncated: boolean; budget_truncated: boolean };
    expect(out.truncated).toBe(true);
    expect(out.budget_truncated).toBe(true);
  });

  it('向量召回 passthrough：尾键序 vector_hits → vector_backend', () => {
    const scan = scanOf({
      vector_hits: [{ node_id: 'n1', score: 87 }],
      vector_backend: 'static',
    });
    const out = JSON.parse(assembleSearchOutput({ directory: 'D:/x', pattern: 'hello' }, scan)) as Record<
      string,
      unknown
    >;
    const keys = Object.keys(out);
    expect(keys[keys.length - 2]).toBe('vector_hits');
    expect(keys[keys.length - 1]).toBe('vector_backend');
    expect(out.vector_hits).toEqual([{ node_id: 'n1', score: 87 }]);
    expect(out.vector_backend).toBe('static');
  });
});

describe('parseScanOutput', () => {
  it('解析原始命中集；非形状（files 缺失）响亮报错', () => {
    const scan = scanOf();
    expect(parseScanOutput(JSON.stringify(scan)).files.length).toBe(2);
    expect(() => parseScanOutput('{"ok":1}')).toThrow(/原始命中集/);
  });
});
