// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷号治理 B（2026-09-21）：**号一经发出，永不复用**。
//
// 病根（修前）：发号器只在内存，重启按「磁盘现存最大号 + 1」对账 ⇒ 删掉高位卷后
// 旧号被重新发出，而死卷残留的投影缓存正好接住同号新卷（真机事故：子卷顶着死卷的名）。
// 治法：每工作区一本**发号账** `{root}/_issue.json`，发出即记账、单调、重启不回退。
// 设计件：docs/plans/volume-number-governance-plan.md §3/§4。
//
// 用户操作序列：起几卷 → 删掉高位卷 → 重启 → 再起一卷（号必须 > 所有已发出的号）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { ChatCore } from '../src/app/chat/chat-core';
import { createBranchVolume } from '../src/app/chat/session-branch';
import type { SessionContext } from '../src/ui/chat-session';
import * as Session from '../src/ui/chat-session';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

await ensureProductionChannelsBooted();

const WS = 'D:/issue-ws';
const ROOT = `${WS}/.lantai/sessions`;
const sys = { role: 'system', content: 'sys' };

/** 面板桩（同 volume-naming.test.ts：无句柄工厂——建卷/开卷是纯数据操作）。 */
function createPanel(): ChatCore {
  const panel = new ChatCore();
  panel.setProjectPath(WS);
  panel.setAgent({
    getSession: () => [sys],
    setSession: vi.fn(),
    dispose: vi.fn(),
    cascadeAbort: vi.fn(),
  } as never);
  panel.setAgentFactory(async () => null);
  return panel;
}

/** 立枝用的最小 SessionContext（同 session-branch.test.ts：只用 storeId/getProjectPath
 *  与几个 UI 回调，其余能力位缺席 ⇒ 走降级分支）。 */
function makeCtx(storeId: string): SessionContext {
  return {
    storeId,
    getProjectPath: () => WS,
    flushReasoning: () => {},
    flushText: () => {},
    clearPendingToolCards: () => {},
    clearInputHistory: () => {},
    getTotalTokensUsed: () => 0,
    setTotalTokensUsed: () => {},
    setLastUsageText: () => {},
    updateFooter: () => {},
  } as unknown as SessionContext;
}

/** 一卷的盘上形态（事件日志 + 投影缓存）。 */
function seedVolume(id: number, messages = [sys, { role: 'user', content: `第 ${id} 卷的首条来文` }]): void {
  H.kernelFs!.fs.setFile(`${ROOT}/${id}.ndjson`, logText(id, messages));
  H.kernelFs!.fs.setFile(`${ROOT}/${id}.json`, cacheText(id, { label: `第 ${id} 卷` }));
}

function seedIssueLedger(raw: string): void {
  H.kernelFs!.fs.setFile(`${ROOT}/_issue.json`, raw);
}

function issueLedger(): { ver: number; next: number } | null {
  const raw = H.kernelFs!.fs.files.get(`${ROOT}/_issue.json`);
  return raw ? (JSON.parse(raw) as { ver: number; next: number }) : null;
}

/** 模拟重启：模块级态（卷目录 + 发号账）整体清空——与真进程重启同形。 */
function restart(): void {
  Session.resetSessionListCacheForTests();
}

/** 起一卷并返回新卷号——走**生产序列**：工作区装配对账（`shell/rows/workspace.ts` 的
 *  既有次序）→ 起卷。发号路径自身只认内存 + 账（不扫盘），盘上号归装配对账。 */
async function newVolumeId(): Promise<number> {
  const panel = createPanel();
  await Session.autoRestoreLastSession(makeCtx(panel.panelId), WS);
  await panel.createNewSession();
  const sessions = Session.getSessions(panel.panelId);
  expect(sessions).toHaveLength(1);
  return sessions[0].id;
}

describe('发号账：号一经发出，永不复用（2026-09-21 卷号治理 B）', () => {
  beforeEach(() => {
    localStorage.clear();
    H.kernelFs!.fs.files.clear();
    H.kernelFs!.fs.dirs.clear();
    H.kernelFs!.fs.writes.length = 0;
    H.kernelFs!.fs.fail = {};
    restart();
  });

  it('起卷即记账：账 next = 新号 + 1', async () => {
    expect(await newVolumeId()).toBe(1);
    expect(issueLedger()).toEqual({ ver: 1, next: 2 });
  });

  it('**号不复用**：账 next=20、盘上只剩 1..5 ⇒ 重启后起卷拿 20（修前拿 6）', async () => {
    for (const id of [1, 2, 3, 4, 5]) seedVolume(id);
    // 6..19 曾发出、卷已删——账是这些号唯一的凭证
    seedIssueLedger(JSON.stringify({ ver: 1, next: 20 }));
    restart();

    expect(await newVolumeId()).toBe(20);
    expect(issueLedger()).toEqual({ ver: 1, next: 21 });
  });

  it('立枝同源：同一场景走 createBranchVolume 也拿账上的号', async () => {
    seedVolume(1, [sys, { role: 'user', content: '父卷首句' }, { role: 'assistant', content: '父卷回复' }]);
    seedIssueLedger(JSON.stringify({ ver: 1, next: 20 }));
    restart();

    const panel = createPanel();
    const res = await createBranchVolume(makeCtx(panel.panelId), 1);
    expect(res).toMatchObject({ ok: true, sid: 20 });
    expect(issueLedger()).toEqual({ ver: 1, next: 21 });
  });

  it('账坏档 ⇒ 退回磁盘对账 + 重建账（不炸）', async () => {
    seedVolume(1);
    seedVolume(2);
    seedIssueLedger('{ 这不是 JSON');
    restart();

    expect(await newVolumeId()).toBe(3); // 坏档不参与对账 → 退回 最大号 + 1
    expect(issueLedger()).toEqual({ ver: 1, next: 4 }); // 坏档被新账覆盖（损坏 ≠ 版本不认）
  });

  it('账版本不认（更新版兰台写的）⇒ 退回磁盘对账，但**绝不覆写**它', async () => {
    seedVolume(1);
    seedVolume(2);
    seedIssueLedger(JSON.stringify({ ver: 99, next: 20 }));
    restart();

    expect(await newVolumeId()).toBe(3); // 不认的账不参与对账（退回磁盘）
    // 定向拒读：降级运行不得抹掉新版已发出的号段（同卷日志格式纪律）
    expect(issueLedger()).toEqual({ ver: 99, next: 20 });
  });

  it('账缺席（旧工作区首开）⇒ 退回磁盘对账 + 首次发号补写账', async () => {
    seedVolume(4);
    restart();

    expect(await newVolumeId()).toBe(5);
    expect(issueLedger()).toEqual({ ver: 1, next: 6 });
  });

  it('账不回退：磁盘下限 22 > 账 20 ⇒ 拿 22，账被抬到 23', async () => {
    seedVolume(21);
    seedIssueLedger(JSON.stringify({ ver: 1, next: 20 }));
    restart();

    expect(await newVolumeId()).toBe(22);
    expect(issueLedger()).toEqual({ ver: 1, next: 23 });
  });

  it('账落盘失败不阻断建卷（可见 warn；号照发）', async () => {
    H.kernelFs!.fs.fail = { write: 'disk full' };

    expect(await newVolumeId()).toBe(1); // 不抛
    expect(issueLedger()).toBeNull(); // 账没写进去（下次发号重试）
  });

  it('并发立枝不铸同号（旧实现取的是 await 之前的陈旧快照——本批顺带修的雷）', async () => {
    seedVolume(1, [sys, { role: 'user', content: '父卷首句' }, { role: 'assistant', content: '父卷回复' }]);
    restart();

    const panel = createPanel();
    const [a, b] = await Promise.all([
      createBranchVolume(makeCtx(panel.panelId), 1),
      createBranchVolume(makeCtx(panel.panelId), 1),
    ]);
    const ids = [a, b].map((r) => (r.ok ? r.sid : -1));
    expect(ids.every((sid) => sid > 0)).toBe(true); // 两次都立成
    expect(new Set(ids).size).toBe(2); // 号不撞（撞号 = 原子替换写互相覆写）
  });
});
