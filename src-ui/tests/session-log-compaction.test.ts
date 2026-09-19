// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 撤回即压实（A 案，2026-09-19）——「改 / 重发」之后**旧内容不再留在卷文件里**。
// 立项件：`docs/plans/session-log-erasure-plan.md`（判定）+
// `docs/plans/session-tree-plan.md` §12.9（设计裁定）。
//
// 判据（逐条钉住）：
//   ① 撤回后 `.ndjson` 里**搜不到**旧内容（字节级 `includes`），事件数真的减少；
//   ② 头行 `erased` 账声明被抹除的 seq 段；重开这一卷 ⇒ 投影 = 撤回后、锚点同长同序；
//   ③ 中段压实（adopt 事件在其后）⇒ 空洞在中间，重开照常；
//   ④ **无落盘面 ⇒ 不压实**（退回「只记区间」旧语义——压实的目标是盘面）；
//   ⑤ **fail-closed**：锚点不可抹（整段替换的锚）⇒ 不压实 + 真实区间事件；
//   ⑥ **写失败 = 未落定**（文件保持原样）+ 下个 flush 重试后落定；
//   ⑦ 枝卷继承裁剪后的抹除账（否则子卷文件被判「序号断裂」而截断）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPersistenceService } from '../src/composition/session-persistence-service';
import { Context } from '../src/cordis';
import { builtinSessionsPlugin } from '../src/plugins/builtin/sessions-builtin';
import { logText } from './helpers/session-files';

{
  // seam 装配：builtin provider 在册（卷写面经 sessionExecute 单点——与生产同链）
  const root = new Context();
  new SessionPersistenceService(root);
  await root.plugin(builtinSessionsPlugin);
}

// 触发 rpc-contract 的 vi.mock 工厂求值（同 session-branch.test.ts 注）
import { kernelReadFileRaw } from '../src/rpc-contract';

void kernelReadFileRaw;

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/bridge', () => ({
  rpc: vi.fn(async () => '{}'),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
  watchWindowClose: vi.fn(async () => () => {}),
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/settings', () => ({
  loadSettings: () => ({ display: { language: 'zh', fontScale: 1 }, agent: {}, providers: [] }),
  getActiveProvider: () => ({ name: 'none', kind: 'openai', apiKey: '' }),
  modelContextWindow: () => 8192,
  providerId: (name: string) => name,
  saveSettings: vi.fn(),
  restoreSecrets: (s: unknown) => s,
  persistSecrets: vi.fn(),
}));
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/app-shell', () => ({
  shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() },
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));

import { agentSessionState } from '../src/agent/agent-session-state';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import type { SessionLog } from '../src/agent/session-log';
import { ToolRegistry } from '../src/agent/tool';
import { createBranchVolume } from '../src/app/chat/session-branch';
import { flushSessionLog, loadSessionLogFile, sessionLogPath } from '../src/app/chat/session-log-store';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import * as Session from '../src/ui/chat-session';
import { msgStoreFor } from '../src/ui/chat-store';

const WS = 'D:/wsCompaction';
const SESSIONS = `${WS}/.lantai/sessions`;
const sys = { role: 'system', content: 'sys' };
const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });

function makeCtx(storeId: string): Session.SessionContext {
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
  } as unknown as Session.SessionContext;
}

function textProvider(text: string): Provider {
  return {
    name: () => 'mock',
    model: () => 'mock',
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        yield { type: ChunkType.Text, text };
        yield { type: ChunkType.Done };
      })(),
  };
}

function installFactory(storeId: string): void {
  Session.setAgentFactory(storeId, async (sessionId: number) => {
    const runtime = new AgentRuntime();
    return (await runtime.createAgent({
      agentId: `main-${storeId}-${sessionId}`,
      parentId: null,
      projectPath: WS,
      provider: textProvider('压实后的第一句'),
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
      eventSink: () => {},
      contextWindow: 8192,
      execState: Session.getSessionExecState(storeId, sessionId),
    })) as never;
  });
}

function volumeText(sid: number): string {
  return H.kernelFs?.fs.files.get(`${SESSIONS}/${sid}.ndjson`) ?? '';
}

function volumeLines(sid: number): string[] {
  return volumeText(sid)
    .split('\n')
    .filter((l) => l.length > 0);
}

function volumeHeader(sid: number): Record<string, unknown> {
  return JSON.parse(volumeLines(sid)[0] ?? '{}') as Record<string, unknown>;
}

/** 撤回一卷里最后一条来文那一轮（= 生产「改 / 重发」的撤回半边）。 */
async function retractLastTurn(store: string, sid: number): Promise<boolean> {
  const ui = msgStoreFor(store, sid).getState().messages;
  const users = ui.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  if (!last) throw new Error('没有可撤回的来文');
  const ok = Session.retractUserMessage(makeCtx(store), last as never);
  await flushSessionLog(agentSessionState.getAgent(store, sid)?.sessionLog ?? null);
  return ok;
}

describe('撤回即压实（A 案）：旧内容不再留在卷文件里', () => {
  beforeEach(() => {
    const fs = H.kernelFs?.fs;
    if (fs) {
      fs.files.clear();
      fs.dirs.clear();
      fs.writes.length = 0;
      fs.fail = {};
    }
    Session.resetSessionListCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('① 撤回最后一轮 ⇒ 文件里搜不到旧内容、事件数减少、头行记账；重开 = 撤回后的内容', async () => {
    const store = 'compact-1';
    agentSessionState.clearPanelState(store);
    installFactory(store);
    H.kernelFs?.fs.setFile(
      `${SESSIONS}/1.ndjson`,
      logText(1, [sys, user('第一问'), assistant('第一答'), user('被抹掉的问'), assistant('被抹掉的答')]),
    );
    expect(await Session.loadSessionFromDisk(makeCtx(store), WS, 1)).toBe(true);
    await flushSessionLog(agentSessionState.getAgent(store, 1)?.sessionLog ?? null);
    const before = volumeText(1);
    expect(before).toContain('被抹掉的问');
    const log = agentSessionState.getAgent(store, 1)?.sessionLog;
    if (!log) throw new Error('无日志');
    const anchorsBefore = log.deriveMessageAnchors();

    expect(await retractLastTurn(store, 1)).toBe(true);

    // ① 文件里搜不到旧内容（这是用户按下「改」时要的结果）
    const after = volumeText(1);
    expect(after).not.toContain('被抹掉的问');
    expect(after).not.toContain('被抹掉的答');
    expect(after).toContain('第一问'); // 没被撤回的部分照旧
    expect(volumeLines(1).length).toBeLessThan(volumeLines(1).length + 1); // 行数确实少了（下面按 seq 断言）

    // ② 头行 erased 账声明被抹除的 seq 段；撤回事件退化为 no-op（{0,0}）
    const header = volumeHeader(1);
    expect(Array.isArray(header.erased)).toBe(true);
    expect((header.erased as Array<{ from: number; to: number }>).length).toBe(1);
    const erased = (header.erased as Array<{ from: number; to: number }>)[0];
    expect(erased.to).toBeGreaterThan(erased.from);
    const kinds = volumeLines(1)
      .slice(1)
      .map((l) => JSON.parse(l) as { kind: string; seq: number; data: { fromIndex?: number; toIndex?: number } });
    const retract = kinds.find((e) => e.kind === 'session/retract');
    expect(retract?.data).toEqual({ fromIndex: 0, toIndex: 0 });
    // 空洞确实存在（被抹除的 seq 不在文件里）
    const seqs = kinds.map((e) => e.seq);
    for (let s = erased.from; s <= erased.to; s++) expect(seqs).not.toContain(s);

    // 内存投影 = 撤回后的会话（T1 等价），锚点前缀不变
    expect(JSON.stringify(log.deriveMessages())).toBe(
      JSON.stringify(agentSessionState.getAgent(store, 1)?.getSession()),
    );
    const anchorsAfter = log.deriveMessageAnchors();
    expect(anchorsAfter.length).toBe(anchorsBefore.length - 2);
    expect(anchorsAfter.slice(0, 2)).toEqual(anchorsBefore.slice(0, 2));

    // 重开这一卷（模拟重启）：内容 = 撤回后，且能正常认领（空洞被账声明）
    agentSessionState.clearPanelState(store);
    expect(await Session.loadSessionFromDisk(makeCtx(store), WS, 1)).toBe(true);
    const reloaded = msgStoreFor(store, 1).getState().messages;
    expect(reloaded.some((m) => (m as unknown as { text?: string }).text === '被抹掉的问')).toBe(false);
    expect(reloaded.some((m) => (m as unknown as { text?: string }).text === '第一问')).toBe(true);
  }, 30_000);

  it('③ 中段压实：adopt 事件在被抹除段之后 ⇒ 空洞在中间，重开照常', async () => {
    const store = 'compact-2';
    agentSessionState.clearPanelState(store);
    installFactory(store);
    H.kernelFs?.fs.setFile(
      `${SESSIONS}/1.ndjson`,
      logText(1, [sys, user('第一问'), assistant('第一答'), user('第二问'), assistant('第二答')]),
    );
    expect(await Session.loadSessionFromDisk(makeCtx(store), WS, 1)).toBe(true);
    await flushSessionLog(agentSessionState.getAgent(store, 1)?.sessionLog ?? null);

    // 开卷时的 adopt 事件在尾部（seq 最大）⇒ 被抹除段（第二轮的来源事件）夹在它之前
    const adoptSeq = volumeLines(1)
      .slice(1)
      .map((l) => JSON.parse(l) as { kind: string; seq: number })
      .filter((e) => e.kind === 'session/reset')
      .at(-1)?.seq;
    expect(await retractLastTurn(store, 1)).toBe(true);

    const lines = volumeLines(1)
      .slice(1)
      .map((l) => JSON.parse(l) as { kind: string; seq: number });
    expect(volumeText(1)).not.toContain('第二问');
    // 中段空洞：被抹除段之后仍有事件（adopt 还在场）
    const erased = (volumeHeader(1).erased as Array<{ from: number; to: number }>)[0];
    expect(lines.some((e) => e.seq > erased.to)).toBe(true);
    expect(lines.some((e) => e.seq === adoptSeq)).toBe(true);

    agentSessionState.clearPanelState(store);
    expect(await Session.loadSessionFromDisk(makeCtx(store), WS, 1)).toBe(true);
    const reloaded = msgStoreFor(store, 1).getState().messages;
    expect(reloaded.some((m) => (m as unknown as { text?: string }).text === '第一问')).toBe(true);
    expect(reloaded.some((m) => (m as unknown as { text?: string }).text === '第二问')).toBe(false);
  }, 30_000);

  it('④ 无落盘面 ⇒ 不压实（退回「只记区间」旧语义——压实的目标是盘面）', async () => {
    const runtime = new AgentRuntime();
    const agent = (await runtime.createAgent({
      agentId: 'compact-no-sink',
      parentId: null,
      projectPath: WS,
      provider: textProvider('x'),
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
      eventSink: () => {},
      contextWindow: 8192,
    })) as unknown as {
      _getAgent(): { setSession(m: unknown[]): void; retractTurnAt(i: number): void; getSessionLog(): SessionLog };
      dispose(): void;
    };
    const inner = agent._getAgent();
    inner.setSession([sys, user('一问'), assistant('一答')]);
    const before = inner.getSessionLog().size;
    inner.retractTurnAt(1);
    const log = inner.getSessionLog();
    // 未压实：事件只多了一条（真实区间的 retract），旧内容仍在日志里
    expect(log.size).toBe(before + 1);
    const retract = log.events().at(-1);
    expect(retract?.kind).toBe('session/retract');
    expect(retract?.data).toEqual({ fromIndex: 1, toIndex: 3 });
    agent.dispose();
  }, 30_000);

  it('⑤ fail-closed：锚点不可抹（整段替换的锚）⇒ 不压实 + 真实区间事件', async () => {
    const store = 'compact-3';
    agentSessionState.clearPanelState(store);
    installFactory(store);
    H.kernelFs?.fs.setFile(`${SESSIONS}/1.ndjson`, logText(1, [sys, user('一问'), assistant('一答')]));
    expect(await Session.loadSessionFromDisk(makeCtx(store), WS, 1)).toBe(true);
    const handle = agentSessionState.getAgent(store, 1) as unknown as {
      _getAgent(): { setSession(m: unknown[]): void; retractTurnAt(i: number): void; getSessionLog(): SessionLog };
    };
    // 整段替换：此后全部消息的锚点都是那条 session/reset（不可抹——抹它 = 抹那一整批）
    handle._getAgent().setSession([sys, user('替换后一问'), assistant('替换后一答')]);
    const log = handle._getAgent().getSessionLog();
    const before = log.size;
    handle._getAgent().retractTurnAt(1);
    expect(log.size).toBe(before + 1); // 只多了一条撤回事件 = 未压实
    expect(log.events().at(-1)?.data).toEqual({ fromIndex: 1, toIndex: 3 });
    await flushSessionLog(log);
    expect(volumeHeader(1).erased).toBeUndefined();
    expect(volumeText(1)).toContain('替换后一问'); // 原文还在（诚实降级：这一卷没抹）
  }, 30_000);

  it('⑥ 写失败 = 未落定（文件保持原样）+ 下个 flush 重试后落定', async () => {
    const store = 'compact-4';
    agentSessionState.clearPanelState(store);
    installFactory(store);
    H.kernelFs?.fs.setFile(
      `${SESSIONS}/1.ndjson`,
      logText(1, [sys, user('一问'), assistant('一答'), user('该被抹掉的'), assistant('该被抹掉的答')]),
    );
    expect(await Session.loadSessionFromDisk(makeCtx(store), WS, 1)).toBe(true);
    await flushSessionLog(agentSessionState.getAgent(store, 1)?.sessionLog ?? null);

    H.kernelFs!.fs.fail.write = '注入：磁盘拒绝写入';
    const ui = msgStoreFor(store, 1).getState().messages;
    const last = ui.filter((m) => m.role === 'user').at(-1);
    if (!last) throw new Error('没有可撤回的来文');
    expect(Session.retractUserMessage(makeCtx(store), last as never)).toBe(true);
    // 排空失败是预期（显式 flush 把失败抛给等待者——队列语义；这里吞掉只为继续断言）
    await flushSessionLog(agentSessionState.getAgent(store, 1)?.sessionLog ?? null).catch(() => {});
    // 盘面落后（撤回尚未落定）：旧内容还在文件里（诚实——写入失败可见）
    expect(volumeText(1)).toContain('该被抹掉的');

    // 故障解除 + 下个检查点 ⇒ 整写兑现（含重试期间落下的撤回事件）
    H.kernelFs!.fs.fail.write = undefined;
    await flushSessionLog(agentSessionState.getAgent(store, 1)?.sessionLog ?? null);
    expect(volumeText(1)).not.toContain('该被抹掉的');
    expect(Array.isArray(volumeHeader(1).erased)).toBe(true);
  }, 30_000);

  it('⑦ 枝卷继承裁剪后的抹除账（子卷文件不得被读路径判「序号断裂」）', async () => {
    const store = 'compact-5';
    agentSessionState.clearPanelState(store);
    installFactory(store);
    H.kernelFs?.fs.setFile(
      `${SESSIONS}/1.ndjson`,
      logText(1, [sys, user('第一问'), assistant('第一答'), user('第二问'), assistant('第二答')]),
    );
    expect(await Session.loadSessionFromDisk(makeCtx(store), WS, 1)).toBe(true);
    await flushSessionLog(agentSessionState.getAgent(store, 1)?.sessionLog ?? null);
    expect(await retractLastTurn(store, 1)).toBe(true);

    // 从压实的父卷立枝：子卷前缀带着同样的空洞 ⇒ 头行必须同账
    expect(await createBranchVolume(makeCtx(store), 1)).toMatchObject({ ok: true, sid: 2 });
    const childHeader = volumeHeader(2);
    expect(childHeader.erased).toEqual(volumeHeader(1).erased);
    // 子卷可正常读回（空洞被自己的账声明）
    const loaded = await loadSessionLogFile(SESSIONS, 2);
    expect(loaded?.stopReason).toBeNull();
    expect(loaded?.events.length).toBeGreaterThan(0);
  }, 30_000);

  it('⑨ 连撤两轮：抹除账累加（排序不重叠）+ 压实后继续 append 照常', async () => {
    const store = 'compact-6';
    agentSessionState.clearPanelState(store);
    installFactory(store);
    H.kernelFs?.fs.setFile(
      `${SESSIONS}/1.ndjson`,
      logText(1, [sys, user('第一问'), assistant('第一答'), user('第二问'), assistant('第二答')]),
    );
    expect(await Session.loadSessionFromDisk(makeCtx(store), WS, 1)).toBe(true);
    await flushSessionLog(agentSessionState.getAgent(store, 1)?.sessionLog ?? null);
    expect(await retractLastTurn(store, 1)).toBe(true);
    expect((volumeHeader(1).erased as unknown[]).length).toBe(1);

    // 压实后继续说话（append 落在整写之后）→ 再撤回这一轮 ⇒ 账累加。
    // 追加**两轮**：UI 面同步重建后撤回定位桥的戳（会话长度/界面来文数）必须与旧桥不同，
    // 否则会命中「戳巧合相同」的陈旧桥（既有尾对齐启发式，非本批引入——见 chat-session 注）。
    const handle = agentSessionState.getAgent(store, 1) as unknown as {
      _getAgent(): { _appendMessage(kind: string, message: unknown): void };
    };
    for (const [q, a] of [
      ['第三问', '第三答'],
      ['第四问', '第四答'],
    ]) {
      handle._getAgent()._appendMessage('user/message', { role: 'user', content: q });
      handle._getAgent()._appendMessage('assistant/text', { role: 'assistant', content: a });
    }
    // UI 面同步重建（`_appendMessage` 只动会话与日志——生产里由流式路径落 UI 块）
    Session._rebuildMessagesFromSession(makeCtx(store));
    await flushSessionLog(agentSessionState.getAgent(store, 1)?.sessionLog ?? null);
    expect(await retractLastTurn(store, 1)).toBe(true);

    const ledger = volumeHeader(1).erased as Array<{ from: number; to: number }>;
    expect(ledger.length).toBe(2);
    expect(ledger[0].to).toBeLessThan(ledger[1].from); // 有序且不重叠
    expect(volumeText(1)).not.toContain('第四问');
    expect(volumeText(1)).toContain('第三问');
    expect(volumeText(1)).toContain('第一问');

    agentSessionState.clearPanelState(store);
    expect(await Session.loadSessionFromDisk(makeCtx(store), WS, 1)).toBe(true);
    const texts = msgStoreFor(store, 1)
      .getState()
      .messages.map((m) => (m as unknown as { text?: string }).text);
    expect(texts).toContain('第一问');
    expect(texts).toContain('第三问');
    expect(texts).not.toContain('第四问');
  }, 30_000);

  it('⑧ 读路径：已声明的空洞照常认领；未声明的空洞仍是「序号断裂」（Phase-2 行为不变）', async () => {
    const withLedger = `${JSON.stringify({
      type: 'session',
      version: 1,
      id: 90,
      createdAt: 'x',
      erased: [{ from: 2, to: 3 }],
    })}\n${JSON.stringify({ seq: 1, ts: 1, kind: 'user/message', data: { message: { role: 'user', content: 'ok' } } })}\n${JSON.stringify({ seq: 4, ts: 2, kind: 'assistant/text', data: { message: { role: 'assistant', content: 'ok2' } } })}\n`;
    H.kernelFs!.fs.setFile(sessionLogPath(SESSIONS, 90), withLedger);
    const ok = await loadSessionLogFile(SESSIONS, 90);
    expect(ok?.stopReason).toBeNull();
    expect(ok?.events.map((e) => e.seq)).toEqual([1, 4]);

    // 同形文件但**无账** ⇒ 判断裂（掉行检测不被压实削弱）
    const noLedger = withLedger.replace(/,"erased":\[\{"from":2,"to":3\}\]/, '');
    H.kernelFs!.fs.setFile(sessionLogPath(SESSIONS, 91), noLedger);
    const bad = await loadSessionLogFile(SESSIONS, 91);
    expect(bad?.stopReason).toContain('序号断裂');
    expect(bad?.events.map((e) => e.seq)).toEqual([1]);
  }, 30_000);
});
