// defineTool 行为守护 — zod Schema-First 迁移的保障网。
// 覆盖: JSON Schema 输出形状 / 校验失败报错 / default+coerce / meta key 透传 / readOnly。
// 子 Agent 大批量迁移后, 这组测试保证工厂语义不漂移。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolExecutor } from '../src/agent/tool';
import { defineTool, toInputJsonSchema } from '../src/agent/tools/define-tool';
import { createGitTools } from '../src/plugins/builtin/git-domain/git-tools';
import { buildCodingTools } from './helpers/coding-tools';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

// 生产装配复现（平台化 Phase 2 · D11）：fs 工具 execute 经 ctx.fs 注册表解析
// provider——meta 透传用例需要 builtin/rust-fs 在册。
await ensureProductionChannelsBooted();

describe('toInputJsonSchema', () => {
  it('输出 JSON Schema 形状: properties + required, 无 $schema 元字段', () => {
    const s = z.object({ path: z.string().describe('repo root'), count: z.number().int().optional() });
    const out = toInputJsonSchema(s);
    expect(out).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'repo root' },
        count: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
      },
      required: ['path'],
    });
    expect(out).not.toHaveProperty('$schema');
  });

  it('io:input 视图 — defaulted 字段不进 required（避免"有 default 又 required"矛盾）', () => {
    const s = z.object({ count: z.number().optional().default(10) });
    const out = toInputJsonSchema(s);
    expect(out.required).toBeUndefined();
    expect((out.properties as any).count.default).toBe(10);
  });

  it('enum 输出 enum 数组', () => {
    const s = z.object({ mode: z.enum(['fork', 'fresh']) });
    const out = toInputJsonSchema(s);
    expect((out.properties as any).mode).toEqual({ type: 'string', enum: ['fork', 'fresh'] });
  });
});

describe('defineTool execute 行为', () => {
  const mkTool = () =>
    defineTool({
      name: 'demo',
      description: 'demo tool',
      schema: z.object({
        path: z.string().describe('path'),
        count: z.coerce.number().int().optional().default(10).describe('count'),
      }),
      execute: (args) => Promise.resolve(JSON.stringify({ path: args.path, count: args.count })),
    });

  it('default 注入 + coerce: 漏传 count → 10; 传 "5" → 5(number)', async () => {
    const t = mkTool();
    expect(await t.execute({ path: '/x' })).toBe(JSON.stringify({ path: '/x', count: 10 }));
    expect(await t.execute({ path: '/x', count: '5' })).toBe(JSON.stringify({ path: '/x', count: 5 }));
  });

  it('校验失败抛错: 缺 required 字段 → 带"参数校验失败"的错误', async () => {
    const t = mkTool();
    await expect(t.execute({})).rejects.toThrow(/参数校验失败/);
  });

  it('meta key 透传: _callId/_agent_id/_forceGate 不被 strip 掉', async () => {
    let seen: any = null;
    const t = defineTool({
      name: 'meta',
      description: 'meta test',
      schema: z.object({ path: z.string() }),
      execute: (args) => {
        seen = args;
        return Promise.resolve('ok');
      },
    });
    await t.execute({ path: '/x', _callId: 'c1', _agent_id: 'a1', _forceGate: true });
    expect(seen).toMatchObject({ path: '/x', _callId: 'c1', _agent_id: 'a1', _forceGate: true });
  });

  it('readOnly 默认 false, 显式 true 生效', () => {
    expect(defineTool({ name: 'a', description: 'a', schema: z.object({}), execute: async () => 'x' }).readOnly()).toBe(
      false,
    );
    expect(
      defineTool({
        name: 'b',
        description: 'b',
        schema: z.object({}),
        readOnly: true,
        execute: async () => 'x',
      }).readOnly(),
    ).toBe(true);
  });

  it('parameters() 输出稳定（WeakMap 缓存, 多次调用同一对象引用）', () => {
    const t = mkTool();
    expect(t.parameters()).toBe(t.parameters());
  });
});

describe('迁移样板: read_file_content / git_log', () => {
  const exec: ToolExecutor = async (name, args) => JSON.stringify({ name, args });
  const tools = buildCodingTools(exec);
  it('read_file_content 的 schema key 与转换后 Rust 参数一致', async () => {
    const t = tools.find((x) => x.name() === 'read_file_content')!;
    const params = t.parameters() as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(params.properties)).toEqual(['filePath', 'offset', 'limit', 'lineNumbers']);
    expect(params.required).toEqual(['filePath']);
    // R3-b 换轨：read 动作经 builtin/rust-fs → fs_cap（kernel-capability-
    // c3-design.md）；schema key 仍 camelCase（模型面零漂移），execute 出口
    // 映射 fs_cap snake（file_path/line_numbers——2026-09 工具缺陷报告 Bug 1
    // 拍板：缺省原文（line_numbers:false），lineNumbers opt-in）。
    const out = JSON.parse(await t.execute({ filePath: 'D:/a.ts', offset: 3 }));
    expect(out.name).toBe('fs_cap');
    expect(out.args).toEqual({
      action: 'read',
      file_path: 'D:/a.ts',
      line_numbers: false,
      offset: 3,
    });
  });

  it('git_log: 能力口直呼后 count 原样透传（默认/校验归 git_cap 口内）', async () => {
    // R3-c 换轨（kernel-capability-c3-design.md）：git 族 schema 自持 zod 真源
    // （default 仅 schema 发射面，无运行时 parse），execute 经 git_cap 直呼——
    // args 原样透传，count 缺省由 git_cap 口内 unwrap_or(10) 承接。git_log 的
    // 输出整形（parseGitLogCommits 消费 stdout）使返回值不再是 exec 原文——
    // 观察点从返回值换成 exec 调用记录。
    const calls: Array<[string, Record<string, unknown>]> = [];
    const logExec: ToolExecutor = async (name, args) => {
      calls.push([name, args]);
      return '';
    };
    const t = createGitTools(logExec).find((x) => x.name() === 'git_log')!;
    await t.execute({ path: 'D:/p' });
    await t.execute({ path: 'D:/p', count: '3' });
    expect(calls).toEqual([
      ['git_cap', { action: 'git_log', repo_path: 'D:/p' }],
      ['git_cap', { action: 'git_log', repo_path: 'D:/p', count: '3' }],
    ]);
  });
});
