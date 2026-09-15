// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 真机复现（2026-08-25 痞老板实测）：重启 → 首页点开旧卷 → 书脊出现
// 「旧卷 + 案卷 1」两条。本测试钉住该序列：冷启动装配（setAgent）→
// 续开旧卷（loadSessionFromDisk）→ 摊开集必须恰好一卷（旧卷本身）。
// 归零重建契约：setAgent 不铺卷；任何「案卷 1」伴随出现即红。

// fs 域收口（2026-09-04）：会话卷 I/O 经 kernelListDirectory/kernelReadFileRaw/
// kernelWriteFile（rpc-contract 具名 helper，内部直呼 fs_cap）——mock 站到
// helper 层（不再拦 bridge + legacyDispatchShim 翻信封）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logText } from './helpers/session-files';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { ChatCore } from '../src/app/chat/chat-core';
import { useShellStore } from '../src/app/shell-store';
import * as Session from '../src/ui/chat-session';
import { msgStoreFor } from '../src/ui/chat-store';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

// 会话持久化 seam 装配（seam 接线 C 批 3）：卷 CRUD 已换轨 sessionExecute——
// builtin provider 需在册（走 kernel-fs mock 内存盘）。
await ensureProductionChannelsBooted();

describe('实机复现：冷启动装配后点开旧卷不得凭空多卷', () => {
  let panel: ChatCore;

  beforeEach(() => {
    localStorage.clear();
    useShellStore.setState({ projectPath: '' });
    H.kernelFs!.fs.files.clear();
    H.kernelFs!.fs.dirs.clear();
    H.kernelFs!.fs.writes.length = 0;
    H.kernelFs!.fs.fail = {};
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('setAgent（冷启动装配）→ loadSessionFromDisk（点旧卷）→ 摊开集恰一卷', async () => {
    // 磁盘：本工作区会话根一卷旧卷（id 7）——workspace-session-ownership-rework
    // 归属 = 存储位置（{ws}/.lantai/sessions/7.json）
    // Phase 3b：卷本体 = 事件日志（.ndjson）
    H.kernelFs!.fs.setFile(
      'D:/real-ws/.lantai/sessions/7.ndjson',
      logText(
        7,
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '旧卷内容' },
        ],
        '旧卷',
        '2026-08-25T09:00:00.000Z',
      ),
    );

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
