// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话树「枝」（P1：从卷尾立枝）——立项件 `docs/plans/session-tree-plan.md` §7 的
// 验收判据逐条钉住：
//   ① 新卷头行带 `parent`，事件 = 父卷前缀的**字节同源副本**（开卷后才多一条 adopt）
//   ② 打开它，内容与父卷切点一致（UI 消息 + 真 Agent 的会话两面都断言）
//   ③ **父卷文件字节零变化**（立枝不改父卷——非破坏性是本功能的立身之本）
//   ④ 血缘在盘上（头行 write-once ⇒ 重启后仍在）
//   ⑤ 继承区内立枝 → 边归到**上层卷**（plan §1.3 归一化；不做则树画错 + 删除连坐删错子树）
// 另钉三条切点纪律的**拒态**（未落定 / 断尾 / 空卷 / 缺卷）：拒态**一个字节都不落盘**
// ——绝不制造「半个枝」。

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

// 触发 rpc-contract 的 vi.mock 工厂求值（同 session-exit-flush.test.ts 注）
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
import { ToolRegistry } from '../src/agent/tool';
import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import {
  createBranchVolume,
  deleteBranchSubtrees,
  deriveBranchPoints,
  loadBranchLineage,
  planBranchDelete,
  resolveBranchOrigin,
  resolveBranchPoint,
} from '../src/app/chat/session-branch';
import { flushSessionLog } from '../src/app/chat/session-log-store';
import { useShellStore } from '../src/app/shell-store';
import { SpaceService } from '../src/composition/space-service';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import type { SessionContext } from '../src/ui/chat-session';
import * as Session from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

const WS = 'D:/wsBranch';
const SESSIONS = `${WS}/.lantai/sessions`;
const sys = { role: 'system', content: 'sys' };
const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });

/** 最小 SessionContext（同 session-exec-single-authority.test.ts：立枝/开卷只用
 *  storeId/getProjectPath + 这几个 UI 回调，其余能力位缺席 ⇒ 走降级分支）。 */
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

function resetPanel(storeId: string): void {
  agentSessionState.clearPanelState(storeId);
  getChatStore(storeId).sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
}

/** 连坐删除（单卷真删由调用层注入——与 `ChatCore.deleteSessionWithBranches` 同形）。 */
function cascade(store: string, ids: number[]) {
  const ctx = makeCtx(store);
  return deleteBranchSubtrees(store, WS, ids, (sid) => Session.deleteSessionFile(ctx, WS, sid));
}

function setVolume(sid: number, text: string): void {
  H.kernelFs?.fs.setFile(`${SESSIONS}/${sid}.ndjson`, text);
}

function volumeText(sid: number): string | undefined {
  return H.kernelFs?.fs.files.get(`${SESSIONS}/${sid}.ndjson`);
}

function volumeLines(sid: number): string[] {
  const raw = volumeText(sid) ?? '';
  return raw.split('\n').filter((l) => l.length > 0);
}

function volumeHeader(sid: number): Record<string, unknown> {
  return JSON.parse(volumeLines(sid)[0] ?? '{}') as Record<string, unknown>;
}

/** 跑一轮就结束的 provider（真 Agent 装配用）。 */
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

/** 装一个「镜像 workspace 会话工厂」的句柄工厂（真 runtime + 真 Agent）。 */
function installFactory(storeId: string): void {
  Session.setAgentFactory(storeId, async (sessionId: number) => {
    const runtime = new AgentRuntime();
    return (await runtime.createAgent({
      agentId: `main-${storeId}-${sessionId}`,
      parentId: null,
      projectPath: WS,
      provider: textProvider('枝上的第一句'),
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
      eventSink: () => {},
      contextWindow: 8192,
      execState: Session.getSessionExecState(storeId, sessionId),
    })) as never;
  });
}

describe('会话树「枝」——从卷尾立枝', () => {
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

  it('① 前缀字节同源 + 头行血缘 + 组合继承：新枝 = 父卷前缀的复制，父卷零改动', async () => {
    const store = 'branch-1';
    resetPanel(store);
    setVolume(1, logText(1, [sys, user('一'), assistant('二')], '2026-01-01T00:00:00Z', 'standard'));
    const parentBefore = volumeText(1);

    const result = await createBranchVolume(makeCtx(store), 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sid).toBe(2);

    // 事件行逐字节同源（父卷前缀的复制——同一份 seq 空间，切点在父子两侧同号）
    expect(volumeLines(2).slice(1)).toEqual(volumeLines(1).slice(1));
    const header = volumeHeader(2);
    expect(header.id).toBe(2);
    expect(header.parent).toEqual({ id: 1, atSeq: 3 });
    expect(header.presetId).toBe('standard'); // 继承父卷生效组合（前缀缓存红利 + 意图）
    // ③ 父卷一个字节都没动
    expect(volumeText(1)).toBe(parentBefore);
  });

  it('② 摊开：新枝进案头（activeIdx 指向它），内容 = 父卷到切点为止的历史', async () => {
    const store = 'branch-2';
    resetPanel(store);
    setVolume(1, logText(1, [sys, user('一'), assistant('二')]));

    const result = await createBranchVolume(makeCtx(store), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const st = getChatStore(store).sess.getState();
    expect(st.sessions.map((s) => s.id)).toEqual([2]);
    expect(st.activeIdx).toBe(0);
    const msgs = msgStoreFor(store, 2).getState().messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((msgs[0] as unknown as { text: string }).text).toBe('一');
  });

  it('② 真句柄：开枝后 Agent 的会话 = 当前系统提示 + 父卷切点为止的历史（adopt 语义）', async () => {
    const store = 'branch-3';
    resetPanel(store);
    installFactory(store);
    setVolume(1, logText(1, [sys, user('一'), assistant('二')]));

    const result = await createBranchVolume(makeCtx(store), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const agent = agentSessionState.getAgent(store, result.sid);
    expect(agent).not.toBeNull();
    const conv = agent?.getSession() ?? [];
    expect(conv.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(conv[0]?.content).toBe('sys');
    expect(conv[1]?.content).toBe('一');
    // 开卷即采用磁盘历史（adopt 事件落盘——排空后可见），不是整段重写
    await flushSessionLog(agent?.sessionLog ?? null);
    const kinds = volumeLines(result.sid)
      .slice(1)
      .map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toEqual(['session/reset', 'user/message', 'assistant/text', 'session/reset']);
  });

  it('④ 血缘在盘上：模拟重启（清面板态）后重新开卷，血缘与内容都还在', async () => {
    const store = 'branch-4';
    resetPanel(store);
    setVolume(1, logText(1, [sys, user('一'), assistant('二')]));
    await createBranchVolume(makeCtx(store), 1);

    // 重启 = 面板态清空 + 卷集重扫（磁盘是唯一真源）
    resetPanel(store);
    expect(volumeHeader(2).parent).toEqual({ id: 1, atSeq: 3 });

    const reopened = await Session.loadSessionFromDisk(makeCtx(store), WS, 2);
    expect(reopened).toBe(true);
    const msgs = msgStoreFor(store, 2).getState().messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('⑥ 侧栏清单可见：枝卷落盘即成案卷（清点走清单投影 + 缺行补建，不是点不开的幽灵卷）', async () => {
    const store = 'branch-6';
    resetPanel(store);
    setVolume(1, logText(1, [sys, user('一'), assistant('二')]));
    await createBranchVolume(makeCtx(store), 1);

    const rows = await Session.listSavedSessions(makeCtx(store), WS);
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(rows.find((r) => r.id === 2)?.msgCount).toBe(2); // 有真实内容（非空卷）
  });

  it('⑤ 边归一化（plan §1.3）：继承区内立枝归**上层卷**，自己区域内才归本卷', async () => {
    const store = 'branch-5';
    resetPanel(store);
    // 卷 2 是从卷 1 的 seq 3 分出的枝：自己的区域 = 4..5
    setVolume(1, logText(1, [sys, user('一'), assistant('二')]));
    setVolume(
      2,
      logText(2, [sys, user('一'), assistant('二'), user('三'), assistant('四')], undefined, undefined, {
        id: 1,
        atSeq: 3,
      }),
    );

    // 切点落在继承区（≤ 3）⇒ 内容来自卷 1
    expect(await resolveBranchOrigin(SESSIONS, 2, 2)).toEqual({ id: 1, atSeq: 2 });
    // 正好等于继承边界 ⇒ 全部继承，继续上溯
    expect(await resolveBranchOrigin(SESSIONS, 2, 3)).toEqual({ id: 1, atSeq: 3 });
    // 落在自己区域（> 3）⇒ 边归卷 2
    expect(await resolveBranchOrigin(SESSIONS, 2, 4)).toEqual({ id: 2, atSeq: 4 });
    // 根卷：永远归自己
    expect(await resolveBranchOrigin(SESSIONS, 1, 2)).toEqual({ id: 1, atSeq: 2 });
    // 缺卷 = 首跳读不出来（调用方据此具名拒绝）
    expect(await resolveBranchOrigin(SESSIONS, 99, 1)).toBeNull();
  });
});

describe('会话树「枝」——节点定位（消息动作行的入口：枝含该节点）', () => {
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

  it('来文块 → 切点 = 该来文的来源 seq；回复块 → 切点 = 本轮末尾', async () => {
    const store = 'branch-node-1';
    resetPanel(store);
    installFactory(store);
    setVolume(1, logText(1, [sys, user('一'), assistant('二')]));
    expect(await Session.loadSessionFromDisk(makeCtx(store), WS, 1)).toBe(true);

    const ui = msgStoreFor(store, 1).getState().messages;
    const uiUser = ui.find((m) => m.role === 'user');
    const uiAssistant = ui.find((m) => m.role === 'assistant');
    expect(uiUser).toBeDefined();
    expect(uiAssistant).toBeDefined();
    if (!uiUser || !uiAssistant) return;

    // 开卷后头部 system 由 adopt 事件（seq 4）承载，尾部来文/回复仍锚在 2 / 3
    expect(resolveBranchPoint(store, 1, uiUser)).toEqual({ ok: true, atSeq: 2 });
    expect(resolveBranchPoint(store, 1, { _id: uiAssistant._id, role: 'assistant', respondingTo: uiUser._id })).toEqual(
      {
        ok: true,
        atSeq: 3,
      },
    );
    // 通知块不是对话节点
    expect(resolveBranchPoint(store, 1, { _id: 'mX', role: 'notice' }).ok).toBe(false);
  });

  it('中段切点：从某条来文立枝 ⇒ 枝只到该来文为止，父卷零变化', async () => {
    const store = 'branch-node-2';
    resetPanel(store);
    setVolume(1, logText(1, [sys, user('一'), assistant('二'), user('三'), assistant('四')]));
    const parentBefore = volumeText(1);

    const result = await createBranchVolume(makeCtx(store), 1, 4); // seq4 = 第二条来文

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(volumeHeader(2).parent).toEqual({ id: 1, atSeq: 4 });
    expect(volumeLines(2).slice(1)).toEqual(volumeLines(1).slice(1, 5)); // 前缀 = 父卷前 4 条事件
    expect(volumeText(1)).toBe(parentBefore); // 父卷一个字节未动

    const msgs = msgStoreFor(store, 2).getState().messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((msgs[2] as unknown as { text: string }).text).toBe('三');
  });

  it('未落定 ⇒ 具名拒绝；同一卷的来文块仍可立枝（切点在其之前）', async () => {
    const store = 'branch-node-3';
    resetPanel(store);
    installFactory(store);
    setVolume(1, logText(1, [sys, user('一'), assistant('二')]));
    await Session.loadSessionFromDisk(makeCtx(store), WS, 1);

    // 模拟「正在跑」：走**产品自己的双写入口**宣布一次调用（结果未落）——日志与
    // 会话同时前进。（直接往 sessionLog append 会让两者失同步，那是坏不变式、
    // 不是产品态；`_appendMessage` 是 agent.ts 里 session 变异的三个合法入口之一。）
    const handle = agentSessionState.getAgent(store, 1) as unknown as {
      _getAgent(): { _appendMessage(kind: string, message: unknown): void };
    };
    handle._getAgent()._appendMessage('assistant/text', {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c9', name: 'fs', arguments: '{}' }],
    });

    const ui = msgStoreFor(store, 1).getState().messages;
    const uiUser = ui.find((m) => m.role === 'user');
    const uiAssistant = ui.find((m) => m.role === 'assistant');
    expect(uiUser).toBeDefined();
    expect(uiAssistant).toBeDefined();
    if (!uiUser || !uiAssistant) return;

    // 回复块：切点落在本轮末尾（那条悬空宣布）⇒ 拒
    const refused = resolveBranchPoint(store, 1, {
      _id: uiAssistant._id,
      role: 'assistant',
      respondingTo: uiUser._id,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain('没落定');
    // 来文块：切点在悬空调用之前 ⇒ 仍可立枝（合法前缀）
    expect(resolveBranchPoint(store, 1, uiUser)).toEqual({ ok: true, atSeq: 2 });
  });

  it('句柄缺席 ⇒ 具名拒绝（不静默）', () => {
    const store = 'branch-node-4';
    resetPanel(store);
    const point = resolveBranchPoint(store, 1, { _id: 'm1', role: 'user' });
    expect(point.ok).toBe(false);
    if (point.ok) return;
    expect(point.reason).toContain('Agent 未就绪');
  });

  it('批量派生（渲染期置灰读面）：一趟算清、逐节点与单点判据**同源**', async () => {
    const store = 'branch-node-5';
    resetPanel(store);
    installFactory(store);
    setVolume(1, logText(1, [sys, user('一'), assistant('二')]));
    await Session.loadSessionFromDisk(makeCtx(store), WS, 1);

    // 模拟「正在跑」：产品自己的双写入口宣布一次调用（结果未落）
    const handle = agentSessionState.getAgent(store, 1) as unknown as {
      _getAgent(): { _appendMessage(kind: string, message: unknown): void };
    };
    handle._getAgent()._appendMessage('assistant/text', {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c9', name: 'fs', arguments: '{}' }],
    });

    const ui = msgStoreFor(store, 1).getState().messages;
    const uiUser = ui.find((m) => m.role === 'user');
    const uiAssistant = ui.find((m) => m.role === 'assistant');
    expect(uiUser).toBeDefined();
    expect(uiAssistant).toBeDefined();
    if (!uiUser || !uiAssistant) return;
    const nodes = [
      { _id: uiUser._id, role: 'user' },
      { _id: uiAssistant._id, role: 'assistant', respondingTo: uiUser._id },
    ];

    const derived = deriveBranchPoints(store, 1, nodes);
    // 逐节点与单点路径逐字同判据（不出现第二把尺子）
    for (const n of nodes) {
      expect(derived.get(n._id)).toEqual(resolveBranchPoint(store, 1, n));
    }
    // 未落定批次：回复块置灰 + 具名原因；切点在它之前的来文块照常可立枝
    expect(derived.get(uiUser._id)).toEqual({ ok: true, atSeq: 2 });
    const refused = derived.get(uiAssistant._id);
    expect(refused?.ok).toBe(false);
    if (!refused || refused.ok) return;
    expect(refused.reason).toContain('没落定');
    // 空节点表 = 空表（渲染期无块可问时不建上下文）
    expect(deriveBranchPoints(store, 1, []).size).toBe(0);
  });
});

describe('会话树「枝」——切点纪律的拒态（拒了必须一个字节都不落）', () => {
  beforeEach(() => {
    H.kernelFs?.fs.files.clear();
    H.kernelFs?.fs.dirs.clear();
    Session.resetSessionListCacheForTests();
  });

  it('未落定（宣布了 tool_call 却没有结果）⇒ 具名拒绝，不落新卷', async () => {
    const store = 'branch-refuse-dangling';
    resetPanel(store);
    setVolume(
      1,
      logText(1, [
        sys,
        user('跑个工具'),
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'fs', arguments: '{}' }] },
      ]),
    );

    const result = await createBranchVolume(makeCtx(store), 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('没落定');
    expect(volumeText(2)).toBeUndefined(); // 拒态零副作用
    expect(getChatStore(store).sess.getState().sessions).toEqual([]);
  });

  it('断尾/坏行 ⇒ 拒绝（先让恢复链修好再立枝——否则父子字节不同源）', async () => {
    const store = 'branch-refuse-torn';
    resetPanel(store);
    setVolume(1, `${logText(1, [sys, user('一')])}{"seq":3,"ts":2,"kind":"assistant/tex`);

    const result = await createBranchVolume(makeCtx(store), 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('断尾');
    expect(volumeText(2)).toBeUndefined();
  });

  it('空卷（只有系统提示）⇒ 拒绝（立出来的是点不开的幽灵卷）', async () => {
    const store = 'branch-refuse-empty';
    resetPanel(store);
    setVolume(1, logText(1, [sys]));

    const result = await createBranchVolume(makeCtx(store), 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('还没有内容');
    expect(volumeText(2)).toBeUndefined();
  });

  it('源卷不存在 ⇒ 拒绝', async () => {
    const store = 'branch-refuse-missing';
    resetPanel(store);

    const result = await createBranchVolume(makeCtx(store), 7);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('读不出来');
    expect(getChatStore(store).sess.getState().sessions).toEqual([]);
  });
});

describe('会话树「枝」——删除连坐（P2，plan §8/§9：删父卷 = 删整棵子树）', () => {
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

  /** 一棵四卷的树（**含继承区内立枝的孙卷**——边必须归一化到上层卷）：
   *  卷 1（根，5 事件）→ 卷 2（从 1@3 分出，自己的区域 4..5）
   *                    → 卷 3（从 **2@2** 分出——2 落在卷 2 的继承区 ⇒ 归到卷 1）
   *  卷 2 → 卷 4（从 2@5 分出——落在卷 2 自己区域 ⇒ 归卷 2） */
  function seedTree(): void {
    setVolume(1, logText(1, [sys, user('一'), assistant('二'), user('三'), assistant('四')]));
    setVolume(
      2,
      logText(2, [sys, user('一'), assistant('二'), user('五'), assistant('六')], undefined, undefined, {
        id: 1,
        atSeq: 3,
      }),
    );
    setVolume(3, logText(3, [sys, user('一'), assistant('七')], undefined, undefined, { id: 2, atSeq: 2 }));
    setVolume(
      4,
      logText(4, [sys, user('一'), assistant('二'), user('五'), assistant('八')], undefined, undefined, {
        id: 2,
        atSeq: 5,
      }),
    );
  }

  it('血缘图按磁盘真源重建：继承区内的孙卷归到**上层卷**（归一化后的边）', async () => {
    seedTree();
    const lineage = await loadBranchLineage(SESSIONS, [1, 2, 3, 4]);
    expect(lineage.parentOf.get(1)).toBeNull();
    expect(lineage.parentOf.get(2)).toBe(1);
    expect(lineage.parentOf.get(3)).toBe(1); // 从 2@2 分出，但 2 落在卷 2 的继承区 ⇒ 归卷 1
    expect(lineage.parentOf.get(4)).toBe(2); // 从 2@5 分出（卷 2 自己的区域）⇒ 归卷 2
    expect(lineage.childrenOf.get(1)?.sort()).toEqual([2, 3]);
    expect(lineage.childrenOf.get(2)).toEqual([4]);
  });

  it('连坐：删父卷 ⇒ 整棵子树（**后序**：先子后父），卷 3 按归一化边跟着卷 1 走', async () => {
    const store = 'branch-cascade-1';
    resetPanel(store);
    seedTree();

    const outcome = await cascade(store, [1]);

    // 后序：4（2 的子）→ 2 → 3 → 1（根）——任何中断点剩下的都还是合法森林
    expect(outcome.deleted).toEqual([4, 2, 3, 1]);
    expect(outcome.failed).toEqual([]);
    expect(outcome.blocked).toEqual([]);
    for (const sid of [1, 2, 3, 4]) expect(volumeText(sid)).toBeUndefined();
  });

  it('连坐只连自己的子树：删卷 2 ⇒ 只带走 4，卷 3（归一化归卷 1）与卷 1 都在', async () => {
    const store = 'branch-cascade-2';
    resetPanel(store);
    seedTree();

    const outcome = await cascade(store, [2]);

    expect(outcome.deleted).toEqual([4, 2]);
    expect(volumeText(1)).toBeDefined();
    expect(volumeText(3)).toBeDefined();
  });

  it('后序删除：**任何中断点剩下的都还是合法森林**（零孤儿）', async () => {
    seedTree();
    const lineage = await loadBranchLineage(SESSIONS, [1, 2, 3, 4]);
    const plan = await planBranchDelete('branch-cascade-3', WS, [1]);
    expect(plan.order).toEqual([4, 2, 3, 1]);
    expect(plan.branchCount).toBe(3); // 「将同时删除 3 枝」

    // 逐步截断删除序：剩下的卷里，凡有父的，父都还在场
    for (let k = 0; k <= plan.order.length; k++) {
      const removed = new Set(plan.order.slice(0, k));
      const alive = new Set([1, 2, 3, 4].filter((sid) => !removed.has(sid)));
      for (const sid of alive) {
        const parent = lineage.parentOf.get(sid) ?? null;
        if (parent != null) expect(alive.has(parent)).toBe(true);
      }
    }
  });

  it('子树里有运行中的卷 ⇒ 该选择卷整体拒绝并列出（不删一个字节）', async () => {
    const store = 'branch-cascade-4';
    resetPanel(store);
    seedTree();
    // 孙卷 4 运行中
    const exec = Session.getSessionExecState(store, 4);
    exec.start();

    const outcome = await cascade(store, [1]);

    expect(outcome.deleted).toEqual([]);
    expect(outcome.blocked).toEqual([{ id: 1, running: [4] }]);
    for (const sid of [1, 2, 3, 4]) expect(volumeText(sid)).toBeDefined();
    exec.done();
  });

  it('部分失败逐卷可见：删不掉的卷进 failed 并带原因，成功的不回滚（剩下的仍是合法森林）', async () => {
    const store = 'branch-cascade-5';
    resetPanel(store);
    seedTree();
    H.kernelFs!.fs.fail.delete = '注入：磁盘拒绝删除';

    const outcome = await cascade(store, [1]);

    expect(outcome.deleted).toEqual([]);
    expect(outcome.failed.map((f) => f.id)).toEqual([4, 2, 3, 1]); // 逐卷报账（不静默）
    expect(outcome.failed[0]?.reason).toContain('注入');
    expect(volumeText(1)).toBeDefined();
  });

  it('血缘悬空（父卷已被外部删掉）⇒ 子卷当根卷，删它不连坐别人', async () => {
    const store = 'branch-cascade-6';
    resetPanel(store);
    // 卷 9 的头行写着父卷 5，但 5 不在盘上
    setVolume(9, logText(9, [sys, user('一')], undefined, undefined, { id: 5, atSeq: 1 }));
    setVolume(8, logText(8, [sys, user('二')]));

    const lineage = await loadBranchLineage(SESSIONS, [8, 9]);
    expect(lineage.parentOf.get(9)).toBeNull();
    const outcome = await cascade(store, [9]);
    expect(outcome.deleted).toEqual([9]);
    expect(volumeText(8)).toBeDefined();
  });
});

describe('会话树「枝」——立枝即摊开并定位（P0：expand 是「摊开 + 定位」单一权威入口）', () => {
  beforeEach(() => {
    const fs = H.kernelFs?.fs;
    if (fs) {
      fs.files.clear();
      fs.dirs.clear();
      fs.writes.length = 0;
      fs.fail = {};
    }
    Session.resetSessionListCacheForTests();
    resetCanvasStoresForTests();
    useCanvasViewStore.getState().requestFocus(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('点「立枝」⇒ expand(新卷) 恰好一次 + 视角飞向新枝；连点两次各飞各的、无悬空请求', async () => {
    const core = new ChatCore();
    useCoreStore.getState().setChatCore(core); // 空间命令按此 core 取 panelId
    const store = core.panelId;
    installFactory(store);
    useShellStore.setState({ projectPath: WS });
    setVolume(1, logText(1, [sys, user('一'), assistant('二')]));
    expect(await core.loadSessionFromDisk(WS, 1)).toBe(true);
    // 基线在**父卷写后队列排空之后**取：开卷自带的 adopt 落盘是开卷的账，不是立枝的
    await flushSessionLog(agentSessionState.getAgent(store, 1)?.sessionLog ?? null);
    const parentBefore = volumeText(1);

    // 空间服务在册（activeSpace()）——生产装配面
    new SpaceService(new Context());
    const expand = vi.spyOn(SpaceService.prototype, 'expand');

    const ui = msgStoreFor(store, 1).getState().messages;
    const uiUser = ui.find((m) => m.role === 'user');
    expect(uiUser).toBeDefined();
    if (!uiUser) return;

    // ① 点「立枝」：新枝卷摊到案头 **且** 视角飞到它（缺任一半 = 用户看到的「没摊开」）
    expect(await core.branchFromMessage(uiUser, 1)).toBe(2);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith('2');
    expect(
      getChatStore(store)
        .sess.getState()
        .sessions.map((s) => s.id),
    ).toContain(2);
    // 在途定位指向**真实存在于案头**的卷 ⇒ 会被补飞兑现，不是永不兑现的悬空请求
    expect(useCanvasViewStore.getState().pendingFocusId).toBe('2');
    expect(volumeText(1)).toBe(parentBefore); // 父卷字节零变化

    // ② 连点第二次：另起一枝、同样飞过去；旧请求被新请求取代（不叠加悬空）
    expect(await core.branchFromMessage(uiUser, 1)).toBe(3);
    expect(expand).toHaveBeenCalledTimes(2);
    expect(expand).toHaveBeenLastCalledWith('3');
    expect(
      getChatStore(store)
        .sess.getState()
        .sessions.map((s) => s.id),
    ).toContain(3);
    expect(useCanvasViewStore.getState().pendingFocusId).toBe('3');
    expect(volumeText(1)).toBe(parentBefore);
  });

  it('未落定 ⇒ 拒绝时 expand 一次都不调（失败路径不留悬空定位请求）', async () => {
    const core = new ChatCore();
    useCoreStore.getState().setChatCore(core);
    const store = core.panelId;
    installFactory(store);
    useShellStore.setState({ projectPath: WS });
    setVolume(1, logText(1, [sys, user('一'), assistant('二')]));
    expect(await core.loadSessionFromDisk(WS, 1)).toBe(true);
    new SpaceService(new Context());
    const expand = vi.spyOn(SpaceService.prototype, 'expand');

    // 模拟「正在跑」：开卷**之后**经产品自己的双写入口宣布一次调用（结果未落）——
    // 开卷时的恢复链只兜盘上残留，兜不到这一刻在途的调用。
    const handle = agentSessionState.getAgent(store, 1) as unknown as {
      _getAgent(): { _appendMessage(kind: string, message: unknown): void };
    };
    handle._getAgent()._appendMessage('assistant/text', {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c9', name: 'fs', arguments: '{}' }],
    });

    const ui = msgStoreFor(store, 1).getState().messages;
    const uiAssistant = ui.find((m) => m.role === 'assistant');
    expect(uiAssistant).toBeDefined();
    if (!uiAssistant) return;

    // 回复块切点落在本轮末尾（那条悬空宣布）⇒ 拒；失败路径不得发定位请求
    expect(await core.branchFromMessage(uiAssistant, 1)).toBeNull();
    expect(expand).not.toHaveBeenCalled();
    expect(useCanvasViewStore.getState().pendingFocusId).toBeNull();
  });
});
