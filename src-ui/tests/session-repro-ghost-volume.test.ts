// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 真机复现（2026-08-25 痞老板实测）：重启 → 首页点开旧卷 → 书脊出现
// 「旧卷 + 案卷 1」两条。本测试钉住该序列：冷启动装配（setAgent）→
// 续开旧卷（loadSessionFromDisk）→ 摊开集必须恰好一卷（旧卷本身）。
// 归零重建契约：setAgent 不铺卷；任何「案卷 1」伴随出现即红。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { ChatCore } from '../src/app/chat/chat-core';
import { useShellStore } from '../src/app/shell-store';
import * as Session from '../src/ui/chat-session';
import { msgStoreFor } from '../src/ui/chat-store';

const GLOBAL = '/.lantai/sessions';

describe('实机复现：冷启动装配后点开旧卷不得凭空多卷', () => {
  let panel: ChatCore;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(null);
    useShellStore.setState({ projectPath: '' });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('setAgent（冷启动装配）→ loadSessionFromDisk（点旧卷）→ 摊开集恰一卷', async () => {
    // 磁盘：全局位一卷旧卷（id 7，带 workspace 归属）
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method, params } = payload ?? {};
      if (method === 'read_file_content') {
        const fp = params.file_path as string;
        if (fp === `${GLOBAL}/7.json`) {
          return Promise.resolve(
            JSON.stringify({
              id: 7,
              label: '旧卷',
              savedAt: '2026-08-25T09:00:00.000Z',
              workspace: 'D:/real-ws',
              messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: '旧卷内容' },
              ],
            }),
          );
        }
        return Promise.reject(new Error('文件不存在'));
      }
      if (method === 'list_directory') return Promise.resolve(JSON.stringify([]));
      if (method === 'get_user_sessions_dir') return Promise.resolve(GLOBAL);
      return Promise.resolve(null);
    });

    // 冷启动：工作区装配（switchWorkspace → setupAgent → setAgent）
    panel = new ChatCore();
    panel.setProjectPath('D:/real-ws');
    panel.setAgent({
      getSession: () => [{ role: 'system', content: 'sys' }],
      setSession: vi.fn(),
      dispose: vi.fn(),
      cascadeAbort: vi.fn(),
    } as any);
    panel.setAgentFactory(async () => null); // 工厂在场（测试态）

    // 发号对账（冷启动序列的一环——不摊开）
    await panel.autoRestoreLastSession('D:/real-ws');
    expect(Session.getSessions(panel.panelId)).toHaveLength(0);

    // 用户动作：首页点开旧卷
    await panel.loadSessionFromDisk('D:/real-ws', 7);

    // 断言：摊开集恰好一卷 = 旧卷本身；「案卷 1」凭空出现即红
    const sessions = Session.getSessions(panel.panelId);
    expect(sessions.map((s) => s.id)).toEqual([7]);
    expect(sessions.some((s) => s.label === '案卷 1')).toBe(false);
    expect(
      msgStoreFor(panel.panelId, 7)
        .getState()
        .messages.some((m: any) => m.text === '旧卷内容'),
    ).toBe(true);
  });

  it('setAgent（冷启动装配）→ createNewSession（首页新建）→ 摊开集恰一卷', async () => {
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method } = payload;
      if (method === 'list_directory') return Promise.resolve(JSON.stringify([]));
      if (method === 'get_user_sessions_dir') return Promise.resolve(GLOBAL);
      if (method === 'write_file_content') return Promise.resolve('ok');
      return Promise.resolve(null);
    });

    panel = new ChatCore();
    panel.setProjectPath('D:/real-ws');
    panel.setAgent({
      getSession: () => [{ role: 'system', content: 'sys' }],
      setSession: vi.fn(),
      dispose: vi.fn(),
      cascadeAbort: vi.fn(),
    } as any);
    panel.setAgentFactory(async () => null);

    await panel.autoRestoreLastSession('D:/real-ws');
    expect(Session.getSessions(panel.panelId)).toHaveLength(0);

    // 用户动作：首页「新建案卷」
    await panel.createNewSession();

    const sessions = Session.getSessions(panel.panelId);
    expect(sessions).toHaveLength(1);
    // 新建的第一卷领预留句柄——不得伴随出现第二条「案卷 1」
    expect(sessions.filter((s) => s.label.startsWith('案卷')).length).toBe(1);
  });
});
