// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 持久化与崩溃恢复 — Phase 2 收尾测试
//
// 5 组测试：
//   3.1 MessageBus flush → restore 往返一致性
//   3.2 TaskBoard flush → restore 往返一致性
//   3.3 debounced flush 不丢数据
//   3.4 空启动恢复不报错
//   3.5 孤儿检测（running 条目 → stop + discard）
//
// fs 域收口（2026-09-04）：持久化 I/O 经 rpc-contract 具名 helper
// （kernelReadFile/kernelWriteFile/kernelCreateDirectory/kernelListDirectory/
// kernelDeleteFile——内部直呼 fs_cap）——mock 站到 helper 层；agent_isolation_*
// 是 agentInvoke 动态分发（bridge.rpc 直达），走 bridge mock 面。两轨并存。

import { describe, expect, it, vi } from 'vitest';

import type { AgentAddress } from '../src/agent/message-types';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
  invoke: null as null | ReturnType<typeof vi.fn>,
}));

// bridge mock：只承载 agentInvoke 动态分发（agent_isolation_* 等非 fs 命令）；
// fs 域经 rpc-contract 具名 helper 覆写拦截，不进 bridge。
vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => H.invoke?.(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import { MessageBus } from '../src/agent/message-bus';
import { JsonMessageStore } from '../src/agent/message-store';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import { TaskBoard } from '../src/agent/task-board';
import { MeshTopology } from '../src/agent/topology';

// ═══════════════════════════════════════════════════════
// 内存文件系统 helper（fs 域走共享 kernel-fs mock）
// ═══════════════════════════════════════════════════════

/** 全量清空共享内存 fs（每用例独立起测）。 */
function freshFs(): void {
  const k = H.kernelFs!;
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.lists.length = 0;
  k.fs.fail = {};
}

/** 设置全部 fs 操作 reject 模式（模拟无文件——空启动 / 读错误路径）。 */
function setupRejectAll(): void {
  freshFs();
  const k = H.kernelFs!;
  k.fs.fail.read = 'not found';
  k.fs.fail.list = 'not found';
  k.fs.fail.delete = 'not found';
}

/** agentInvoke 动态分发 mock：agent_isolation_* 等非 fs 命令。 */
function setupIsolation(): void {
  H.invoke = vi.fn(async (method: string, _params: unknown) => {
    switch (method) {
      case 'agent_isolation_diff': {
        // 孤儿 worktree 的 diff 保全 — 只对 iso-orphan 返回有变更
        const agentId = (_params as { agent_id?: string })?.agent_id ?? '';
        if (agentId === 'iso-orphan') {
          return JSON.stringify({ has_changes: true, diff: 'partial-diff-from-crash' });
        }
        return JSON.stringify({ has_changes: false, diff: '' });
      }
      case 'agent_isolation_discard':
        return 'discarded';
      default:
        return 'ok';
    }
  });
}

function addr(agentId: string, parentId: string | null = null, depth = 0): AgentAddress {
  return { agentId, parentId, depth };
}

// ═══════════════════════════════════════════════════════
// 3.1 MessageBus — flush/restore 往返一致性
// ═══════════════════════════════════════════════════════

describe('MessageBus — flush/restore 往返一致性', () => {
  it('flush 写入 inbox.json，restore 后消息完全一致', async () => {
    freshFs();
    setupIsolation();

    // 构造 MessageBus + store
    const store = new JsonMessageStore('/fake/project');
    const bus = new MessageBus(undefined, store);
    bus.setTopology(new MeshTopology());

    // 注册 2 个 agent
    bus.register(addr('agent-a'));
    bus.register(addr('agent-b'));

    // 发送 3 条消息：send / reply / broadcast
    const msgId1 = bus.send({ from: 'agent-a', to: 'agent-b', type: 'task', payload: 'hello-b' });

    // reply: agent-b 回复 agent-a
    const _msgId2 = bus.reply('agent-b', msgId1, 'reply-payload');

    // broadcast: agent-a 广播
    bus.broadcast('agent-a', 'notification', { text: 'broadcast-msg' });

    // 手动 flush
    await bus.flush();

    // 验证写入了 inbox 文件，路径含 .lantai/agents/{agentId}/inbox.json
    const writtenPaths = H.kernelFs!.fs.writes.map((w) => w.file_path);
    expect(writtenPaths.length).toBeGreaterThanOrEqual(1);
    expect(writtenPaths.some((p) => p.includes('.lantai/agents/agent-a/inbox.json'))).toBe(true);
    expect(writtenPaths.some((p) => p.includes('.lantai/agents/agent-b/inbox.json'))).toBe(true);

    // 验证写入的内容是合法 JSON 数组
    const inboxAFile = H.kernelFs!.fs.files.get('/fake/project/.lantai/agents/agent-a/inbox.json');
    expect(inboxAFile).toBeDefined();
    const inboxAMsgs = JSON.parse(inboxAFile!);
    expect(Array.isArray(inboxAMsgs)).toBe(true);

    // 新建第二个 store + bus2，调 restore
    const store2 = new JsonMessageStore('/fake/project');
    const bus2 = new MessageBus(undefined, store2);
    bus2.setTopology(new MeshTopology());
    await bus2.restore();

    // 验证 bus2.peekInbox("agent-a") 与 bus.peekInbox("agent-a") 消息数量一致
    const origA = bus.peekInbox('agent-a');
    const restoredA = bus2.peekInbox('agent-a');
    expect(restoredA.length).toBe(origA.length);

    // 验证每条消息的 id、from、to、type、payload 完全一致
    for (let i = 0; i < origA.length; i++) {
      expect(restoredA[i].id).toBe(origA[i].id);
      expect(restoredA[i].from).toBe(origA[i].from);
      expect(restoredA[i].to).toBe(origA[i].to);
      expect(restoredA[i].type).toBe(origA[i].type);
      expect(restoredA[i].payload).toEqual(origA[i].payload);
    }

    // 验证 unreadCount 一致
    expect(bus2.unreadCount('agent-a')).toBe(bus.unreadCount('agent-a'));
    expect(bus2.unreadCount('agent-b')).toBe(bus.unreadCount('agent-b'));

    // 验证 reply 消息的 replyTo 字段也一致
    const origB = bus.peekInbox('agent-b');
    const restoredB = bus2.peekInbox('agent-b');
    if (origB.length > 0 && restoredB.length > 0) {
      expect(restoredB[0].replyTo).toBe(origB[0].replyTo);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 3.2 TaskBoard — flush/restore 往返一致性
// ═══════════════════════════════════════════════════════

describe('TaskBoard — flush/restore 往返一致性', () => {
  it('flush 写入 taskboard.json，restore 后所有字段完全一致', async () => {
    freshFs();
    setupIsolation();

    const board = new TaskBoard('/fake/project', 'default');

    // register 2 个条目（1 个有 isolationId，1 个无）
    board.register({
      agentId: 'sub-1',
      parentAgentId: 'main',
      description: 'task with isolation',
      isolationId: 'iso-1',
    });
    board.register({
      agentId: 'sub-2',
      parentAgentId: 'main',
      description: 'task without isolation',
      isolationId: null,
    });

    // 对第一个调 recordFileTouch 2 个文件
    board.recordFileTouch('sub-1', '/a.ts');
    board.recordFileTouch('sub-1', '/b.ts');

    // 对第一个调 complete，对第二个调 fail
    board.complete('sub-1', 'done summary', 'diff content');
    board.fail('sub-2', 'error message');

    // flush
    await board.flush();

    // 验证写入了 taskboard/default.json
    const writes = H.kernelFs!.fs.writes;
    const boardWrite = writes.find((w) => w.file_path.includes('.lantai/taskboard/default.json'));
    expect(boardWrite).toBeDefined();
    expect(boardWrite!.file_path).toContain('.lantai/taskboard/default.json');

    // 验证内容是合法 JSON 数组
    const raw = H.kernelFs!.fs.files.get('/fake/project/.lantai/taskboard/default.json');
    expect(raw).toBeDefined();
    const arr = JSON.parse(raw!);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(2);

    // 新建 board2，调 restore
    const board2 = new TaskBoard('/fake/project', 'default');
    await board2.restore();

    // 验证所有字段完全一致
    const e1 = board.getEntry('sub-1')!;
    const r1 = board2.getEntry('sub-1')!;
    expect(r1.agentId).toBe(e1.agentId);
    expect(r1.parentAgentId).toBe(e1.parentAgentId);
    expect(r1.description).toBe(e1.description);
    expect(r1.status).toBe(e1.status);
    expect(r1.isolationId).toBe(e1.isolationId);
    expect(r1.filesTouched).toEqual(e1.filesTouched);
    expect(r1.summary).toBe(e1.summary);
    expect(r1.diff).toBe(e1.diff);
    expect(r1.startedAt).toBe(e1.startedAt);
    expect(r1.finishedAt).toBe(e1.finishedAt);

    const e2 = board.getEntry('sub-2')!;
    const r2 = board2.getEntry('sub-2')!;
    expect(r2.agentId).toBe(e2.agentId);
    expect(r2.parentAgentId).toBe(e2.parentAgentId);
    expect(r2.description).toBe(e2.description);
    expect(r2.status).toBe(e2.status);
    expect(r2.isolationId).toBe(e2.isolationId);
    expect(r2.filesTouched).toEqual(e2.filesTouched);
    expect(r2.summary).toBe(e2.summary);
    expect(r2.diff).toBe(e2.diff);
    expect(r2.startedAt).toBe(e2.startedAt);
    expect(r2.finishedAt).toBe(e2.finishedAt);
  });
});

// ═══════════════════════════════════════════════════════
// 3.3 debounced flush — 定时器 pending 时 flush 不丢数据
// ═══════════════════════════════════════════════════════

describe('debounced flush — 定时器 pending 时 flush 不丢数据', () => {
  it('TaskBoard: 手动 flush 在定时器 pending 时写入全部状态，之后定时器触发不丢数据', async () => {
    vi.useFakeTimers();
    freshFs();
    setupIsolation();

    const board = new TaskBoard('/fake/project', 'default');
    board.register({
      agentId: 'sub-1',
      parentAgentId: 'main',
      description: 'debounced task',
      isolationId: 'iso-1',
    });
    // recordFileTouch 触发 _scheduleFlush() — 2 秒后 flush
    board.recordFileTouch('sub-1', '/a.ts');

    // 推进 1 秒 — 定时器还没触发
    await vi.advanceTimersByTimeAsync(1000);

    // 手动 flush — 应写入当前全部状态
    await board.flush();

    expect(H.kernelFs!.fs.writes.length).toBeGreaterThanOrEqual(1);

    // 验证 JSON 内容包含该条目
    const raw = H.kernelFs!.fs.files.get('/fake/project/.lantai/taskboard/default.json');
    expect(raw).toBeDefined();
    const arr = JSON.parse(raw!);
    expect(arr.some((e: [string, unknown]) => e[0] === 'sub-1')).toBe(true);

    const firstWriteContent = raw!;

    // 继续推进到 2 秒 — debounced flush 触发，再次写入
    await vi.advanceTimersByTimeAsync(2000);

    // 至少被写 2 次
    expect(H.kernelFs!.fs.writes.length).toBeGreaterThanOrEqual(2);

    // 两次内容一致（不丢数据）
    const secondWriteContent = H.kernelFs!.fs.files.get('/fake/project/.lantai/taskboard/default.json');
    expect(secondWriteContent).toBe(firstWriteContent);

    // clearFlushTimer() 后不再有额外 flush
    board.clearFlushTimer();
    const countBefore = H.kernelFs!.fs.writes.length;
    await vi.advanceTimersByTimeAsync(5000);
    const countAfter = H.kernelFs!.fs.writes.length;
    expect(countAfter).toBe(countBefore);

    vi.useRealTimers();
  });

  it('MessageBus: clearFlushTimer + flush 后不再有额外写入', async () => {
    vi.useFakeTimers();
    freshFs();
    setupIsolation();

    const store = new JsonMessageStore('/fake/project');
    const bus = new MessageBus(undefined, store);
    bus.setTopology(new MeshTopology());
    bus.register(addr('sender'));
    bus.register(addr('receiver'));

    // 发消息（触发 debounced flush）
    bus.send({ from: 'sender', to: 'receiver', type: 'msg', payload: 'hello' });

    // 1 秒时调 clearFlushTimer() + flush — 验证数据写入
    await vi.advanceTimersByTimeAsync(1000);
    bus.clearFlushTimer();
    await bus.flush();

    const writeCount = H.kernelFs!.fs.writes.length;
    expect(writeCount).toBeGreaterThanOrEqual(1);

    // 推进 3 秒，验证没有额外的写入（定时器已被 clear）
    await vi.advanceTimersByTimeAsync(3000);
    expect(H.kernelFs!.fs.writes.length).toBe(writeCount);

    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════
// 3.4 空启动恢复 — 无持久化文件时不报错
// ═══════════════════════════════════════════════════════

describe('空启动恢复 — 无持久化文件时不报错', () => {
  it('JsonMessageStore.restore() 返回空 Map', async () => {
    setupRejectAll();

    const store = new JsonMessageStore('/fake/project');
    const result = await store.restore();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('MessageBus.restore() 后 inbox 为空', async () => {
    setupRejectAll();

    const store = new JsonMessageStore('/fake/project');
    const bus = new MessageBus(undefined, store);
    await bus.restore();
    expect(bus.peekInbox('any-agent')).toEqual([]);
  });

  it('TaskBoard.restore() 后无条目', async () => {
    setupRejectAll();

    const board = new TaskBoard('/fake/project', 'default');
    await board.restore();
    expect(board.getAllEntries()).toHaveLength(0);
  });

  it('AgentRuntime.ready() 不抛异常，bus/board 为空', async () => {
    setupRejectAll();
    setupIsolation();

    const runtime = new AgentRuntime('/fake/project');
    await runtime.ready();
    expect(runtime.getBus().listAgents()).toHaveLength(0);
    expect(runtime.getTaskBoard().getAllEntries()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════
// 3.5 孤儿检测 — running 条目 → stop + diff 保全（worktree 保留）
// 2026-08-15 收口：不再 discard — TTL 清理纪律「不销毁无记录的工作」，
// 先抓 diff 保全到 board，抓不到则保留现场。
// ═══════════════════════════════════════════════════════

describe('孤儿检测 — running 条目 → stop + diff 保全', () => {
  it('restore 后 running 条目变 stopped，diff 保全到 board，worktree 不销毁', async () => {
    freshFs();
    setupIsolation();

    // 构造 TaskBoard，写入 2 个条目
    const board = new TaskBoard('/fake/project', 'default');
    board.register({
      agentId: 'sub-completed',
      parentAgentId: 'main',
      description: 'completed task',
      isolationId: 'iso-completed',
    });
    board.register({
      agentId: 'sub-orphan',
      parentAgentId: 'main',
      description: 'orphan task',
      isolationId: 'iso-orphan',
    });
    // 标记第一个 complete，第二个保持 running
    board.complete('sub-completed', 'done', 'diff-completed');

    await board.flush();

    // 新建 AgentRuntime — 构造函数会触发 _restore()
    const runtime = new AgentRuntime('/fake/project');
    await runtime.ready();

    // 验证 running 的条目状态变为 stopped
    const orphanEntry = runtime.getTaskBoard().getEntry('sub-orphan');
    expect(orphanEntry).toBeDefined();
    expect(orphanEntry!.status).toBe('stopped');

    // 崩溃现场必须保全：diff 抓到后写回 board
    expect(orphanEntry!.diff).toContain('partial-diff-from-crash');

    // 验证 completed 的条目状态保持 completed（不被误改）
    const completedEntry = runtime.getTaskBoard().getEntry('sub-completed');
    expect(completedEntry).toBeDefined();
    expect(completedEntry!.status).toBe('completed');

    // worktree 保留现场 — 不得调用 agent_isolation_discard（无记录不销毁）
    const discardCalls = (H.invoke!.mock.calls as Array<[string, unknown]>).filter(
      (c) => c[0] === 'agent_isolation_discard',
    );
    expect(discardCalls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// P0-6 回归 — 瞬时读错误不得删除 inbox（雷区地图）
// ═══════════════════════════════════════════════════════

describe('P0-6: JsonMessageStore 区分「不存在」与「读错误」', () => {
  it('瞬时读错误（IPC 抖动）时 inbox.json 必须保留', async () => {
    freshFs();
    setupIsolation();
    // 读抛错（list 正常返回 agent-x 目录）
    const k = H.kernelFs!;
    k.fs.setFile('D:/ws/.lantai/agents/agent-x/inbox.json', '[]');
    k.fs.fail.read = 'IPC timeout — 瞬时错误';

    const store = new JsonMessageStore('D:/ws');
    const result = await store.restore();
    expect(result.size).toBe(0); // 读不到就不返回，但绝不可删
    // 内存 fs 无 delete 记录（restore 只读不删）
    expect(k.fs.files.has('D:/ws/.lantai/agents/agent-x/inbox.json')).toBe(true);
  });

  it('文件不存在（含 Windows 中文 os error 2 文案）时静默跳过、不删目录', async () => {
    freshFs();
    setupIsolation();
    // inbox 缺失（isFileNotFound → 静默跳过）——无文件即 ENOENT
    const k = H.kernelFs!;
    k.fs.setFile('D:/ws/.lantai/agents/agent-win/state.json', '{}'); // 只 state 无 inbox
    k.fs.setFile('D:/ws/.lantai/agents/agent-x/state.json', '{}');

    const store = new JsonMessageStore('D:/ws');
    const result = await store.restore();
    expect(result.size).toBe(0); // 有 state.json 的 agent 目录无 inbox = 常态，不恢复
    expect([...k.fs.files.keys()].some((p) => p.includes('agent-x/inbox.json'))).toBe(false);
  });

  it('inbox.json 损坏（JSON 解析失败）时保留文件并告警', async () => {
    freshFs();
    setupIsolation();
    const k = H.kernelFs!;
    k.fs.setFile('D:/ws/.lantai/agents/agent-x/inbox.json', '{{corrupted');

    const store = new JsonMessageStore('D:/ws');
    const result = await store.restore();
    expect(result.size).toBe(0);
    expect(k.fs.files.has('D:/ws/.lantai/agents/agent-x/inbox.json')).toBe(true);
  });
});
