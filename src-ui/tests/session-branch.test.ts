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

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createBranchVolume, resolveBranchOrigin, resolveBranchPoint } from '../src/app/chat/session-branch';
import { flushSessionLog } from '../src/app/chat/session-log-store';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
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
