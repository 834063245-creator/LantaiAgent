// 守护 camelCase IPC 契约: 前端发 isAgent ↔ Rust 参数 is_agent。
// 回归背景: 旧名 _agent 因 Tauri 默认 camelCase 重命名永远匹配不上 Rust is_agent，
// 导致 is_agent 恒为 false → agent 文件操作走 user-UI 路径被沙箱静默硬拒
// "outside project directory" 且不弹 Ask。谁把 isAgent 改回 _agent，这俩测试就挂。
// workspace-session-ownership-rework（2026-08-27）：agentInvoke 不再注入
// _session_id——引擎决议只跟活动工作区（单槽 WorkspaceState）走，会话 id 不参与
// 引擎路由；调用方显式传 _session_id 仅原样透传（下方用例守护）。
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

describe('agentInvoke camelCase contract', () => {
  it('injects isAgent:true (not _agent) to match Rust is_agent param', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('ok');
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
    await agentInvoke<number>('git_log', { path: 'D:/proj', count: 5 });
    const [, payload] = mockRpc.mock.calls[0];
    expect(payload).toEqual({ path: 'D:/proj', count: 5, isAgent: true });
  });
});

describe('agentInvoke 引擎决议不再注入 _session_id（workspace-session-ownership-rework）', () => {
  it('不注入 _session_id——引擎决议只跟活动工作区走', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('[]');
    await agentInvoke('hologram_call', { tool: 'symbols', args: {} });
    const [, payload] = mockRpc.mock.calls[0];
    expect(payload).toEqual({ tool: 'symbols', args: {}, isAgent: true });
    expect(payload).not.toHaveProperty('_session_id');
  });

  it('调用方显式传 _session_id 时原样透传（纯透传，不参与决议）', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('ok');
    await agentInvoke('hologram_call', { tool: 'symbols', _session_id: 9 });
    const [, payload] = mockRpc.mock.calls[0];
    expect(payload._session_id).toBe(9);
  });
});
