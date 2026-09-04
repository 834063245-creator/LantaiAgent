// 守护「schema key ↔ execute key ↔ Rust 参数名」三处契约。
// 回归背景: rename_file 的 schema key 是 new_name(snake)，execute 手打包成 newName，
// 依赖 rpc()（bridge.ts:84）的 camelCase→snake_case 转换才能命中 Rust 的 new_name 参数。
// bridge.ts:84 的正则是整个工具层唯一生效的转换枢纽 —— 谁改了转换规则、
// 谁"顺手统一"了 rename_file 的手打包、谁新增了风格混乱/歧义的 schema key，这组测试就挂。
// 对标 agent-exec.test.ts 的 isAgent 守护（旧名 _agent 事故前车之鉴）。
import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutor } from '../src/agent/tool';
import { createCodingTools } from '../src/agent/tool';

// bridge 保持完全真实（测的就是 rpc 转换 + 浏览器模式路由）。
// 浏览器模式（jsdom 无 __TAURI_INTERNALS__）下 bridge.invoke 走 mock-data.mockInvoke，
// 在这里把它替换成探针，从调用参数断言转换结果。
const mockInvoke = vi.fn();
vi.mock('../src/mock-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mock-data')>();
  return { ...actual, mockInvoke: (...args: any[]) => mockInvoke(...args) };
});

import { agentInvoke } from '../src/agent/tool';
// tool.ts 模块加载时引用 bus 做事件接线
import { rpc } from '../src/bridge';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

// 生产装配复现（平台化 Phase 2 · D11）：fs 工具 execute 经 ctx.fs 注册表解析
// provider——rename 三处契约端到端用例需要 builtin/rust-fs 在册。
await ensureProductionChannelsBooted();

/** 走真实 rpc()，从 mock 探针参数里取出转换后的 snake_case params */
async function toSnake(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  mockInvoke.mockReset();
  await rpc('test_cmd', params);
  const [, payload] = mockInvoke.mock.calls[0];
  return payload.params as Record<string, unknown>;
}

describe('rpc() camelCase→snake_case 转换枢纽', () => {
  // 已知的 schema key → Rust 参数名契约（调研透传清单）。
  // 这些 key 一旦转换错，对应工具静默拿不到参数 → 行为错误且无报错。
  const KNOWN: Array<[string, string]> = [
    ['filePath', 'file_path'],
    ['oldString', 'old_string'],
    ['newString', 'new_string'],
    ['replaceAll', 'replace_all'],
    ['projectPath', 'project_path'],
    ['timeoutMs', 'timeout_ms'],
    ['runInBackground', 'run_in_background'],
    ['jobId', 'job_id'],
    ['maxResults', 'max_results'],
    ['useRegex', 'use_regex'],
    ['contextLines', 'context_lines'],
    ['outputMode', 'output_mode'],
    ['showLineNumbers', 'show_line_numbers'],
    ['headLimit', 'head_limit'],
    ['globFilter', 'glob_filter'],
    ['traceId', 'trace_id'],
    ['isAgent', 'is_agent'],
    ['newName', 'new_name'], // rename_file execute 手打包的中间 key
  ];

  it.each(KNOWN)('converts %s → %s', async (camel, snake) => {
    const out = await toSnake({ [camel]: 'x' });
    expect(out).toEqual({ [snake]: 'x' });
  });

  it('缩写不被拆坏（URI → uri，不是 u_r_i）', async () => {
    const out = await toSnake({ uri: 'x', apiKey: 'y' });
    expect(out).toEqual({ uri: 'x', api_key: 'y' });
  });

  it('已是 snake_case 的 key 保持不变', async () => {
    const out = await toSnake({ agent_id: 'a', new_name: 'b', message_id: 'c' });
    expect(out).toEqual({ agent_id: 'a', new_name: 'b', message_id: 'c' });
  });

  it('元参数 _forceGate/_callId/_agent_id 转换后仍以下划线开头', async () => {
    const out = await toSnake({ _forceGate: true, _callId: 'x', _agent_id: 'y' });
    expect(out).toEqual({ _force_gate: true, _call_id: 'x', _agent_id: 'y' });
  });
});

describe('全量工具 schema key 契约', () => {
  const exec: ToolExecutor = async () => '';
  const tools = createCodingTools(exec);

  it('schema key 无混合风格（大写与下划线不共存；元参数 _ 开头除外）', () => {
    const problems: string[] = [];
    for (const t of tools) {
      const props = (t.parameters() as any).properties ?? {};
      for (const key of Object.keys(props)) {
        if (key.startsWith('_')) continue; // 元参数（_forceGate/_callId）
        const hasUpper = /[A-Z]/.test(key);
        const hasSnake = key.includes('_');
        if (hasUpper && hasSnake) {
          problems.push(
            `工具 ${t.name()}: schema key "${key}" 混合了 camelCase 与 snake_case — 改 key 时要么全 camelCase（走 rpc 转换）、要么全 snake（直传 Rust）`,
          );
        }
      }
    }
    if (problems.length) expect.fail(problems.join('\n'));
  });

  it('schema key 经 rpc 转换后无歧义（两个不同 key 不转成同一 snake）', () => {
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const t of tools) {
      const props = (t.parameters() as any).properties ?? {};
      for (const key of Object.keys(props)) {
        if (key.startsWith('_')) continue;
        const snake = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
        if (seen.has(snake) && seen.get(snake) !== key) {
          conflicts.push(`工具 ${t.name()}: "${seen.get(snake)}" 与 "${key}" 都转成 "${snake}" — Rust 端无法区分`);
        }
        seen.set(snake, key);
      }
    }
    expect(conflicts).toEqual([]);
  });
});

describe('rename_file 三处契约端到端', () => {
  it('schema new_name → 工具层折写 filePath/newName → fs_cap rename 直呼（R3-b 换轨）', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue('ok');
    const exec: ToolExecutor = (name, args) => agentInvoke(name, args);
    const tools = createCodingTools(exec);
    const tool = tools.find((t) => t.name() === 'rename_file');
    expect(tool).toBeTruthy();
    await tool!.execute({ path: 'D:/a', new_name: 'b' });
    const [cmd, payload] = mockInvoke.mock.calls[0];
    expect(cmd).toBe('rpc');
    // R3-b 换轨（kernel-capability-c3-design.md）：模型键 path/new_name 经
    // 工具层折写 filePath/newName（coding.ts）→ builtinFsProvider 映射为
    // fs_cap rename {from,to}（模型面 camelCase → 能力口 snake 顶层；meta
    // is_agent 由 agentInvoke 注入，与 search_cap 直呼同构）。
    expect(payload).toEqual({
      method: 'fs_cap',
      params: {
        action: 'rename',
        from: 'D:/a',
        to: 'b',
        is_agent: true,
      },
    });
  });
});
