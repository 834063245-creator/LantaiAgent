// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷名收口（2026-09-18）行为面 —— 三条纪律见 `src/state/volume-name.ts` 头注：
//   ① 卷名 = **一个字段**（空 = 未命名）；数字名不是写入值，只是显示兜底（档号）；
//   ② 首条来文命名只有一条规则（活路径「每轮末」与读盘路径同判同派生）；
//   ③ 手起的名重开不被打回（旧读盘判据「凡以『案卷 』开头即打回」已拆）。
//
// 用户操作序列：起卷 → 打字跑完一轮 → 改名 → 重启重开。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheText, logText } from './helpers/session-files';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { agentSessionState } from '../src/agent/agent-session-state';
import { ChatCore } from '../src/app/chat/chat-core';
import { useShellStore } from '../src/app/shell-store';
import { volumeDisplayName } from '../src/state/volume-name';
import * as Session from '../src/ui/chat-session';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

await ensureProductionChannelsBooted();

const WS = 'D:/name-ws';
const ROOT = `${WS}/.lantai/sessions`;

/** 面板桩：无句柄工厂（建卷/开卷是纯数据操作——句柄不是前置条件）。 */
function createPanel(): ChatCore {
  const panel = new ChatCore();
  panel.setProjectPath(WS);
  panel.setAgent({
    getSession: () => [{ role: 'system', content: 'sys' }],
    setSession: vi.fn(),
    dispose: vi.fn(),
    cascadeAbort: vi.fn(),
  } as never);
  panel.setAgentFactory(async () => null);
  return panel;
}

/** 旧档形态：**头行带 label**（历史写入值）——「读面不认它」的回归夹具。 */
function logWithLegacyHeaderLabel(id: number, label: string, firstUser: string): string {
  const lines = logText(id, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: firstUser },
  ]).split('\n');
  lines[0] = JSON.stringify({ type: 'session', version: 1, id, createdAt: '2026-01-01T00:00:00Z', label });
  return lines.join('\n');
}

/** 一卷盘上形态：事件日志 + 投影缓存（**卷名的家**）。 */
function seedVolume(id: number, opts: { cacheLabel?: string; firstUser?: string; headerLabel?: string } = {}): void {
  const firstUser = opts.firstUser ?? `第 ${id} 卷的首条来文`;
  H.kernelFs!.fs.setFile(
    `${ROOT}/${id}.ndjson`,
    opts.headerLabel
      ? logWithLegacyHeaderLabel(id, opts.headerLabel, firstUser)
      : logText(id, [
          { role: 'system', content: 'sys' },
          { role: 'user', content: firstUser },
        ]),
  );
  if (opts.cacheLabel !== undefined) {
    H.kernelFs!.fs.setFile(`${ROOT}/${id}.json`, cacheText(id, { label: opts.cacheLabel }));
  }
}

describe('卷名收口：一个字段（空 = 未命名），数字名只是显示兜底', () => {
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

  it('起卷 = 未命名（不写数字名）；显示名按档号兜底', async () => {
    const panel = createPanel();
    await panel.createNewSession();

    const sessions = Session.getSessions(panel.panelId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].label).toBe(''); // 真源 = 空；「案卷 N」不进字段
    expect(volumeDisplayName(sessions[0].label, sessions[0].id)).toBe(`案卷 ${sessions[0].id}`);
  });

  it('首轮跑完：以首条来文命名该卷', async () => {
    const panel = createPanel();
    await panel.createNewSession();
    const sid = Session.getSessions(panel.panelId)[0].id;
    // 该卷句柄（首轮刚跑完：会话里已有来文）
    agentSessionState.setAgent(panel.panelId, sid, {
      getSession: () => [{ role: 'user', content: '把卷名收口成一份真源' }],
    } as never);

    Session.autoTitleSessionIfDefault(panel.panelId, sid);

    expect(Session.getSessions(panel.panelId)[0].label).toBe('把卷名收口成一份真源');
  });

  it('已命名的卷不被自动命名覆盖（改名是用户的决定）', async () => {
    const panel = createPanel();
    await panel.createNewSession();
    const sid = Session.getSessions(panel.panelId)[0].id;
    panel.renameSession(sid, '手起的名');
    agentSessionState.setAgent(panel.panelId, sid, {
      getSession: () => [{ role: 'user', content: '后来的来文' }],
    } as never);

    Session.autoTitleSessionIfDefault(panel.panelId, sid);

    expect(Session.getSessions(panel.panelId)[0].label).toBe('手起的名');
  });

  it('重启重开：手起的名（含以「案卷 」开头）不被当成默认名打回', async () => {
    // 旧读盘判据（/^(?:会话|案卷) /）会把这个名字当默认名丢掉 → 变成「首条来文」
    seedVolume(12, { cacheLabel: '案卷 归档 2026', firstUser: '首条来文' });

    const panel = createPanel();
    await panel.loadSessionFromDisk(WS, 12);

    expect(Session.getSessions(panel.panelId)[0].label).toBe('案卷 归档 2026');
  });

  it('旧存档的默认名（案卷 N）当未命名：重开按首条来文命名', async () => {
    seedVolume(13, { cacheLabel: '案卷 13', firstUser: '旧卷的首条来文' });

    const panel = createPanel();
    await panel.loadSessionFromDisk(WS, 13);

    expect(Session.getSessions(panel.panelId)[0].label).toBe('旧卷的首条来文');
  });

  it('日志头行的 label 不再冒充卷名（陈旧副本不采信）', async () => {
    // 无投影缓存（名字的家）——头行有 label 也不认；未命名 → 按首条来文派生
    seedVolume(15, { headerLabel: '旧头行名', firstUser: '旧档首条来文' });

    const panel = createPanel();
    await panel.loadSessionFromDisk(WS, 15);

    expect(Session.getSessions(panel.panelId)[0].label).toBe('旧档首条来文');
  });

  it('卷清单行带原样卷名（空 = 未命名）——显示兜底不写进数据面', async () => {
    seedVolume(21, { cacheLabel: '' });
    seedVolume(22, { cacheLabel: '有名卷' });

    const panel = createPanel();
    const rows = await panel.listSavedSessions(WS);

    expect(rows.find((r) => r.id === 21)?.label).toBe('');
    expect(rows.find((r) => r.id === 22)?.label).toBe('有名卷');
    // 侧栏合流后仍由呈现层兜底（数据面留空，显示才有唯一出处）
    expect(volumeDisplayName(rows.find((r) => r.id === 21)?.label, 21)).toBe('案卷 21');
  });
});
