// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 跨工作区串卷·根因一（2026-09-02 用户实机）：进 B 工作区，画布出现 A 区的卷。
// 摊开链路：侧边栏/签条架点卷 → space-service.expand → loadSessionFromDisk 是
// fire-and-forget（新建同理，工厂装配在途）。读盘/工厂在途期间用户切走工作区
// （deactivate bump 代际 → setupAgent.resetSessionState 清表）→ 迟到的 append
// 落在清表之后，旧区卷混进新工作区 sess store——PaperPanel「新会话默认落位」
// 还会立即给它 ensureRegion，写进新工作区 canvas.json（持久污染）。
// 守卫契约：任何跨 await 的 sess append 必须代际校验后落笔（对齐 scheduleAutoSave
// 的 H5 防护面）。任何「旧区卷出现在新工作区」即红。

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
import { bumpWorkspaceEpoch } from '../src/workspace-scope';

/** 模拟切换工作区的会话面清理（switchWorkspace 真序列：deactivate 先 bump
 *  代际 → setupAgent 尾部 resetSessionState 清表 → setProjectPath 换区）。 */
async function switchAwayFrom(panel: ChatCore, to: string): Promise<void> {
  bumpWorkspaceEpoch();
  Session.resetSessionState(panel.panelId);
  panel.setProjectPath(to);
}

describe('跨工作区串卷：在途摊开/建卷的迟到 append 必须被代际拦截', () => {
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

  it('摊开读盘在途 → 切工作区 → 迟到的旧区卷不得进新工作区 sess store', async () => {
    let releaseRead!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      releaseRead = r;
    });
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method, params } = payload ?? {};
      if (method === 'read_file_content' && params?.file_path === 'D:/wsA/.lantai/sessions/7.json') return gate;
      if (method === 'list_directory') return Promise.resolve(JSON.stringify([]));
      return Promise.resolve(null);
    });

    panel = new ChatCore();
    panel.setProjectPath('D:/wsA');
    panel.setAgentFactory(async () => null);

    // 用户点侧边栏摊开（space-service.expand 的 fire-and-forget 同款路径）
    const pending = panel.loadSessionFromDisk('D:/wsA', 7);

    // 读盘在途时用户切走工作区（代际已推进 + 会话面已清）
    await switchAwayFrom(panel, 'D:/wsB');

    // 旧区卷文件此刻才读完
    releaseRead(
      JSON.stringify({
        id: 7,
        label: 'A 区旧卷',
        savedAt: '2026-09-01T00:00:00.000Z',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'A 区内容' },
        ],
      }),
    );
    await pending;

    // 断言：A 区的卷不得混进新工作区
    expect(Session.getSessions(panel.panelId)).toEqual([]);
  });

  it('新建卷工厂在途 → 切工作区 → 迟到的新卷不得进新工作区 sess store', async () => {
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method } = payload ?? {};
      if (method === 'list_directory') return Promise.resolve(JSON.stringify([]));
      if (method === 'write_file_content') return Promise.resolve('ok');
      return Promise.resolve(null);
    });

    panel = new ChatCore();
    panel.setProjectPath('D:/wsA');

    let releaseFactory!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFactory = r;
    });
    panel.setAgentFactory(async () => {
      await gate;
      return null;
    });

    // 用户点新建（工厂装配在途）
    const pending = panel.createNewSession();

    // 工厂在途时用户切走工作区
    await switchAwayFrom(panel, 'D:/wsB');
    releaseFactory();
    await pending;

    // 断言：A 区的新建卷不得混进新工作区
    expect(Session.getSessions(panel.panelId)).toEqual([]);
  });
});
