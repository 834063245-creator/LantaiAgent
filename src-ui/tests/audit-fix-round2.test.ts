// SPDX-License-Identifier: MIT
// Round 2 audit fix tests:
// R6 (TaskBoard/DiscoveryBoard destroy prevents flush revival)
// Low-prio: discovery restore dedup, compaction deserializeState replace semantics
// R1 (inbox recovery) — regression test: restore/delete must pass filter_ignored: false
// A6 (session-scoped boards) — two sessions flush to separate files, no cross-write
// R4 (discard wrong namespace) — verified via code removal (abort path handles cleanup)
// R8 (forceClearState flush) — covered by flushAllBoards being awaited in deactivate()

// fs 域收口（2026-09-04）：board/inbox 持久化经 kernelCreateDirectory/
// kernelWriteFile/kernelReadFile/kernelListDirectory（rpc-contract 具名 helper，
// 内部直呼 fs_cap）——mock 站到 helper 层（不再拦 bridge + legacyRpcShim 翻
// 信封）。filterIgnored=false 断言 = fs.lists 捕获；写路径断言 = fs.writes。

import { describe, expect, it, vi } from 'vitest';
import { DiscoveryBoard } from '../src/agent/discovery-board';
import { JsonMessageStore } from '../src/plugins/builtin/multiagent-comm/message-store';
import { TaskBoard } from '../src/plugins/builtin/task-domain/task-board';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

function freshFs(): void {
  const k = H.kernelFs!;
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.lists.length = 0;
  k.fs.fail = {};
}

// ── R6: TaskBoard.destroy() clears entries and prevents flush revival ──
describe('R6: TaskBoard destroy prevents flush revival', () => {
  it('destroy clears entries and sets _destroyed flag', async () => {
    freshFs();
    const board = new TaskBoard('D:/test', 'session-1');
    board.register('agent-1', 'parent-1', 'task A', null);
    expect(board.getAllEntries().length).toBeGreaterThan(0);

    await board.destroy();

    expect(board.getAllEntries().length).toBe(0);

    // Flush after destroy should be a no-op
    const writeCount = H.kernelFs!.fs.writes.length;
    await board.flush();
    expect(H.kernelFs!.fs.writes.length).toBe(writeCount);
  });
});

// ── R6: DiscoveryBoard.destroy() clears entries and prevents flush revival ──
describe('R6: DiscoveryBoard destroy prevents flush revival', () => {
  it('destroy clears entries and prevents subsequent flush', async () => {
    freshFs();
    const board = new DiscoveryBoard('D:/test', 'session-1');
    board.post('agent-1', 'key1', 'value1', 'category1');
    expect(board.query({ agentId: 'agent-1' }).length).toBeGreaterThan(0);

    await board.destroy();

    expect(board.query({ agentId: 'agent-1' }).length).toBe(0);

    const writeCount = H.kernelFs!.fs.writes.length;
    await board.flush();
    expect(H.kernelFs!.fs.writes.length).toBe(writeCount);
  });
});

// ── Low-prio: DiscoveryBoard.restore() deduplicates by agentId+key ──
describe('DiscoveryBoard restore deduplicates entries', () => {
  it('restore keeps only last entry per agentId+key', async () => {
    freshFs();
    const board = new DiscoveryBoard('D:/test', 'session-1');
    const now = Date.now();
    const entries = [
      { id: '1', agentId: 'a1', key: 'k1', value: 'old', category: 'cat', ts: now - 2000, status: 'active' as const },
      { id: '2', agentId: 'a1', key: 'k1', value: 'new', category: 'cat', ts: now - 1000, status: 'active' as const },
      { id: '3', agentId: 'a2', key: 'k2', value: 'v2', category: 'cat', ts: now, status: 'active' as const },
    ];
    // 预置 board 文件——restore 直接读盘
    H.kernelFs!.fs.setFile('D:/test/.lantai/discoveries/session-1.json', JSON.stringify(entries));

    await board.restore();

    expect(board.getAll().length).toBe(2); // a1:k1 (deduped) + a2:k2

    const results = board.query({ agentId: 'a1' });
    expect(results.length).toBe(1);
    expect(results[0].value).toBe('new');
    expect(board.query({ agentId: 'a2' }).length).toBe(1);
  });
});

// ── Low-prio: CompactionTracker.deserializeState replaces instead of appending ──
describe('CompactionTracker deserializeState replaces not appends', () => {
  it('calling deserializeState twice does not duplicate events', async () => {
    freshFs();
    const { CompactionTracker } = await import('../src/agent/compaction-tracker');
    const tracker = new CompactionTracker();
    const state1 = JSON.stringify({
      events: [{ type: 'turn', turn: 1 }],
      turnsAfter: [1],
      filesRead: ['a.ts'],
    });
    tracker.deserializeState(state1);
    const parsed1 = JSON.parse(tracker.serializeState());
    expect(parsed1.events.length).toBe(1);

    // Deserialize again with the same state
    tracker.deserializeState(state1);
    const parsed2 = JSON.parse(tracker.serializeState());
    // Should still be 1, not 2 (replace, not append)
    expect(parsed2.events.length).toBe(1);
  });
});

// ── R1: inbox restore must bypass is_ignored_path filtering ──
describe('R1: JsonMessageStore restore passes filter_ignored: false', () => {
  it('restore lists .lantai/agents with filter_ignored: false and recovers messages', async () => {
    freshFs();
    const store = new JsonMessageStore('D:/test');
    // 预置 inbox 文件 + agent 目录（listFlat 从 files/dirs 推导目录条目）
    H.kernelFs!.fs.setFile(
      'D:/test/.lantai/agents/agent-1/inbox.json',
      JSON.stringify([{ id: 'm1', from: 'a', type: 'text', payload: 'hi', ts: 1 }]),
    );

    const restored = await store.restore();

    // Every list_directory call must carry filterIgnored: false — otherwise
    // .lantai is filtered by is_ignored_path and inbox recovery silently dies.
    const listCalls = H.kernelFs!.fs.lists;
    expect(listCalls.length).toBeGreaterThan(0);
    for (const l of listCalls) {
      expect(l.filterIgnored).toBe(false);
    }
    // And the message actually round-trips
    expect(restored.get('agent-1')?.length).toBe(1);
  });
});

// ── A6: session-scoped boards flush to their own files ──
describe('A6: two sessions flush to separate board files', () => {
  it('session-a and session-b write distinct taskboard paths', async () => {
    freshFs();
    const boardA = new TaskBoard('D:/test', 'session-a');
    const boardB = new TaskBoard('D:/test', 'session-b');
    boardA.register('agent-1', 'parent-1', 'task A', null);
    boardB.register('agent-2', 'parent-2', 'task B', null);

    await boardA.flush();
    await boardB.flush();

    const paths = H.kernelFs!.fs.writes.map((w) => w.file_path);
    expect(paths.some((p) => p.endsWith('.lantai/taskboard/session-a.json'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.lantai/taskboard/session-b.json'))).toBe(true);
    // No cross-contamination: session-a's board never written to session-b's path
    const aWrites = H.kernelFs!.fs.writes.filter((w) => w.file_path.includes('session-a'));
    expect(aWrites.every((w) => !w.file_path.includes('session-b'))).toBe(true);
  });
});
