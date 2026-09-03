// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// rpc Value 化第二步（2026-08-22）：消费面双形态契约守护。
// Rust 出口（rpc.rs rpc_result_shape 表）对 JsonValue 形态命令返回真结构化
// Value；Text 形态仍返字节精确 string。前端两个入口的形态语义在这里钉死：
//   typedJsonRpc —— 结构化透传 / 字符串 parse（浏览器 mock 与真机旧形态兼容）
//   agentInvoke  —— 结构化回卷 JSON 字符串（agent 工具链 string 世界零改动）

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();

vi.mock('../src/bridge', () => ({
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  invoke: vi.fn(),
  listen: vi.fn(),
}));

import { agentInvoke } from '../src/agent/tool';
import { parseJson, typedJsonRpc } from '../src/rpc-contract';

describe('rpc Value 化第二步：typedJsonRpc 双形态', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('结构化 Value（真机第二步形态）经 schema 校验返回', async () => {
    const shape = { available: true, degraded: false, reason: '' };
    mockRpc.mockResolvedValueOnce(shape);
    const out = await typedJsonRpc('sandbox_status', {});
    expect(out).toEqual(shape); // 校验规整后为新对象——同引用透传属性随边界校验层退役
    expect(mockRpc).toHaveBeenCalledWith('sandbox_status', {});
  });

  it('字符串（浏览器 mock / 表外 JSON 命令）走 parse 慢路径', async () => {
    // （原 shell_env 小样已随 builtin.shell 迁 tool_call 退役——P2-4；
    //  sandbox_status 接任慢路径小样，同走 rpcResultSchemas 表内校验）
    mockRpc.mockResolvedValueOnce('{"available":true,"degraded":false,"reason":"mock"}');
    const out = await typedJsonRpc('sandbox_status', {});
    expect(out).toEqual({ available: true, degraded: false, reason: 'mock' });
  });

  it('result 违形即 throw（错误不静默——错误信息带方法名）', async () => {
    mockRpc.mockResolvedValueOnce('{"degraded":"yes"}');
    await expect(typedJsonRpc('sandbox_status', {})).rejects.toThrow(/sandbox_status/);
  });

  it('parseJson 语义不变："null" → null', () => {
    expect(parseJson<null>('null')).toBeNull();
  });
});

describe('rpc Value 化第二步：agentInvoke 回卷 string', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('Rust 返回结构化 Value（agent_isolation_status 等）回卷 JSON 字符串', async () => {
    mockRpc.mockResolvedValueOnce({ isolations: [{ agent_id: 'a1', worktree_exists: true }], count: 1 });
    const raw = await agentInvoke<string>('agent_isolation_status', {});
    expect(typeof raw).toBe('string');
    const parsed = JSON.parse(raw) as { isolations: Array<{ agent_id: string }> };
    expect(parsed.isolations[0].agent_id).toBe('a1');
  });

  it('恒定注入 isAgent:true（camelCase → is_agent 契约）且字符串直通', async () => {
    mockRpc.mockResolvedValueOnce('plain text');
    const raw = await agentInvoke<string>('bash_output', { job_id: 3 });
    expect(raw).toBe('plain text');
    expect(mockRpc).toHaveBeenCalledWith('bash_output', { job_id: 3, isAgent: true });
  });

  it('结构化回卷后 agentIsolationDiff 消费链（spill.parseIsolationDiff）可用', async () => {
    // runtime.ts 的 JSON.parse(diffText) 在第二步后仍必须工作：
    // agentInvoke 回卷保证 diffText 恒为 string
    const shape = { has_changes: true, diff: 'diff --git a/x b/x', spill_path: undefined };
    mockRpc.mockResolvedValueOnce(shape);
    const diffText = await agentInvoke<string>('agent_isolation_diff', { agent_id: 'a1' });
    expect(JSON.parse(diffText)).toEqual(shape);
  });
});
