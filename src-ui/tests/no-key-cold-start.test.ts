// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 「配置 provider 后恒提示『当前没有活跃会话』」死路的端到端形态守护
// （Phase B/C，2026-08-24 工作区归属根治）。钉住 DSH 形态的核心契约：
//   ① 无 Key 冷启动 → 历史案卷从磁盘照常恢复显示（恢复不依赖工厂/装配）
//   ② 缺 Key 的表现 = 明确的可见提示（拟文时补建失败 warn），不是会话消失
//   ③ 配置 Key 后（工厂可用）→ 不重启，同一面板直接发送成功
// （真实链路：无 Key 冷启动 → setupPlaceholderAgent → autoRestoreLastSession('')；
//  本测试在 chat-session 层复现该契约——工厂形态由 stub 模拟「无 Key 返 null」
//  与「配 Key 后可用」两个阶段。）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellStore } from '../src/app/shell-store';

const mockInvoke = vi.fn();
async function mockRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const snakeKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
      normalized[snakeKey] = value;
    }
  }
  return mockInvoke('rpc', { method, params: normalized });
}
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/app-shell', () => ({
  shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() },
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'test', apiKey: 'k', baseUrl: '', model: 'm', kind: 'openai' })),
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
  restoreSecrets: vi.fn((s: unknown) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => {
  // biome-ignore lint/suspicious/noThenProperty: GSAP tween 接口形状（thenable mock）
  const createNoopTween = () => ({ kill: () => {}, then: () => {}, play: () => {}, pause: () => {} });
  const gsap = {
    set: vi.fn(),
    to: vi.fn(createNoopTween),
    from: vi.fn(createNoopTween),
    fromTo: vi.fn(createNoopTween),
  };
  return { default: gsap, gsap };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { ChatCore } from '../src/app/chat/chat-core';
import * as Session from '../src/ui/chat-session';
import { hashProjectPath } from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

const USER_DIR = '/home/.lantai/sessions';

/** 磁盘卷 7（零目录会话，用户级目录）。 */
function volumeJson(): string {
  return JSON.stringify({
    id: 7,
    label: '零目录历史卷',
    savedAt: new Date().toISOString(),
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '之前的问题' },
      { role: 'assistant', content: '之前的回答' },
    ],
    tokensUsed: 42,
  });
}

/** 零目录磁盘 mock：用户级目录有 7.json（U4/Q1-B：恢复 = 扫描推导，不再读
 *  总目/tracker——list_directory 路由卷清单）。 */
function mockZeroDirDisk(): void {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((_cmd: string, payload: { method: string; params: Record<string, unknown> }) => {
    const { method, params } = payload;
    if (method === 'get_user_sessions_dir') return Promise.resolve(USER_DIR);
    if (method === 'list_directory') {
      const p = params.path as string;
      if (p === USER_DIR) {
        return Promise.resolve(
          JSON.stringify([{ name: '7.json', path: `${USER_DIR}/7.json`, is_dir: false, children: null }]),
        );
      }
      return Promise.resolve(JSON.stringify([]));
    }
    if (method === 'read_file_content') {
      const fp = params.file_path as string;
      if (fp === `${USER_DIR}/7.json`) return Promise.resolve(volumeJson());
      return Promise.reject(new Error('文件不存在'));
    }
    return Promise.resolve(null);
  });
}

async function drain(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  localStorage.clear();
  useShellStore.setState({ projectPath: '' });
});

describe('无 Key 冷启动 → 会话恢复 → 配 Key 不重启可发（死路形态守护）', () => {
  it('恢复不依赖工厂：工厂返 null（无 Key）时零目录历史卷照常显示', async () => {
    // 用户级目录的 localStorage 备份（磁盘 7.json 背书——mockZeroDirDisk 提供）
    const lsKey = `hologram_session_${hashProjectPath('').toString(36)}_7`;
    localStorage.setItem(
      lsKey,
      JSON.stringify({ id: 7, savedAt: '2026-08-24T10:00:00Z', messages: [{ role: 'user', content: '之前的问题' }] }),
    );
    mockZeroDirDisk();

    const panel = new ChatCore();
    // 无 Key 阶段的工厂（Phase B 契约：工厂在场但返 null——恢复不经工厂）
    panel.setAgentFactory(async () => null);
    // 零目录会话目录解析（真实链路由 setupPlaceholderAgent 调用；测试直调）
    await Session.ensureUserSessionsDir();

    await panel.autoRestoreLastSession('');

    // ① 历史案卷照常恢复显示（会话存在性 ≠ Agent 装配）
    const sess = Session.getSessions(panel.panelId);
    expect(sess).toHaveLength(1);
    expect(sess[0].id).toBe(7);
    const msgs = msgStoreFor(panel.panelId, 7).getState().messages;
    expect(msgs.some((m) => m.role === 'user' && m.text === '之前的问题')).toBe(true);

    // ② 缺 Key 的表现 = 可见提示（后台补建失败的 warn），不是会话消失
    await drain();
    const notices = msgStoreFor(panel.panelId, 7)
      .getState()
      .messages.filter((m) => m.role === 'notice');
    expect(notices.some((n) => String((n as { text?: string }).text).includes('卷的 Agent 未就绪'))).toBe(true);
  });

  it('配 Key 后不重启：同一面板直接发送成功（句柄拟文时补建）', async () => {
    const lsKey = `hologram_session_${hashProjectPath('').toString(36)}_7`;
    localStorage.setItem(
      lsKey,
      JSON.stringify({ id: 7, savedAt: '2026-08-24T10:00:00Z', messages: [{ role: 'user', content: '之前的问题' }] }),
    );
    mockZeroDirDisk();

    const panel = new ChatCore();
    panel.setAgentFactory(async () => null); // 无 Key 冷启动阶段
    await Session.ensureUserSessionsDir();
    await panel.autoRestoreLastSession('');
    await drain(); // 排干补建失败 warn

    // 用户在设置中配置 Key 保存（不重启）：工厂从「返 null」变为可用
    const run = vi.fn(async () => undefined);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
          run,
          nextInsertIndex: 1,
          setUiSessionId: vi.fn(),
          insertMessage: vi.fn(),
          cascadeAbort: vi.fn(),
        }) as never,
    );

    getChatStore(panel.panelId).input.getState().setInputText('新问题');
    await panel.sendMessage();
    await drain();

    // ③ 直接发送成功：Agent.run 被驱动，无「Agent 未就绪」错误拦截
    expect(run).toHaveBeenCalledTimes(1);
    const notices = msgStoreFor(panel.panelId, 7)
      .getState()
      .messages.filter((m) => m.role === 'notice');
    expect(notices.some((n) => String((n as { text?: string }).text).startsWith('Agent 未就绪 —'))).toBe(false);
  });
});
