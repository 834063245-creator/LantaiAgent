// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-flip 批 2 测试 → workspace-session-ownership-rework（2026-08-27）重写：
// 会话**物理归属工作区**——scanMaxSessionId 扫 `{projectPath}/.lantai/sessions`
// 单一存储位。零目录路由（ensureUserSessionsDir / '' 用户级目录兜底）已退役。

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

import { scanMaxSessionId } from '../src/ui/chat-session';

// rpc-contract 的 typedRpc 经 bridge.rpc 路由——mock 已覆盖。

describe('工作区会话根路由（workspace-session-ownership-rework）', () => {
  it('scanMaxSessionId(projectPath) 扫 {projectPath}/.lantai/sessions（单一路径）', async () => {
    mockInvoke.mockImplementation(async (_: string, req: any) => {
      if (req.method === 'list_directory') {
        // 钉路由：必须打到工作区会话根（不是旧全局位 / 用户级目录）
        expect(req.params.path).toBe('D:/proj/.lantai/sessions');
        return JSON.stringify([
          { name: '1.json', path: 'D:/proj/.lantai/sessions/1.json', is_dir: false, children: null },
          { name: '2.json', path: 'D:/proj/.lantai/sessions/2.json', is_dir: false, children: null },
        ]);
      }
      return '[]';
    });
    const max = await scanMaxSessionId('D:/proj');
    expect(max).toBe(2);
  });

  it('目录缺席 / 读失败 → 0（首启常态，不抛）', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('no dir'));
    const max = await scanMaxSessionId('D:/proj');
    expect(max).toBe(0);
  });
});
