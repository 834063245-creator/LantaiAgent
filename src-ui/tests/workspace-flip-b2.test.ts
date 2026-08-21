// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-flip 批 2 测试 — 零目录会话路由（sessionsDir('') → 用户级目录）。
// 冻结文件 chat-session.ts 的外科手术面：ensureUserSessionsDir 缓存 + '' 路由 + 持久化往返。

import { describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
async function mockRpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      normalized[key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())] = value;
    }
  }
  return mockInvoke('rpc', { method, params: normalized });
}
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { _resetUserSessionsDirForTests, ensureUserSessionsDir, scanMaxSessionId } from '../src/ui/chat-session';

// rpc-contract 的 typedRpc 经 bridge.rpc 路由——mock 已覆盖。

describe('workspace-flip 批 2：零目录会话路由', () => {
  it('ensureUserSessionsDir：解析一次并缓存（幂等）', async () => {
    _resetUserSessionsDirForTests();
    mockInvoke.mockImplementation(async (_: string, req: any) => {
      if (req.method === 'get_user_sessions_dir') return 'C:/Users/test/.hologram/sessions';
      return '[]';
    });
    await ensureUserSessionsDir();
    await ensureUserSessionsDir(); // 幂等
    const dirCalls = mockInvoke.mock.calls.filter(([, r]: any[]) => r.method === 'get_user_sessions_dir');
    expect(dirCalls.length).toBe(1);
  });

  it('RPC 失败兜底：显式旧路径（不静默改道）', async () => {
    _resetUserSessionsDirForTests();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInvoke.mockRejectedValueOnce(new Error('no backend'));
    await ensureUserSessionsDir();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('get_user_sessions_dir 解析失败'), expect.anything());
    errSpy.mockRestore();
  });

  it("scanMaxSessionId('')：list_directory 打到用户级目录（路由生效）", async () => {
    _resetUserSessionsDirForTests();
    mockInvoke.mockImplementation(async (_: string, req: any) => {
      if (req.method === 'get_user_sessions_dir') return 'C:/U/.hologram/sessions';
      if (req.method === 'list_directory') {
        // 钉路由：path 必须是用户级目录（不是 '/.hologram/sessions' 旧兜底）
        expect(req.params.path).toBe('C:/U/.hologram/sessions');
        return JSON.stringify([
          { name: '1.json', path: 'x', is_dir: false },
          { name: '2.json', path: 'y', is_dir: false },
        ]);
      }
      return '[]';
    });
    await ensureUserSessionsDir();
    const max = await scanMaxSessionId('');
    expect(max).toBe(2);
  });

  it("未 ensure 时 sessionsDir('') 走旧兜底（与批 1 行为一致——不静默改道）", async () => {
    _resetUserSessionsDirForTests();
    mockInvoke.mockImplementation(async (_: string, req: any) => {
      if (req.method === 'list_directory') {
        expect(req.params.path).toBe('/.hologram/sessions'); // 旧兜底路径
        return '[]';
      }
      return '[]';
    });
    const max = await scanMaxSessionId('');
    expect(max).toBe(0);
  });
});
