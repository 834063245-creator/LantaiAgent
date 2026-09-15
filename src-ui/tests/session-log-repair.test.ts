// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Phase 2 恢复链钉测（DSH core/session repair.ts 的兰台形）：
//   ① 悬空工具调用的两种语义（已分发 = 副作用未知 / 未分发 = 没跑）与文案
//   ② 配平后 provider 转写合法（每个 tool_call 都有 tool 结果）
//   ③ 断尾识别与打开时截断修复 + 修复本身落盘
//   ④ 格式版本定向拒读（绝不覆写未来格式的日志）

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

type Ev = { seq: number; ts: number; kind: string; data: unknown };

/** 造事件序列（seq 自动续号）。 */
function evs(list: Array<{ kind: string; data: unknown }>): Ev[] {
  return list.map((e, i) => ({ seq: i + 1, ts: 1000 + i, kind: e.kind, data: e.data }));
}

/** 「模型宣布了两个调用，只有第一个有结果」的日志。 */
function danglingLog(): Ev[] {
  return evs([
    { kind: 'user/message', data: { message: { role: 'user', content: '跑两个命令' } } },
    {
      kind: 'assistant/text',
      data: {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_a', name: 'bash', arguments: '{"cmd":"ls"}' },
            { id: 'call_b', name: 'bash', arguments: '{"cmd":"rm -rf x"}' },
          ],
        },
      },
    },
    { kind: 'tool/call', data: { call: { id: 'call_a', name: 'bash', arguments: '{"cmd":"ls"}' } } },
    { kind: 'tool/call', data: { call: { id: 'call_b', name: 'bash', arguments: '{"cmd":"rm -rf x"}' } } },
    {
      kind: 'tool/result',
      data: { message: { role: 'tool', tool_call_id: 'call_a', name: 'bash', content: 'a.txt' } },
    },
  ]);
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

describe('Phase 2 悬空工具调用配平（纯函数）', () => {
  it('两种语义分清：已分发 = 副作用未知；未分发 = 没跑', async () => {
    const { danglingToolCalls, interruptedToolCallClosers, OUTCOME_UNKNOWN_TEXT, NOT_STARTED_TEXT } = await import(
      '../src/agent/session-log-repair'
    );
    const events = danglingLog() as never[];
    const dangling = danglingToolCalls(events);
    expect(dangling).toEqual([{ callId: 'call_b', name: 'bash', dispatched: true }]);

    const closers = interruptedToolCallClosers(events);
    expect(closers).toHaveLength(1);
    const ev = closers[0] as unknown as { seq: number; kind: string; data: { message: Record<string, unknown> } };
    expect(ev.kind).toBe('tool/result');
    expect(ev.seq).toBe(6); // 续在日志末尾
    expect(ev.data.message.tool_call_id).toBe('call_b');
    expect(ev.data.message.content).toBe(OUTCOME_UNKNOWN_TEXT);
    expect(String(ev.data.message.content)).toContain('副作用');

    // 只有 assistant 宣布、没有 tool/call 记录 → 未分发文案
    const announcedOnly = evs([
      {
        kind: 'assistant/text',
        data: {
          message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
        },
      },
    ]) as never[];
    const c2 = interruptedToolCallClosers(announcedOnly);
    expect(c2).toHaveLength(1);
    expect((c2[0] as unknown as { data: { message: { content: string } } }).data.message.content).toBe(
      NOT_STARTED_TEXT,
    );
  });

  it('配平后转写合法：每个 tool_call 都有配对 tool 消息；已平衡日志不补', async () => {
    const { interruptedToolCallClosers } = await import('../src/agent/session-log-repair');
    const events = danglingLog() as never[];
    const balanced = [...events, ...interruptedToolCallClosers(events)];
    // 用会话日志投影验证（与生产同一把尺子）
    const { SessionLog } = await import('../src/agent/session-log');
    const log = SessionLog.replay(balanced as never);
    const messages = log.deriveMessages() as Array<{
      role: string;
      tool_calls?: Array<{ id: string }>;
      tool_call_id?: string;
    }>;
    const announced = messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id));
    const answered = messages.filter((m) => m.role === 'tool').map((m) => String(m.tool_call_id));
    expect(announced.sort()).toEqual(answered.sort());
    // 已平衡 → 再算一次没有可补的
    expect(interruptedToolCallClosers(balanced)).toEqual([]);
  });

  it('孤儿 tool/call（宣布未落盘）：先补 assistant 宣布再补结果——转写仍合法', async () => {
    const { interruptedToolCallClosers, OUTCOME_UNKNOWN_TEXT } = await import('../src/agent/session-log-repair');
    // 崩溃形态：执行器已派发（tool/call 在盘上），流收尾的 assistant 消息还没落
    const events = evs([
      { kind: 'user/message', data: { message: { role: 'user', content: '跑一下' } } },
      { kind: 'tool/call', data: { call: { id: 'orphan1', name: 'bash', arguments: '{"cmd":"rm -rf y"}' } } },
    ]) as never[];

    const closers = interruptedToolCallClosers(events);
    expect(closers).toHaveLength(2);
    const [synth, result] = closers as unknown as Array<{ kind: string; data: Record<string, any> }>;
    // 合成的是「宣布」：assistant 消息带该调用的 tool_calls
    expect(synth.kind).toBe('assistant/text');
    expect(synth.data.message.role).toBe('assistant');
    expect(synth.data.message.tool_calls.map((c: { id: string }) => c.id)).toEqual(['orphan1']);
    // 结果是「副作用未知」（已分发）——文案仍是别盲重试
    expect(result.kind).toBe('tool/result');
    expect(result.data.message.content).toBe(OUTCOME_UNKNOWN_TEXT);

    // 投影后 provider 转写合法：tool 结果必有前置 assistant tool_calls
    const { SessionLog } = await import('../src/agent/session-log');
    const messages = SessionLog.replay([...events, ...closers] as never).deriveMessages() as Array<{
      role: string;
      tool_calls?: Array<{ id: string }>;
      tool_call_id?: string;
    }>;
    expect(messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id))).toEqual(['orphan1']);
    expect(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['orphan1']);
  });
});

describe('Phase 2 断尾修复与版本拒读（打开路径）', () => {
  it('末行不完整 → 截断到完整前缀 + 补悬空调用 + 修复落盘', async () => {
    const { openSessionLog, sessionLogPath } = await import('../src/app/chat/session-log-store');
    const target = sessionLogPath(ROOT, 41);
    const events = danglingLog();
    const complete = events.map((e) => JSON.stringify(e)).join('\n');
    // 头行 + 完整事件 + 半截记录（模拟写盘途中被杀）
    H.kernelFs!.fs.setFile(
      target,
      `${JSON.stringify({ type: 'session', version: 1, id: 41, createdAt: '2026-09-15T00:00:00.000Z' })}\n${complete}\n{"seq":6,"ts":10`,
    );

    const { SessionLog } = await import('../src/agent/session-log');
    const log = new SessionLog();
    const opened = await openSessionLog(log, {
      root: ROOT,
      sessionId: 41,
      header: { type: 'session', version: 1, id: 41, createdAt: 'x' },
    });

    expect(opened.adopted).toBe(true);
    expect(opened.repaired).toBe(true);
    expect(opened.closers).toBe(1);
    // 截断发生（半截记录被丢弃：每一行都能解析 = 没有残片）+ 补的 tool/result 已落盘
    const raw = H.kernelFs!.fs.files.get(target)!;
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines).toHaveLength(7); // 头行 + 5 事件 + 1 补的收尾
    const last = JSON.parse(lines.at(-1)!) as Ev;
    expect(last.kind).toBe('tool/result');
    expect(last.seq).toBe(6);
    // 可见化：两条 warn（断尾 + 恢复）
    expect(logSpies.warn).toHaveBeenCalled();
    // 内存日志与之逐行一致（真源 = 磁盘）
    expect(log.lastSeq).toBe(6);
  });

  it('格式版本更高 → 定向拒读（不截断、不覆写、不物化）', async () => {
    const { openSessionLog, loadSessionLogFile, SessionLogFormatUnsupportedError, sessionLogPath } = await import(
      '../src/app/chat/session-log-store'
    );
    const target = sessionLogPath(ROOT, 42);
    const future = `${JSON.stringify({ type: 'session', version: 2, id: 42, createdAt: 'x' })}\n{"seq":1}\n`;
    H.kernelFs!.fs.setFile(target, future);

    await expect(loadSessionLogFile(ROOT, 42)).rejects.toBeInstanceOf(SessionLogFormatUnsupportedError);
    const { SessionLog } = await import('../src/agent/session-log');
    const log = new SessionLog();
    await expect(
      openSessionLog(log, {
        root: ROOT,
        sessionId: 42,
        header: { type: 'session', version: 1, id: 42, createdAt: 'x' },
      }),
    ).rejects.toThrow(/v2 格式/);
    // 原文件一个字节都没动（绝不覆写未来格式的日志）
    expect(H.kernelFs!.fs.files.get(target)).toBe(future);
  });

  it('序号断裂 → 截到断裂前的完整前缀（不静默接受坏段）', async () => {
    const { openSessionLog, sessionLogPath } = await import('../src/app/chat/session-log-store');
    const target = sessionLogPath(ROOT, 43);
    const good = `${JSON.stringify({ type: 'session', version: 1, id: 43, createdAt: 'x' })}\n${JSON.stringify({ seq: 1, ts: 1, kind: 'user/message', data: { message: { role: 'user', content: 'ok' } } })}\n`;
    H.kernelFs!.fs.setFile(target, `${good}${JSON.stringify({ seq: 5, ts: 2, kind: 'user/message', data: {} })}\n`);

    const { SessionLog } = await import('../src/agent/session-log');
    const log = new SessionLog();
    const opened = await openSessionLog(log, {
      root: ROOT,
      sessionId: 43,
      header: { type: 'session', version: 1, id: 43, createdAt: 'x' },
    });
    expect(opened.repaired).toBe(true);
    expect(opened.events).toBe(1);
    expect(log.lastSeq).toBe(1);
    expect(H.kernelFs!.fs.files.get(target)).toBe(good);
  });
});
