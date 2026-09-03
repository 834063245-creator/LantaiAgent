// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// kernel-plugin-runtime Phase 1：manifest 驱动工具面的守卫测试。
// ① 内置 search 工具与 manifest 真源对齐（schema 形状 + 只读性）；
// ② execute 走统一 tool_call 入口（plugin/tool 路由 + args 原样透传）；
// ③ schema 键序锚（convergence 字节契约的近端防线——顶层与 properties 首键）。

import { describe, expect, it } from 'vitest';
import type { Tool, ToolExecutor } from '../src/agent/tool';
import { createSearchTools, kernelManifestOf } from '../src/agent/tools/manifest-tools';

function captureExec(): { calls: Array<{ name: string; args: Record<string, unknown> }>; exec: ToolExecutor } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const exec: ToolExecutor = (name, args) => {
    calls.push({ name, args });
    return Promise.resolve('{"ok":1}');
  };
  return { calls, exec };
}

describe('kernel manifest tools', () => {
  it('createSearchTools 贡献 search_content，形状与 manifest 对齐', () => {
    const { exec } = captureExec();
    const tools: Tool[] = createSearchTools(exec);
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name()).toBe('search_content');
    expect(tool.readOnly()).toBe(true);
    const manifest = kernelManifestOf('builtin.search');
    const spec = manifest.tools.find((t) => t.name === 'search_content');
    expect(spec).toBeDefined();
    expect(tool.description()).toBe(spec!.description);
    expect(tool.parameters()).toEqual(spec!.schema);
    // manifest 契约锚：system 信任级 + filesystem_read 能力声明。
    expect(manifest.trust).toBe('system');
    expect(manifest.capabilities).toContain('filesystem_read');
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

  it('execute 走 tool_call：plugin/tool 路由 + args 原样透传（含 _agent_id meta）', async () => {
    const { calls, exec } = captureExec();
    const tool = createSearchTools(exec)[0];
    const args = {
      directory: 'D:/x',
      pattern: 'hello',
      _agent_id: 'sub-1',
    } as Record<string, unknown>;
    await tool.execute(args);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('tool_call');
    expect(calls[0].args.plugin).toBe('builtin.search');
    expect(calls[0].args.tool).toBe('search_content');
    // args 整体透传——meta key 不丢（INVARIANTS #9）。
    expect(calls[0].args.args).toEqual(args);
  });

  it('未知插件 id 响亮报错', () => {
    expect(() => kernelManifestOf('builtin.nope')).toThrow(/不在生成物清单内/);
  });
});
