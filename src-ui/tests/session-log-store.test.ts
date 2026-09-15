// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Phase 1（DSH 参照移植）事件日志写面钉测：
//   ① 写后队列：固定窗口合并、flush 静默屏障、失败整批回灌+暂停+上报、并发 flush 合并
//   ② 日志落盘：首批物化（头行 + 当时全部事件，一次原子写）、此后 durable append、
//      flush 之后磁盘上就是完整前缀（检查点的天花板语义）
//   ③ 加载器：有日志 → restoreInPlace + continue（不覆写崩溃尾巴）；无日志 → materialize
//   ④ 可见性：背景写失败 warn（不静默）+ 不丢事件

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPersistenceService } from '../src/composition/session-persistence-service';
import { Context } from '../src/cordis';
import { builtinSessionsPlugin } from '../src/plugins/builtin/sessions-builtin';

{
  const root = new Context();
  new SessionPersistenceService(root);
  await root.plugin(builtinSessionsPlugin);
}

import { kernelReadFileRaw } from '../src/rpc-contract';

void kernelReadFileRaw;

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
  invoke: null as null | ReturnType<typeof vi.fn>,
}));

vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => H.invoke?.(...args),
  listen: vi.fn(),
  isMockMode: () => false,
  watchWindowClose: vi.fn(async () => () => {}),
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock({ wrapWithSpies: true });
  return { ...actual, ...H.kernelFs.overrides };
});

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/app-shell', () => ({
  shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() },
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: logSpies.info, warn: logSpies.warn, error: logSpies.error, debug: logSpies.debug },
}));

const ROOT = 'D:/ws/.lantai/sessions';
const HEADER = { type: 'session' as const, version: 1 as const, id: 7, createdAt: '2026-09-15T00:00:00.000Z' };

/** 造一条带 n 条事件的内存日志（seq 从 1 起——与 SessionLog 同规）。 */
async function makeLog(nEvents: number) {
  const { SessionLog } = await import('../src/agent/session-log');
  const log = new SessionLog();
  for (let i = 0; i < nEvents; i++) log.append('user/message', { message: { role: 'user', content: `m${i}` } });
  return log;
}

function fileLines(path: string): string[] {
  const raw = H.kernelFs!.fs.files.get(path);
  if (raw === undefined) return [];
  return raw.split('\n').filter((l) => l.length > 0);
}

beforeEach(() => {
  vi.useRealTimers();
  const k = H.kernelFs!;
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.fail = {};
  H.invoke = vi.fn(async () => 'ok');
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Phase 1 写后队列（SessionLogWriteBehind，DSH 语义）', () => {
  it('固定窗口合并：窗口内到达的事件落成一批；flush 立即排空', async () => {
    const { SessionLogWriteBehind } = await import('../src/agent/session-log-write-behind');
    const batches: number[] = [];
    const queue = new SessionLogWriteBehind({
      maxDelayMs: 30,
      write: async (events) => {
        batches.push(events.length);
      },
      reportBackgroundFailure: vi.fn(),
    });
    const ev = (seq: number) => ({ seq, ts: 0, kind: 'user/message' as const, data: {} }) as never;
    queue.enqueue(ev(1));
    queue.enqueue(ev(2));
    queue.enqueue(ev(3));
    expect(queue.hasWork).toBe(true);
    await queue.flush();
    // 三条合并成一批（而不是三次写），flush 返回即队列空
    expect(batches).toEqual([3]);
    expect(queue.hasWork).toBe(false);
    expect(queue.pendingCount).toBe(0);
  });

  it('失败整批回灌队首 + 暂停自动写 + 上报；下次 flush 重试成功', async () => {
    const { SessionLogWriteBehind } = await import('../src/agent/session-log-write-behind');
    const reported: unknown[] = [];
    const attempts: number[][] = [];
    let failNext = true;
    const queue = new SessionLogWriteBehind({
      maxDelayMs: 20,
      write: async (events) => {
        attempts.push(events.map((e) => e.seq));
        if (failNext) {
          failNext = false;
          throw new Error('磁盘抖动');
        }
      },
      reportBackgroundFailure: (e) => reported.push(e),
    });
    const ev = (seq: number) => ({ seq, ts: 0, kind: 'user/message' as const, data: {} }) as never;
    queue.enqueue(ev(1));
    queue.enqueue(ev(2));

    // 自动路径失败：不 reject 生产者，但上报（可见）
    await new Promise((r) => setTimeout(r, 60));
    expect(reported.length).toBe(1);
    expect(attempts[0]).toEqual([1, 2]);
    // 事件没丢：仍在队列里
    expect(queue.pendingCount).toBe(2);

    // 显式 flush 重试：同一批按原顺序再发一次
    await queue.flush();
    expect(attempts[1]).toEqual([1, 2]);
    expect(queue.pendingCount).toBe(0);
  });

  it('并发 flush 共享同一屏障（不各自起一轮写）', async () => {
    const { SessionLogWriteBehind } = await import('../src/agent/session-log-write-behind');
    let writes = 0;
    const queue = new SessionLogWriteBehind({
      maxDelayMs: 1000,
      write: async () => {
        writes += 1;
        await new Promise((r) => setTimeout(r, 10));
      },
      reportBackgroundFailure: vi.fn(),
    });
    queue.enqueue({ seq: 1, ts: 0, kind: 'user/message', data: {} } as never);
    const a = queue.flush();
    const b = queue.flush();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(writes).toBe(1);
  });
});

describe('Phase 1 事件日志落盘（materialize → durable append）', () => {
  it('首批物化头行 + 当时全部事件（一次原子写），此后增量 append 且 flush 后即完整前缀', async () => {
    const { attachSessionLogStore } = await import('../src/app/chat/session-log-store');
    const log = await makeLog(3); // 构造期已有 3 条事件
    const target = `${ROOT}/7.ndjson`;
    const store = attachSessionLogStore(log, { root: ROOT, sessionId: 7, header: HEADER, maxDelayMs: 1000 });
    expect(store.sessionId).toBe(7);

    // 惰性物化（DSH create() 同规：只有首个**新**事件才产生产物）——
    // 尚未有新增事件时队列为空，flush 无操作、盘上无文件。
    await store.flush();
    expect(H.kernelFs!.fs.files.has(target)).toBe(false);
    const initialWrites = H.kernelFs!.fs.writes.length;

    // 首个新事件 → 物化：头行 + 当时日志全部事件（构造期那 3 条不会丢）
    log.append('user/message', { message: { role: 'user', content: 'm3' } });
    await store.flush();
    const firstLines = fileLines(target);
    expect(JSON.parse(firstLines[0]).type).toBe('session');
    expect(firstLines.length).toBe(5); // 头行 + 4 条事件
    expect(JSON.parse(firstLines[4]).data.message.content).toBe('m3');
    // 物化走整体写（原子替换），一次写完 —— 不是 append
    expect(H.kernelFs!.fs.writes.length).toBe(initialWrites + 1);

    // 之后新事件 = 增量 append（只写新增那一行）
    log.append('assistant/text', { message: { role: 'assistant', content: 'reply' } });
    await store.flush();
    const afterLines = fileLines(target);
    expect(afterLines.length).toBe(6);
    expect(JSON.parse(afterLines[5]).kind).toBe('assistant/text');
    expect(H.kernelFs!.fs.writes.length).toBe(initialWrites + 2);
    expect(H.kernelFs!.fs.writes.at(-1)?.content.split('\n').filter(Boolean).length).toBe(1);
    expect(store.stats()).toEqual({ batches: 2, events: 5, failures: 0 });
  });

  it('打开已有日志：restoreInPlace + continue（不写头行、不覆写崩溃尾巴）', async () => {
    const { openSessionLog, sessionLogPath } = await import('../src/app/chat/session-log-store');
    const target = sessionLogPath(ROOT, 9);
    // 预置一份「上次运行」的日志（头行 + 2 条事件）
    H.kernelFs!.fs.setFile(
      target,
      `${JSON.stringify({ ...HEADER, id: 9 })}\n` +
        `${JSON.stringify({ seq: 1, ts: 1, kind: 'user/message', data: { message: { role: 'user', content: 'old-1' } } })}\n` +
        `${JSON.stringify({ seq: 2, ts: 2, kind: 'assistant/text', data: { message: { role: 'assistant', content: 'old-2' } } })}\n`,
    );
    const { SessionLog } = await import('../src/agent/session-log');
    const log = new SessionLog();
    log.append('preset/selected', { presetId: 'standard' }); // 构造期事件（seq 1，将被真源覆盖）

    const opened = await openSessionLog(log, { root: ROOT, sessionId: 9, header: { ...HEADER, id: 9 } });
    expect(opened.adopted).toBe(true);
    expect(opened.events).toBe(2);
    // 日志已置回磁盘真源（seq 2 = old-2）
    expect(log.lastSeq).toBe(2);
    expect((log.events()[1].data as { message: { content: string } }).message.content).toBe('old-2');

    // 追加新事件 → 接在尾部（seq 3），且不重写头行
    log.append('user/message', { message: { role: 'user', content: 'new' } });
    const { flushSessionLog } = await import('../src/app/chat/session-log-store');
    const before = H.kernelFs!.fs.writes.length;
    await flushSessionLog(log);
    const lines = fileLines(target);
    expect(lines.length).toBe(4);
    expect(JSON.parse(lines[3]).seq).toBe(3);
    // continue 姿态：只 append，不再写头行/整体物化
    expect(H.kernelFs!.fs.writes.length).toBe(before + 1);
    expect(H.kernelFs!.fs.writes.at(-1)?.content.split('\n').filter(Boolean).length).toBe(1);
  });

  it('无日志文件：materialize（头行 + 全部事件）；背景写失败可见且不丢事件', async () => {
    const { attachSessionLogStore, flushSessionLog } = await import('../src/app/chat/session-log-store');
    const log = await makeLog(1);
    const store = attachSessionLogStore(log, {
      root: ROOT,
      sessionId: 11,
      header: { ...HEADER, id: 11 },
      maxDelayMs: 20,
    });

    // 注入写失败：**自动路径**（窗口到）失败 → 上报可见（不静默）+ 事件不丢
    H.kernelFs!.fs.fail.write = '磁盘满';
    log.append('user/message', { message: { role: 'user', content: 'x' } });
    await new Promise((r) => setTimeout(r, 80));
    expect(logSpies.warn).toHaveBeenCalled();
    expect(store.stats().failures).toBe(1);
    expect(H.kernelFs!.fs.files.has(`${ROOT}/11.ndjson`)).toBe(false);
    expect(store.hasWork()).toBe(true); // 批次已回灌，等重试

    // 显式 flush 失败会把错误抛给调用方（退出/检查点据它可见化）
    await expect(store.flush()).rejects.toThrow('磁盘满');

    // 恢复后重试：事件仍在（没丢），一次物化落盘
    H.kernelFs!.fs.fail.write = '';
    await flushSessionLog(log);
    const lines = fileLines(`${ROOT}/11.ndjson`);
    expect(lines.length).toBe(3); // 头行 + 2 条事件（构造 1 + 新 1）
    expect(store.hasWork()).toBe(false);
  });
});
