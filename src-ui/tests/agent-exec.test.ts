// 守护 camelCase IPC 契约: 前端发 isAgent ↔ Rust 参数 is_agent。
// 回归背景: 旧名 _agent 因 Tauri 默认 camelCase 重命名永远匹配不上 Rust is_agent，
// 导致 is_agent 恒为 false → agent 文件操作走 user-UI 路径被沙箱静默硬拒
// "outside project directory" 且不弹 Ask。谁把 isAgent 改回 _agent，这俩测试就挂。
// L1 数据上下文（2026-08-25）：agentInvoke 同时注入活跃会话 _session_id
// （Rust 决议链：会话 → 焦点 → 单槽）——下方 sessionScope 用例守护。
import { describe, expect, it, vi } from 'vitest';

// agentInvoke (tool.ts) 跨模块 import bridge.rpc → mock 这里拦截真实 Tauri 调用
const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

// tool.ts 模块加载时引用 bus 做事件接线
import { agentInvoke } from '../src/agent/tool';
import { sessionScopeStore } from '../src/state/session-scope';

describe('agentInvoke camelCase contract', () => {
  it('injects isAgent:true (not _agent) to match Rust is_agent param', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('ok');
    sessionScopeStore.getState().setCurrentSessionId(null);
    await agentInvoke('read_file_content', { filePath: 'C:/outside/x.txt' });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [name, payload] = mockRpc.mock.calls[0];
    expect(name).toBe('read_file_content');
    expect(payload).toEqual({ filePath: 'C:/outside/x.txt', isAgent: true });
    expect(payload).not.toHaveProperty('_agent');
  });

  it('passes arbitrary args through alongside isAgent', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue(0);
    sessionScopeStore.getState().setCurrentSessionId(null);
    await agentInvoke<number>('git_log', { path: 'D:/proj', count: 5 });
    const [, payload] = mockRpc.mock.calls[0];
    expect(payload).toEqual({ path: 'D:/proj', count: 5, isAgent: true });
  });
});

describe('agentInvoke session context (L1)', () => {
  it('injects active session id as _session_id for engine resolution', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('[]');
    sessionScopeStore.getState().setCurrentSessionId(42);
    try {
      await agentInvoke('hologram_call', { tool: 'symbols', args: {} });
      const [, payload] = mockRpc.mock.calls[0];
      expect(payload).toEqual({ tool: 'symbols', args: {}, isAgent: true, _session_id: 42 });
    } finally {
      sessionScopeStore.getState().setCurrentSessionId(null);
    }
  });

  it('omits _session_id when no active session; caller-provided id wins', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('ok');
    sessionScopeStore.getState().setCurrentSessionId(null);
    await agentInvoke('hologram_call', { tool: 'symbols' });
    let [, payload] = mockRpc.mock.calls[0];
    expect(payload).not.toHaveProperty('_session_id');

    // 显式归属（子 Agent）优先于活跃会话
    sessionScopeStore.getState().setCurrentSessionId(7);
    try {
      await agentInvoke('hologram_call', { tool: 'symbols', _session_id: 9 });
      [, payload] = mockRpc.mock.calls[1];
      expect(payload._session_id).toBe(9);
    } finally {
      sessionScopeStore.getState().setCurrentSessionId(null);
    }
  });
});
