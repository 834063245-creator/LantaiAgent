// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 折叠状态随卷恢复（2026-09-24 修）—— **重建句柄不丢折叠**。
//
// 病灶（真机实测）：`_compactSummary / _compactTailStart` 此前只在压缩时写
// （agent-compaction 的 applyCompactState）、newSession 时清，**没有任何恢复路径**读卷日志
// 里的 `session/compaction`。于是重开卷/重启后载荷回到满值：卷 39 压缩后 postTokens
// 22,378，重建 exe + 重启后同一卷载荷回到 295,017 —— 付过钱的摘要在下一次请求里白丢，
// 随后还要再压一次（与上一窗修的「账本不跨懒建恢复」efa8ddd0 同族）。
//
// 真源 = 卷日志的 `session/compaction`（SessionLog.compactionState 的投影：compaction
// 事件设置、非 adopt 的 reset 清除、retract 不清）。两条恢复路径都要接：
//   ① 开卷路径  loadSessionFromDisk
//   ② 惰性补建  ensureVolumeAgent（句柄是惰性资源——账本那一批已经为此付过学费）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPersistenceService } from '../src/composition/session-persistence-service';
import { Context } from '../src/cordis';
import { builtinSessionsPlugin } from '../src/plugins/builtin/sessions-builtin';

{
  // seam 装配：builtin provider 在册（卷读面经 sessionExecute 单点——与生产同链）
  const root = new Context();
  new SessionPersistenceService(root);
  await root.plugin(builtinSessionsPlugin);
}

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
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import * as Session from '../src/ui/chat-session';
import { logText } from './helpers/session-files';

const WS = 'D:/wsFoldRestore';
const SESSIONS = `${WS}/.lantai/sessions`;
const SUMMARY = '## 目标\n上一轮压缩留下的简报正文';
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

/** 真句柄工厂（恢复后的载荷要从真 Agent 上读，桩件测不出折叠）。 */
function installFactory(storeId: string): void {
  Session.setAgentFactory(storeId, async (sessionId: number) => {
    const runtime = new AgentRuntime();
    return (await runtime.createAgent({
      agentId: `fold-${storeId}-${sessionId}`,
      parentId: null,
      projectPath: WS,
      provider: textProvider('折叠恢复后的第一句'),
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
      eventSink: () => {},
      contextWindow: 8192,
      execState: Session.getSessionExecState(storeId, sessionId),
    })) as never;
  });
}

/** 会话 + 一条折叠事件（tailStart = 3：保留 [sys, 摘要, 二问, 二答]）。 */
function volumeWithFold(id: number, tailStart = 3): string {
  const base = logText(id, [sys, user('一问'), assistant('一答'), user('二问'), assistant('二答')]);
  const seq = base.split('\n').filter((l) => l.length > 0).length; // 头行 + 5 条事件 ⇒ 末序号 5
  return `${base}${JSON.stringify({ seq, ts: 9, kind: 'session/compaction', data: { summary: SUMMARY, tailStart } })}\n`;
}

/** 句柄内层（读折叠状态与载荷——两者都是 Agent 的运行时面）。 */
function innerOf(
  store: string,
  sid: number,
): {
  _compactTailStart: number;
  _compactSummary: string | null;
  payloadMessages(): Array<{ role: string; content?: string }>;
} {
  const handle = agentSessionState.getAgent(store, sid) as unknown as {
    _getAgent(): {
      _compactTailStart: number;
      _compactSummary: string | null;
      payloadMessages(): Array<{ role: string; content?: string }>;
    };
  };
  return handle._getAgent();
}

/** 断言折叠真的接回了句柄：载荷 = head + <compacted-context> + 尾部。 */
function expectFolded(store: string, sid: number, tailStart: number): void {
  const inner = innerOf(store, sid);
  const session = agentSessionState.getAgent(store, sid)?.getSession() ?? [];
  expect(inner._compactSummary).toBe(SUMMARY);
  expect(inner._compactTailStart).toBe(tailStart);
  const payload = inner.payloadMessages();
  expect(payload).toHaveLength(1 + 1 + (session.length - tailStart));
  expect(payload[1].content).toContain('<compacted-context>');
  expect(payload[1].content).toContain('上一轮压缩留下的简报正文');
}

describe('折叠状态随卷恢复：重建句柄不丢折叠（2026-09-24 修）', () => {
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

  it('① 惰性补建（ensureVolumeAgent）：折叠从卷日志接回句柄，载荷不再回到满值', async () => {
    const store = 'fold-lazy';
    agentSessionState.clearPanelState(store);
    installFactory(store);
    H.kernelFs?.fs.setFile(`${SESSIONS}/9.ndjson`, volumeWithFold(9));

    await expect(Session.ensureVolumeAgent(makeCtx(store), 9)).resolves.toBe(true);
    expectFolded(store, 9, 3);
    Session.setAgentFactory(store, null);
  }, 30_000);

  it('② 开卷路径（loadSessionFromDisk）：同一份日志、同一结果', async () => {
    const store = 'fold-open';
    agentSessionState.clearPanelState(store);
    installFactory(store);
    H.kernelFs?.fs.setFile(`${SESSIONS}/9.ndjson`, volumeWithFold(9));

    await expect(Session.loadSessionFromDisk(makeCtx(store), WS, 9)).resolves.toBe(true);
    expectFolded(store, 9, 3);
    Session.setAgentFactory(store, null);
  }, 30_000);

  it('③ 日志里没有折叠 ⇒ 不动（新卷语义，不凭空造摘要）', async () => {
    const store = 'fold-none';
    agentSessionState.clearPanelState(store);
    installFactory(store);
    H.kernelFs?.fs.setFile(
      `${SESSIONS}/9.ndjson`,
      logText(9, [sys, user('一问'), assistant('一答'), user('二问'), assistant('二答')]),
    );

    await expect(Session.ensureVolumeAgent(makeCtx(store), 9)).resolves.toBe(true);
    const inner = innerOf(store, 9);
    expect(inner._compactSummary).toBeNull();
    expect(inner._compactTailStart).toBe(-1);
    // 载荷 = 完整历史（head 之后直接是第一条来文）
    const payload = inner.payloadMessages();
    expect(payload[1].content).toBe('一问');
    Session.setAgentFactory(store, null);
  }, 30_000);

  it('④ 钳制：日志里的 tailStart 越界（会话被撤回缩短）⇒ 夹到合法区间，不越界读', async () => {
    const store = 'fold-clamp';
    agentSessionState.clearPanelState(store);
    installFactory(store);
    H.kernelFs?.fs.setFile(`${SESSIONS}/9.ndjson`, volumeWithFold(9, 99));

    await expect(Session.ensureVolumeAgent(makeCtx(store), 9)).resolves.toBe(true);
    const inner = innerOf(store, 9);
    const session = agentSessionState.getAgent(store, 9)?.getSession() ?? [];
    expect(inner._compactTailStart).toBe(session.length); // 夹到会话长度（尾部为空）
    expect(inner.payloadMessages()).toHaveLength(1 + 1);
    Session.setAgentFactory(store, null);
  }, 30_000);
});
