// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';

// fs 域收口（2026-09-04）：GoalManager 持久化经 kernelCreateDirectory/
// kernelWriteFile/kernelReadFile/kernelDeleteFile（rpc-contract 具名 helper，
// 内部直呼 fs_cap）——mock 站到 helper 层（不再拦 bridge + legacyRpcShim
// 翻信封）。内存 Map 即磁盘（状态真实流转，与旧 rpc 面同语义）。

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import { GoalManager, type GoalRecord } from '../src/agent/goal-manager';

const GOALS = '/proj/.lantai/goals';

/** 重置为空白内存 fs（同旧 mockLiveFs 语义——空盘起测）。 */
function mockLiveFs(initial: Record<string, string> = {}): void {
  const k = H.kernelFs!;
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.fail = {};
  for (const [p, v] of Object.entries(initial)) k.fs.setFile(p, v);
}

function makeRecord(partial: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'goal-1',
    text: 'fix auth',
    status: 'active',
    iteration: 0,
    stallRounds: 0,
    summary: '',
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

// ── CRUD ──

describe('GoalManager CRUD', () => {
  beforeEach(() => {
    mockLiveFs();
  });

  it('blocked is a resumable slot-holder: getActive returns it and cancel clears it', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('deploy release');
    const blocked = await gm.update(rec.id, { status: 'blocked', summary: '需要人工批准生产发布' });

    expect(blocked?.status).toBe('blocked');
    // blocked 占用单目标槽 — 仍是可恢复态，不得被当作历史
    const active = await gm.getActive();
    expect(active?.id).toBe(rec.id);
    expect(active?.status).toBe('blocked');

    await gm.cancel(rec.id);
    expect((await gm.getActive())?.id).not.toBe(rec.id);
  });

  it('create + get round-trip, fires onState with active record', async () => {
    const states: GoalRecord[] = [];
    const gm = new GoalManager('/proj', (r) => states.push(r));
    const rec = await gm.create('fix auth bug');

    expect(rec.id).toMatch(/^goal-/);
    expect(rec.status).toBe('active');
    expect(rec.text).toBe('fix auth bug');

    const loaded = await gm.get(rec.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.text).toBe('fix auth bug');

    expect(states.length).toBe(1);
    expect(states[0].status).toBe('active');
  });

  it('create cancels an existing live goal (single-goal slot)', async () => {
    const gm = new GoalManager('/proj');
    const g1 = await gm.create('old goal');
    const g2 = await gm.create('new goal');

    expect((await gm.get(g1.id))?.status).toBe('cancelled');
    const active = await gm.getActive();
    expect(active).not.toBeNull();
    expect(active?.id).toBe(g2.id);
  });

  it('getActive returns null when no live goal; finds paused too', async () => {
    const gm = new GoalManager('/proj');
    expect(await gm.getActive()).toBeNull();

    const rec = await gm.create('paused goal');
    await gm.update(rec.id, { status: 'paused' });
    const active = await gm.getActive();
    expect(active).not.toBeNull();
    expect(active?.status).toBe('paused');
  });

  it('update refreshes fields + updatedAt, keeps id/createdAt, index stays consistent', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('iterate');
    const before = rec.updatedAt;

    const updated = await gm.update(rec.id, { iteration: 5, stallRounds: 2 });
    expect(updated).not.toBeNull();
    expect(updated?.iteration).toBe(5);
    expect(updated?.stallRounds).toBe(2);
    expect(updated?.id).toBe(rec.id);
    expect(updated?.createdAt).toBe(rec.createdAt);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(before);

    const all = await gm.list();
    expect(all.length).toBe(1);
    expect(all[0].iteration).toBe(5);
  });

  it('update on missing id returns null', async () => {
    const gm = new GoalManager('/proj');
    expect(await gm.update('goal-nope', { iteration: 1 })).toBeNull();
  });

  it('cancel keeps the record but clears the active slot', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('cancel me');
    await gm.cancel(rec.id);

    expect((await gm.get(rec.id))?.status).toBe('cancelled');
    expect(await gm.getActive()).toBeNull();
    // 历史里仍可见
    expect((await gm.list()).some((r) => r.id === rec.id)).toBe(true);
  });

  it('delete removes record from index and files', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('delete me');
    await gm.delete(rec.id);

    expect(await gm.get(rec.id)).toBeNull();
    expect((await gm.list()).length).toBe(0);
    expect([...H.kernelFs!.fs.files.keys()].some((k) => k.includes(rec.id))).toBe(false);
  });
});

// ── Session 快照 ──

describe('GoalManager session snapshots', () => {
  beforeEach(() => {
    mockLiveFs();
  });

  it('saveSession + loadSession round-trip', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('snapshot');
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '<goal>fix</goal>' },
    ] as any[];
    await gm.saveSession(rec.id, msgs);

    const loaded = await gm.loadSession(rec.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.length).toBe(2);
    expect(loaded?.[1].content).toBe('<goal>fix</goal>');
  });

  it('loadSession returns null when no snapshot', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('no snapshot');
    expect(await gm.loadSession(rec.id)).toBeNull();
  });
});

// ── 崩溃接管 ──

describe('GoalManager adoptOrphans', () => {
  it('ancient active record → paused', async () => {
    const orphan = makeRecord({ id: 'goal-orphan', status: 'active', updatedAt: 1 });
    mockLiveFs({
      [`${GOALS}/goal-orphan/goal.json`]: JSON.stringify(orphan),
      [`${GOALS}/index.json`]: JSON.stringify([orphan]),
    });
    const gm = new GoalManager('/proj'); // startedAt = now >> 1

    const adopted = await gm.adoptOrphans();
    expect(adopted.length).toBe(1);
    expect(adopted[0].id).toBe('goal-orphan');
    expect(adopted[0].status).toBe('paused');
    expect((await gm.get('goal-orphan'))?.status).toBe('paused');
  });

  it('fresh active record from this process is untouched', async () => {
    mockLiveFs();
    const gm = new GoalManager('/proj');
    const live = await gm.create('live goal'); // updatedAt >= startedAt

    const adopted = await gm.adoptOrphans();
    expect(adopted.length).toBe(0);
    expect((await gm.get(live.id))?.status).toBe('active');
  });
});
