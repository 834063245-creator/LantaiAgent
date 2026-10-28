// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// rpc Value 化第二步（2026-08-22）+ 形态单一化（2026-09-26）：消费面形态契约。
// Rust 出口（rpc.rs rpc_result_shape 表）对 JsonValue 形态命令返回真结构化
// Value；Text 形态仍返字节精确 string。前端两个入口的形态语义在这里钉死：
//   typedJsonRpc —— 只认结构化；字符串线形 = 出口分类错位，违形即 throw
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

describe('rpc 形态单一化：typedJsonRpc 只认结构化', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('结构化 Value（出口已展开）经 schema 校验返回', async () => {
    const shape = { available: true, degraded: false, reason: '' };
    mockRpc.mockResolvedValueOnce(shape);
    const out = await typedJsonRpc('sandbox_status', {});
    expect(out).toEqual(shape); // 校验规整后为新对象——同引用透传属性随边界校验层退役
    expect(mockRpc).toHaveBeenCalledWith('sandbox_status', {});
  });

  it('字符串线形（= 出口 rpc_result_shape 漏登记）→ throw，且错误点名该诊断', async () => {
    // 行为变更（2026-09-26）：旧版在这里走 `JSON.parse` 慢路径「照常工作」，
    // 于是一条出口分类错误可以静默潜伏（engine_bundled_info 假阳性 8 天）。
    // 现在字符串不给兜底——错误信息直接指到 rpc_result_shape()。
    mockRpc.mockResolvedValueOnce('{"available":true,"degraded":false,"reason":"mock"}');
    await expect(typedJsonRpc('sandbox_status', {})).rejects.toThrow(/rpc_result_shape/);
  });

  it('result 违形即 throw（错误不静默——错误信息带方法名）', async () => {
    mockRpc.mockResolvedValueOnce({ degraded: 'yes' });
    await expect(typedJsonRpc('sandbox_status', {})).rejects.toThrow(/sandbox_status/);
  });

  it('schema 期待标量的命令仍接受字符串线形（get_last_project 的 Option<String>）', async () => {
    mockRpc.mockResolvedValueOnce('D:/works/x');
    await expect(typedJsonRpc('get_last_project')).resolves.toBe('D:/works/x');
  });

  it('parseJson 语义不变："null" → null（Text 命令消费方自用）', () => {
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
