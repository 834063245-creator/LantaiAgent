// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// kernel-plugin-runtime Phase 1：manifest 驱动工具面的守卫测试。
// ① search 工具与 zod 真源对齐（R2-d(1)：search_content schema 真源从
//    builtin.search manifest 镜像回迁 TS zod——本测试对拍 zod 发射的 JSON
//    Schema 与退役前 manifest.json 的字节形状，零漂移守卫）；
// ② execute 直呼 search_cap 能力口（camelCase→snake_case 键映射——R2-a
//    键位断层修复的钉测）；
// ③ schema 键序锚（convergence 字节契约的近端防线——顶层与 properties 首键）。
// web 域仍取 manifest 镜像（builtin.web 未退役，Phase 1 续批存量）。

import { describe, expect, it } from 'vitest';
import type { Tool, ToolExecutor } from '../src/agent/tool';
import { createSearchTools, createWebTools, kernelManifestOf } from '../src/agent/tools/manifest-tools';

function captureExec(reply = '{"ok":1}'): {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  exec: ToolExecutor;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const exec: ToolExecutor = (name, args) => {
    calls.push({ name, args });
    return Promise.resolve(reply);
  };
  return { calls, exec };
}

describe('kernel manifest tools — search 域（R2-d(1) zod 真源）', () => {
  it('createSearchTools 贡献 search_content，schema 与退役前 manifest 字节形状等价', () => {
    const { exec } = captureExec();
    const tools: Tool[] = createSearchTools(exec);
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name()).toBe('search_content');
    expect(tool.readOnly()).toBe(true);
    expect(tool.description()).toBe(
      'Search for a text pattern across all source files. Supports literal substring (default, case-insensitive) and regex. Returns matching lines with optional context lines, file lists, or counts. Skips binary files, hidden dirs, and build artifacts. Prefer this over run_shell grep — it is faster and respects .gitignore-style exclusions.',
    );
    // zod 真源发射的 JSON Schema（等价退役前 builtin.search manifest schema）。
    // 键名 camelCase、default、int 下界 -9007199254740991、enum、required、
    // additionalProperties 空对象全对齐——R2 采用「manifest 字节 → zod 逐字节
    // 转录 + 工具面行为零漂移」（R2 设计 §1.3），探针实测仅 optional-string
    // 的 description/type 值内键序有差，对象深度相等断言不受键序影响。
    const schema = tool.parameters() as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['directory', 'pattern']);
    expect(schema.additionalProperties).toEqual({});
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toEqual([
      'directory',
      'pattern',
      'fileTypes',
      'maxResults',
      'useRegex',
      'contextLines',
      'outputMode',
      'showLineNumbers',
      'headLimit',
      'offset',
      'globFilter',
    ]);
    expect(props.maxResults).toEqual({
      default: 50,
      description: 'Maximum number of results to return (default: 50, max: 200)',
      type: 'integer',
      minimum: -9007199254740991,
      maximum: 200,
    });
    expect(props.outputMode).toEqual({
      default: 'content',
      description:
        'Output mode: "content" = matching lines with context, "files_with_matches" = just file paths, "count" = match counts per file. Default: content.',
      type: 'string',
      enum: ['content', 'files_with_matches', 'count'],
    });
    expect(props.contextLines).toEqual({
      default: 0,
      description: 'Number of context lines before and after each match (like grep -C). Default: 0. Max: 10.',
      type: 'integer',
      minimum: -9007199254740991,
      maximum: 9007199254740991,
    });
  });

  it('schema 键序锚：顶层 type→properties→required→additionalProperties，properties 首键 directory', () => {
    const { exec } = captureExec();
    const tool = createSearchTools(exec)[0];
    const schema = tool.parameters() as Record<string, unknown>;
    expect(Object.keys(schema)).toEqual(['type', 'properties', 'required', 'additionalProperties']);
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)[0]).toBe('directory');
    // zod 发射特征：defaulted 数值字段带 minimum: -9007199254740991（zod int 无下界时的发射产物）。
    expect((props.maxResults as Record<string, unknown>).minimum).toBe(-9007199254740991);
  });

  it('execute 直呼能力口 search_cap：编排键折算收窄键 + 原始命中集组装（R2-d(2)）', async () => {
    const raw = JSON.stringify({
      pattern: 'hello',
      scanned_files: 12,
      budget_truncated: false,
      files: [
        {
          file: 'D:/x/src/a.ts',
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
      ],
    });
    const { calls, exec } = captureExec(raw);
    const tool = createSearchTools(exec)[0];
    const args = {
      directory: 'D:/x',
      pattern: 'hello',
      fileTypes: '.ts',
      maxResults: 100,
      useRegex: true,
      contextLines: 2,
      outputMode: 'content',
      showLineNumbers: true,
      headLimit: 10,
      offset: 0,
      globFilter: 'src/**',
      _agent_id: 'sub-1',
    } as Record<string, unknown>;
    const out = JSON.parse(await tool.execute(args)) as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('search_cap');
    // schema 面 camelCase（模型可见契约零漂移）→ RPC 面 snake_case——
    // R2-d(2)：编排键（outputMode/showLineNumbers/headLimit/offset）不下沉
    // 能力口，由 toScanParams 折算为收窄键（content → max_matches 行级断 +
    // collect_lines 携行）；meta _agent_id 保留下划线。
    expect(calls[0].args).toEqual({
      directory: 'D:/x',
      pattern: 'hello',
      context_lines: 2,
      file_types: '.ts',
      use_regex: true,
      glob_filter: 'src/**',
      max_matches: 100,
      collect_lines: true,
      _agent_id: 'sub-1',
    });
    // 组装层（search-assembly.ts）：原始命中集 → content 形态，
    // 键序 = R2-d(2) 前 Rust 组装分支的 serde_json 构造序。
    expect(Object.keys(out)).toEqual([
      'pattern',
      'count',
      'truncated',
      'scanned_files',
      'budget_truncated',
      'context_lines',
      'results',
    ]);
    expect(out.count).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.scanned_files).toBe(12);
    expect(out.context_lines).toBe(2);
    const results = out.results as Array<Record<string, unknown>>;
    expect(results.length).toBe(2);
    const first = results[0] as {
      file: string;
      match_line: number;
      match_content: string;
      context: number;
      context_block: Array<{ line: number | null; content: string; is_match: boolean }>;
    };
    expect(first.file).toBe('D:/x/src/a.ts');
    expect(first.match_line).toBe(3);
    expect(first.match_content).toBe('hello world');
    expect(first.context).toBe(2);
    expect(first.context_block).toEqual([
      { line: 2, content: 'x', is_match: false },
      { line: 3, content: 'hello world', is_match: true },
      { line: 4, content: 'y', is_match: false },
    ]);
  });
});

describe('kernel manifest tools — web 域（builtin.web，Phase 1 续批）', () => {
  it('createWebTools 贡献 web_search/web_fetch，形状与 manifest 对齐', () => {
    const { exec } = captureExec();
    const tools: Tool[] = createWebTools(exec);
    expect(tools.map((t) => t.name())).toEqual(['web_search', 'web_fetch']);
    const manifest = kernelManifestOf('builtin.web');
    expect(manifest.trust).toBe('system');
    expect(manifest.capabilities).toContain('network');
    for (const tool of tools) {
      const spec = manifest.tools.find((t) => t.name === tool.name());
      expect(spec).toBeDefined();
      expect(tool.description()).toBe(spec!.description);
      expect(tool.parameters()).toEqual(spec!.schema);
      expect(tool.readOnly()).toBe(true);
    }
  });

  it('web_search schema 键序锚：maxResults 并入转录（zod 发射序）', () => {
    const { exec } = captureExec();
    const search = createWebTools(exec)[0];
    const schema = search.parameters() as Record<string, unknown>;
    expect(Object.keys(schema)).toEqual(['type', 'properties', 'required', 'additionalProperties']);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toEqual(['query', 'maxResults']);
    expect(props.maxResults).toEqual({
      default: 10,
      description: 'Number of results to return (default 10, max 10)',
      type: 'integer',
      minimum: 1,
      maximum: 10,
    });
    expect(schema.required).toEqual(['query']);
  });

  it('web_fetch execute 走 tool_call：args 原样透传（含 _agent_id meta）', async () => {
    const { calls, exec } = captureExec();
    const fetch = createWebTools(exec)[1];
    const args = { url: 'https://example.com', _agent_id: 'sub-2' } as Record<string, unknown>;
    await fetch.execute(args);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('tool_call');
    expect(calls[0].args.plugin).toBe('builtin.web');
    expect(calls[0].args.tool).toBe('web_fetch');
    expect(calls[0].args.args).toEqual(args);
  });

  it('未知插件 id 响亮报错', () => {
    expect(() => kernelManifestOf('builtin.nope')).toThrow(/不在生成物清单内/);
  });
});
