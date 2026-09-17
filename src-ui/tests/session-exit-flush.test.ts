// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P0 会话存盘止血（2026-09-15 存盘审计 docs/session-persistence-audit.md）——
// 六项「零覆盖保证」里本文件钉住四项：
//   ① 退出 flush：取消防抖（不重挂）+ 全卷显式落盘 + 逐卷结果可见（M7/M2）
//   ② 无句柄卷 = 可见跳过（不再静默 return——「卷还在但内容旧」的事故面，M6）
//   ③ 每卷写链：同卷并发写串行、旧快照不得最后落盘（M4 静默回滚）
//   ④ 空工作区路径响亮报错（不再拼出 CWD 相对的 /.lantai/sessions，M8）
//
// 走生产单点：ChatCore.flushSessionsForExit / saveSessionById（不复制编排逻辑
// 到测试里——测试与产品同一条链）。mock 面与 audit-fixes.test.ts 同款：站到
// rpc-contract 具名 helper 上（kernel-fs 内存盘）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPersistenceService } from '../src/composition/session-persistence-service';
import { Context } from '../src/cordis';
import { builtinSessionsPlugin } from '../src/plugins/builtin/sessions-builtin';

{
  // seam 装配：builtin provider 在册（卷写链经 sessionExecute 单点）
  const root = new Context();
  new SessionPersistenceService(root);
  await root.plugin(builtinSessionsPlugin);
}

// 触发 rpc-contract 的 vi.mock 工厂求值（同 audit-fixes.test.ts 注）
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
  // 关窗监听（P0）：本文件只钉 flush 写面与检查点语义（关窗三口接线见
  // tests/persistence-signal-routing.test.ts）——此处给空 unlisten。
  watchWindowClose: vi.fn(async () => () => {}),
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  // wrapWithSpies：kernelWriteFile 是 vi.fn——用例期可换「慢写」实现，复现
  // 「先发的写晚到」（无写链时旧快照会覆盖新快照）。
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

const WS = 'D:/ws';
const SESSIONS = `${WS}/.lantai/sessions`;
const sys = { role: 'system', content: 'sys' };

type Msg = { role: string; content: string };

/** 桩 Agent 句柄：消息数组可换（模拟「新一轮内容」）+ loop 事件可触发
 *  （onLoopEvent 能力位 = 触发点 A 的挂点）+ **真实事件日志**（Phase 1 换轨后
 *  检查点的落盘面是日志队列，不是快照——桩必须带 SessionLog 能力位）。 */
const { SessionLog: StubSessionLog } = await import('../src/agent/session-log');

function makeAgent(messages: Msg[]) {
  const state = { messages };
  const listeners = new Map<string, Array<(p: unknown) => void>>();
  const id = `agent-${Math.random().toString(36).slice(2, 8)}`;
  return {
    handle: {
      id,
      getSession: () => state.messages,
      dispose: vi.fn(),
      sessionLog: new StubSessionLog(),
      onLoopEvent: (event: string, fn: (p: unknown) => void) => {
        const arr = listeners.get(event) ?? [];
        arr.push(fn);
        listeners.set(event, arr);
        return () => {};
      },
    },
    setMessages: (m: Msg[]) => {
      state.messages = m;
    },
    /** 触发该 Agent 的 loop 事件（模拟 default-loop 的 emitLoopEvent）。 */
    fire: (event: string) => {
      for (const fn of listeners.get(event) ?? []) fn({ agentId: id });
    },
  };
}

/** 卷事件日志的落盘行（ndjson）。 */
function storedLogLines(sid: number): string[] {
  const raw = H.kernelFs!.fs.files.get(`${SESSIONS}/${sid}.ndjson`);
  return raw ? raw.split('\n').filter((l) => l.length > 0) : [];
}

/** 铺一卷案头：specs 里带 messages = 有句柄（有内容），不带 = 无句柄卷。 */
async function setupPanel(storeId: string, specs: Array<{ sid: number; messages?: Msg[] }>) {
  const { getChatStore } = await import('../src/ui/chat-store');
  const { agentSessionState } = await import('../src/agent/agent-session-state');
  getChatStore(storeId).sess.setState({
    sessions: specs.map((s) => ({ id: s.sid, label: `案卷 ${s.sid}` })),
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: Math.max(...specs.map((s) => s.sid)) + 1,
  });
  const agents = new Map<number, ReturnType<typeof makeAgent>>();
  for (const s of specs) {
    if (!s.messages) continue;
    const a = makeAgent(s.messages);
    agents.set(s.sid, a);
    agentSessionState.setAgent(storeId, s.sid, a.handle as never);
  }
  return agents;
}

/** 新建面板 + 铺卷 + 设定工作区路径（同一条生产链：ChatCore 读 shellStore.projectPath）。 */
async function setupChatCore(specs: Array<{ sid: number; messages?: Msg[] }>) {
  const { ChatCore } = await import('../src/app/chat/chat-core');
  const { useShellStore } = await import('../src/app/shell-store');
  const panel = new ChatCore();
  useShellStore.setState({ projectPath: WS });
  const agents = await setupPanel(panel.panelId, specs);
  return { panel, agents };
}

function volumeOnDisk(sid: number): { messages: Msg[] } | null {
  const raw = H.kernelFs!.fs.files.get(`${SESSIONS}/${sid}.json`);
  return raw ? (JSON.parse(raw) as { messages: Msg[] }) : null;
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

describe('P0 退出 flush（M2/M7）', () => {
  it('取消防抖（不重挂）+ 全部在案卷显式落盘 + 逐卷结果汇总', async () => {
    vi.useFakeTimers();
    const { panel } = await setupChatCore([
      { sid: 1, messages: [sys, { role: 'user', content: 'active-turn' }] },
      { sid: 2, messages: [sys, { role: 'user', content: 'background-turn' }] },
    ]);

    // 挂一个待触发的防抖写（模拟「轮次刚结束、500ms 窗口内退出」）
    panel.scheduleAutoSave(WS);

    const report = await panel.flushSessionsForExit();

    // 防抖被取消（旧实现 = clear + 重挂 500ms → 退出路径永不落盘）
    expect(report.cancelledDebounce).toBe(true);
    expect(report.total).toBe(2);
    expect(report.saved).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.anomalies).toEqual([]);

    expect(volumeOnDisk(1)?.messages.at(-1)?.content).toBe('active-turn');
    expect(volumeOnDisk(2)?.messages.at(-1)?.content).toBe('background-turn');

    // 推进时间不再产生额外写（重挂的实现会在这里多写一次 = 窗口已消失）
    const writesAfterFlush = H.kernelFs!.fs.writes.length;
    await vi.advanceTimersByTimeAsync(1200);
    expect(H.kernelFs!.fs.writes.length).toBe(writesAfterFlush);
  });

  it('无句柄卷 = 可见跳过（不再静默 return）', async () => {
    const { panel } = await setupChatCore([
      { sid: 11, messages: [sys, { role: 'user', content: 'has-handle' }] },
      { sid: 12 }, // 无句柄（未水合卷）——此前静默不落盘、零信号
    ]);

    const report = await panel.flushSessionsForExit();

    expect(report.saved).toBe(1);
    expect(report.anomalies.map((a) => `${a.sid}:${a.outcome}`)).toEqual(['12:skipped-no-handle']);
    // 可见面：warn（同键去重——autosave 高频不刷屏）
    expect(logSpies.warn).toHaveBeenCalled();
    const warnText = String(logSpies.warn.mock.calls.at(-1)?.[1] ?? '');
    expect(warnText).toContain('Agent 句柄缺席');
    // 有句柄那卷照常落盘
    expect(volumeOnDisk(11)).not.toBeNull();
    expect(volumeOnDisk(12)).toBeNull();
  });

  it('工作区路径为空 → 不落盘且可见（不拼出 CWD 相对路径）', async () => {
    const { ChatCore } = await import('../src/app/chat/chat-core');
    const { useShellStore } = await import('../src/app/shell-store');
    const panel = new ChatCore();
    useShellStore.setState({ projectPath: '' });
    await setupPanel(panel.panelId, [{ sid: 13, messages: [sys, { role: 'user', content: 'x' }] }]);

    const report = await panel.flushSessionsForExit();
    expect(report.anomalies.map((a) => a.outcome)).toEqual(['skipped-no-workspace']);
    expect(H.kernelFs!.fs.writes.length).toBe(0);
  });
});

describe('P0 每卷写链（M4：旧快照不得最后落盘）', () => {
  it('同卷并发写串行化：慢的旧快照不会覆盖后发的新快照', async () => {
    const { panel, agents } = await setupChatCore([{ sid: 21, messages: [sys, { role: 'user', content: 'v1' }] }]);

    // 写实现：第一次调用慢 60ms（复现「先发的写后到」）
    const writeMock = H.kernelFs!.overrides.kernelWriteFile as ReturnType<typeof vi.fn>;
    const defaultImpl = writeMock.getMockImplementation()!;
    let call = 0;
    writeMock.mockImplementation(async (p: string, c: string) => {
      call += 1;
      if (call === 1) await new Promise((r) => setTimeout(r, 60));
      return defaultImpl(p, c);
    });

    const first = panel.saveSessionById(21);
    // 首写仍在途 → 会话已进到新内容（真实时序：写盘慢于用户/模型的下一步）
    agents.get(21)!.setMessages([sys, { role: 'user', content: 'v2' }]);
    const second = panel.saveSessionById(21);

    expect(await Promise.all([first, second])).toEqual(['saved', 'saved']);

    // 写链保证顺序：v1 先落、v2 后落 → 盘上终态 = v2（无写链则慢写 v1 最后覆盖）
    const order = H.kernelFs!.fs.writes.filter((w) => w.file_path === `${SESSIONS}/21.json`).map(
      (w) => (JSON.parse(w.content) as { messages: Msg[] }).messages.at(-1)?.content,
    );
    expect(order).toEqual(['v1', 'v2']);
    expect(volumeOnDisk(21)?.messages.at(-1)?.content).toBe('v2');
  });

  it('写链失败不阻断后续写（写链不是门禁）', async () => {
    const { panel, agents } = await setupChatCore([{ sid: 22, messages: [sys, { role: 'user', content: 'a' }] }]);

    H.kernelFs!.fs.fail.write = '磁盘满';
    expect(await panel.saveSessionById(22)).toBe('failed');
    H.kernelFs!.fs.fail.write = '';
    agents.get(22)!.setMessages([sys, { role: 'user', content: 'b' }]);
    expect(await panel.saveSessionById(22)).toBe('saved');
    expect(volumeOnDisk(22)?.messages.at(-1)?.content).toBe('b');
  });
});

describe('P0 工作区路径守卫（M8）', () => {
  it('空工作区路径响亮报错，消费方降级为空集', async () => {
    const Session = await import('../src/ui/chat-session');
    expect(() => Session.workspaceSessionsDir('')).toThrow(/工作区路径为空/);
    // 路径非空即正常（仅剥尾部分隔符）
    expect(Session.workspaceSessionsDir('D:/ws/')).toBe(SESSIONS);
    // 消费方降级：发号对账不再拼出 CWD 相对路径（旧实现会扫 /.lantai/sessions）
    await expect(Session.scanMaxSessionId('')).resolves.toBe(0);
    await expect(Session.readVolumeData('', 1)).resolves.toBeNull();
  });
});

describe('触发点 A —— 模型请求前检查点（Phase 1 换轨后 = 排空事件日志队列）', () => {
  it('request/start → 该卷事件日志排空到盘（含用户已说的话）', async () => {
    const { panel, agents } = await setupChatCore([
      { sid: 31, messages: [sys, { role: 'user', content: '用户说的话' }] },
    ]);
    // 生产路径的事件日志接线 = chat-session.seedVolumeLog（此处直接调 openSessionLog，
    // 与 chat-session 走同一函数）
    const { openSessionLog } = await import('../src/app/chat/session-log-store');
    const stub = agents.get(31)!;
    const logInstance = stub.handle.sessionLog;
    expect(logInstance).toBeTruthy();
    await openSessionLog(logInstance, {
      root: SESSIONS,
      sessionId: 31,
      header: { type: 'session', version: 1, id: 31, createdAt: '2026-09-15T00:00:00.000Z' },
    });
    // 用户消息已经入了日志（模型可见事实），但还在 200ms 窗口里
    logInstance.append('user/message', { message: { role: 'user', content: '用户说的话' } });
    expect(H.kernelFs!.fs.files.has(`${SESSIONS}/31.ndjson`)).toBe(false);

    const { bootPersistence } = await import('../src/shell/rows/persistence');
    bootPersistence({ chatPanel: panel, workspace: null } as never);

    agents.get(31)!.fire('request/start');

    await vi.waitFor(() => expect(H.kernelFs!.fs.files.has(`${SESSIONS}/31.ndjson`)).toBe(true));
    const lines = storedLogLines(31);
    expect(JSON.parse(lines[0]).type).toBe('session');
    expect(JSON.parse(lines.at(-1)!).data.message.content).toBe('用户说的话');
  });

  it('在途检查点合并：同一卷不并发重写（慢写期间第二次请求不重复落盘）', async () => {
    const { panel, agents } = await setupChatCore([{ sid: 32, messages: [sys, { role: 'user', content: 'v1' }] }]);
    const { openSessionLog } = await import('../src/app/chat/session-log-store');
    const stub = agents.get(32)!;
    await openSessionLog(stub.handle.sessionLog, {
      root: SESSIONS,
      sessionId: 32,
      header: { type: 'session', version: 1, id: 32, createdAt: '2026-09-15T00:00:00.000Z' },
    });
    stub.handle.sessionLog.append('user/message', { message: { role: 'user', content: 'v1' } });

    // 首写慢（60ms）：期间第二次 request/start 落到同一屏障上，不产生第二批
    const writeMock = H.kernelFs!.overrides.kernelWriteFile as ReturnType<typeof vi.fn>;
    const defaultImpl = writeMock.getMockImplementation()!;
    writeMock.mockImplementation(async (p: string, c: string) => {
      await new Promise((r) => setTimeout(r, 60));
      return defaultImpl(p, c);
    });

    const { bootPersistence } = await import('../src/shell/rows/persistence');
    bootPersistence({ chatPanel: panel, workspace: null } as never);

    const agent = agents.get(32)!;
    agent.fire('request/start');
    agent.handle.sessionLog.append('assistant/text', { message: { role: 'assistant', content: 'v2' } });
    agent.fire('request/start');

    await vi.waitFor(() => expect(H.kernelFs!.fs.files.has(`${SESSIONS}/32.ndjson`)).toBe(true));
    await new Promise((r) => setTimeout(r, 200));
    // 两条事件各落一次：物化一次（头行 + v1）+ 增量 append 一次（v2 一行）——
    // 并发检查点共享队列屏障，不重复写前缀（旧实现每次检查点重写全量快照）。
    const writes = H.kernelFs!.fs.writes.filter((w) => w.file_path === `${SESSIONS}/32.ndjson`);
    expect(writes.length).toBe(2);
    expect(writes[1].content.split('\n').filter((l) => l.length > 0).length).toBe(1);
    const lines = storedLogLines(32);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines.at(-1)!).data.message.content).toBe('v2');
    // 序号严格递增且无重复（重放面的硬前提）
    expect(lines.slice(1).map((l) => JSON.parse(l).seq)).toEqual([1, 2]);
  });
});
