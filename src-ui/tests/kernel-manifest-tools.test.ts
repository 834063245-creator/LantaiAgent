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

function captureExec(): { calls: Array<{ name: string; args: Record<string, unknown> }>; exec: ToolExecutor } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const exec: ToolExecutor = (name, args) => {
    calls.push({ name, args });
    return Promise.resolve('{"ok":1}');
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

  it('execute 直呼能力口 search_cap + camelCase→snake_case 键映射（R2-a 键位断层修复）', async () => {
    const { calls, exec } = captureExec();
    const tool = createSearchTools(exec)[0];
    const args = {
      directory: 'D:/x',
      pattern: 'hello',
      fileTypes: '.ts',
      maxResults: 100,
      useRegex: true,
      contextLines: 2,
      outputMode: 'count',
      showLineNumbers: false,
      headLimit: 10,
      offset: 5,
      globFilter: 'src/**',
      _agent_id: 'sub-1',
    } as Record<string, unknown>;
    await tool.execute(args);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('search_cap');
    // schema 面 camelCase（模型可见契约零漂移）→ RPC 面 snake_case——
    // bridge.rpc() 顶层转换只作用于已 snake 的键（幂等），可选参数不再被吞。
    // 单字键（directory/pattern/offset）不经映射直通；meta _agent_id 保留下划线。
    expect(calls[0].args).toEqual({
      directory: 'D:/x',
      pattern: 'hello',
      file_types: '.ts',
      max_results: 100,
      use_regex: true,
      context_lines: 2,
      output_mode: 'count',
      show_line_numbers: false,
      head_limit: 10,
      offset: 5,
      glob_filter: 'src/**',
      _agent_id: 'sub-1',
    });
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
