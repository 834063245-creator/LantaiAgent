// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 消息消失/聊天流冲坏（2026-09-09 诊断）——反馈环测试台：
// 穿真实 ChatCore 发送管线（appendUserBubble → agent.run → eventSinkFor →
// renderEvent → _streamingAssistant）+ 真实恢复路径（loadSessionFromDisk →
// rebuildMessagesFromMessages），断言用户症状不变量：
//   ① 全部消息 _id 唯一（重复 id = 块 key 撞车 = 渲染冲坏）
//   ② 发出的每条用户消息文本都在 store（消息内容消失）
//   ③ 流式回复落在「最新」助手消息里、历史消息内容不被覆盖（冲坏整流）
//   ④ translate 产物块 id 唯一（React key 层无重复）
// mock 面沿用 session-restore-snapshot.test.ts（kernel-fs 内存盘 + 生产 seam 装配）。

import { cacheText, logText } from './helpers/session-files';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/app-shell', () => ({
  shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() },
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'test', apiKey: 'k', baseUrl: '', model: 'm', kind: 'openai' })),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => {
  const noop = () => ({ kill: vi.fn(), play: vi.fn(), pause: vi.fn() });
  return { default: { set: vi.fn(), to: vi.fn(noop), from: vi.fn(noop), fromTo: vi.fn(noop), killTweensOf: vi.fn() } };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { EventKind as EK } from '../src/agent/agent-types';
import { ChatCore } from '../src/app/chat/chat-core';
import { useShellStore } from '../src/app/shell-store';
import { fsServicePlugin } from '../src/composition/fs-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { sessionPersistenceServicePlugin } from '../src/composition/session-persistence-service';
import { shellServicePlugin } from '../src/composition/shell-service';
import { Context } from '../src/cordis';
import { translateMessages } from '../src/paper/translate';
import { builtinFsPlugin } from '../src/plugins/builtin/fs-builtin';
import { builtinSessionsPlugin } from '../src/plugins/builtin/sessions-builtin';
import { builtinShellPlugin } from '../src/plugins/builtin/shell-builtin';
import * as Session from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { ChatMessage, UserMessage } from '../src/ui/message-model';

// 本地最小 seam 装配（不用 tests/helpers/composition-boot：其 graph-builtin
// 依赖正被并行工程在途拆除；本环只需要 sessionPersistence 通道）。
let _bootRoot: Context | null = null;
async function ensureSessionsChannelBooted(): Promise<void> {
  if (_bootRoot) return;
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  await root.plugin(fsServicePlugin);
  await root.plugin(builtinFsPlugin);
  await root.plugin(shellServicePlugin);
  await root.plugin(builtinShellPlugin);
  await root.plugin(sessionPersistenceServicePlugin);
  await root.plugin(builtinSessionsPlugin);
  _bootRoot = root;
}
await ensureSessionsChannelBooted();

const PROJ = 'D:/corrupt-proj';

/* ── 不变量断言器 ── */

function idsUnique(msgs: ChatMessage[], label: string): void {
  const ids = msgs.map((m) => m._id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  expect(dup, `${label}: 重复消息 id [${[...new Set(dup)].join(',')}]`).toEqual([]);
}

function blockIdsUnique(msgs: ChatMessage[], label: string): void {
  const blocks = translateMessages(msgs);
  const ids = blocks.map((b) => b.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  expect(dup, `${label}: 重复块 id（React key 撞车）[${[...new Set(dup)].join(',')}]`).toEqual([]);
}

function userTexts(msgs: ChatMessage[]): string[] {
  return msgs.filter((m): m is UserMessage => m.role === 'user').map((m) => m.text);
}

function assistantTextParts(msgs: ChatMessage[]): string[] {
  return msgs.flatMap((m) =>
    m.role === 'assistant'
      ? m.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text)
      : [],
  );
}

/* ── 流式 agent 工厂（事件走真实 eventSinkFor —— workspace.ts 同款绑定）── */

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

function streamingFactory(panel: ChatCore, opts?: { factoryDelayMs?: number; pendingRuns?: Array<() => void> }) {
  return async (sid: number) => {
    const sink = panel.eventSinkFor(sid);
    const session: Array<Record<string, unknown>> = [{ role: 'system', content: 'sys' }];
    const pendingInserts: string[] = [];
    let pendingUsed = false;
    const handle = {
      getSession: () => session,
      setSession: (msgs: Array<Record<string, unknown>>) => {
        session.length = 0;
        session.push(...msgs);
      },
      insertMessage: (text: string) => {
        pendingInserts.push(text);
      },
      setUiSessionId: vi.fn(),
      cascadeAbort: vi.fn(),
      retractTurnAt: vi.fn(),
      dispose: vi.fn(),
      bindSession: vi.fn(),
      newSession: vi.fn(),
      compactNow: vi.fn(async () => ''),
      stopAllSubAgents: vi.fn(() => []),
      runningSubAgentCount: vi.fn(() => 0),
      run: async (signal: AbortSignal, text: string) => {
        const usePending = opts?.pendingRuns !== undefined && !pendingUsed;
        if (usePending) {
          pendingUsed = true;
          // 挂起模式：发出首批事件后停在受控 promise 上（插话/停止用例）——仅首轮；
          // 后续轮走常规流式序列（停止/插话后的新轮不得再被测试台卡住）。
          session.push({ role: 'user', content: text });
          sink({ kind: EK.TurnStarted });
          sink({ kind: EK.Text, text: '在途片段' });
          await tick();
          await new Promise<void>((resolve) => {
            opts.pendingRuns!.push(resolve);
          });
          if (signal.aborted) throw new Error('aborted');
          sink({ kind: EK.Text, text: '挂起后片段' });
          session.push({ role: 'assistant', content: '在途片段挂起后片段' });
          return;
        }
        // 常规模式：真实流式事件序列（TurnStarted → Reasoning → Text×n → Message → Usage）
        session.push({ role: 'user', content: text });
        sink({ kind: EK.TurnStarted });
        sink({ kind: EK.Reasoning, text: '思考一下' });
        await tick();
        sink({ kind: EK.Text, text: `回「${text}」的前半。` });
        await tick();
        sink({ kind: EK.Text, text: '后半。' });
        await tick();
        sink({ kind: EK.Message });
        session.push({ role: 'assistant', content: `回「${text}」的前半。后半。`, reasoning_content: '思考一下' });
        sink({
          kind: EK.Usage,
          usage: { total_tokens: 42, prompt_tokens: 20, completion_tokens: 22 },
        });
      },
    };
    if (opts?.factoryDelayMs) await tick(opts.factoryDelayMs);
    return handle;
  };
}

/** 旧档卷（无 UI 投影缓存——实机真实形态：C8 合卷剥离）：两轮对话。
 *  Phase 3b：卷本体 = 事件日志（`.ndjson`）。 */
function volumeFile(id: number, label: string): string {
  return logText(
    id,
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '旧问一' },
      { role: 'assistant', content: '旧答一' },
      { role: 'user', content: '旧问二' },
      { role: 'assistant', content: '旧答二', reasoning_content: '旧思考' },
    ],
    label,
  );
}

/** 现代卷（带 UI 投影缓存——运行中退出/崩溃后的摊开集恢复形态）：
 *  缓存里的 _id 是上一运行铸的旧号（m1/m2）；日志 = 内容真源。 */
function snapshotVolumeFile(id: number, label: string): string {
  return logText(
    id,
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '旧问一' },
      { role: 'assistant', content: '旧答一' },
    ],
    label,
  );
}

/** UI 投影缓存（与 snapshotVolumeFile 配套；新鲜 seq 给足）。 */
function snapshotVolumeCache(id: number, label: string): string {
  return cacheText(id, {
    label,
    tokensUsed: 10,
    uiMessages: [
      { _id: 'm1', role: 'user', text: '旧问一', sessionIndex: 1 },
      {
        _id: 'm2',
        role: 'assistant',
        status: 'done',
        respondingTo: 'm1',
        parts: [{ type: 'text', text: '旧答一', finalised: true }],
      },
    ],
  });
}

function seedVolumeFile(id: number, label: string): void {
  H.kernelFs!.fs.setFile(`${PROJ}/.lantai/sessions/${id}.ndjson`, volumeFile(id, label));
}

function freshPanel(factoryDelayMs?: number, pendingRuns?: Array<() => void>): ChatCore {
  const panel = new ChatCore();
  panel.setProjectPath(PROJ);
  panel.setAgentFactory(streamingFactory(panel, { factoryDelayMs, pendingRuns }));
  return panel;
}

function send(panel: ChatCore, text: string): Promise<void> {
  getChatStore(panel.panelId).input.getState().setInputText(text);
  return panel.sendMessage();
}

beforeEach(() => {
  localStorage.clear();
  H.kernelFs!.fs.files.clear();
  H.kernelFs!.fs.dirs.clear();
  H.kernelFs!.fs.writes.length = 0;
  H.kernelFs!.fs.lists.length = 0;
  H.kernelFs!.fs.fail = {};
  useShellStore.setState({ projectPath: '' });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('发送链路不变量（反馈环）', () => {
  it('基线：新建卷 + 单轮发送——不变量全绿', async () => {
    const panel = freshPanel();
    await panel.createNewSession();
    await send(panel, '你好');
    const msgs = msgStoreFor(panel.panelId, 1).getState().messages;
    idsUnique(msgs, '基线');
    blockIdsUnique(msgs, '基线');
    expect(userTexts(msgs)).toEqual(['你好']);
    expect(assistantTextParts(msgs).join('')).toContain('回「你好」');
  });

  it('实机形态：续开旧档卷（无 uiMessages → provider 重建）后发送——消息不消失、历史不被覆盖', async () => {
    seedVolumeFile(30, '旧档卷');
    const panel = freshPanel();
    await panel.loadSessionFromDisk(PROJ, 30);
    const restored = msgStoreFor(panel.panelId, 30).getState().messages;
    expect(userTexts(restored)).toEqual(['旧问一', '旧问二']);

    await send(panel, '新问题');
    const msgs = msgStoreFor(panel.panelId, 30).getState().messages;
    idsUnique(msgs, '续开发送');
    blockIdsUnique(msgs, '续开发送');
    // 新用户消息在场（消息内容不消失）+ 历史消息原样
    expect(userTexts(msgs)).toEqual(['旧问一', '旧问二', '新问题']);
    expect(assistantTextParts(msgs).join('')).toContain('回「新问题」');
    // 历史回复不被新流覆盖（旧答还在）
    expect(assistantTextParts(msgs).join('')).toContain('旧答二');
  });

  it('续开卷连续多轮快速发送——每轮消息与历史全程完好', async () => {
    seedVolumeFile(31, '多轮卷');
    const panel = freshPanel();
    await panel.loadSessionFromDisk(PROJ, 31);
    await send(panel, '第一发');
    await send(panel, '第二发');
    await send(panel, '第三发');
    const msgs = msgStoreFor(panel.panelId, 31).getState().messages;
    idsUnique(msgs, '多轮');
    blockIdsUnique(msgs, '多轮');
    expect(userTexts(msgs)).toEqual(['旧问一', '旧问二', '第一发', '第二发', '第三发']);
    const joined = assistantTextParts(msgs).join('');
    expect(joined).toContain('旧答一');
    expect(joined).toContain('旧答二');
    expect(joined).toContain('回「第三发」');
  });

  it('运行中插话（insertMessage 路径）——插话消息不丢、流不冲坏', async () => {
    seedVolumeFile(32, '插话卷');
    const pendingRuns: Array<() => void> = [];
    const panel = freshPanel(undefined, pendingRuns);
    await panel.loadSessionFromDisk(PROJ, 32);

    const run1 = send(panel, '主轮问题');
    await tick(40); // 等主轮在途事件落地
    await send(panel, '插话内容'); // isRunning → insert 路径
    pendingRuns[0]();
    await run1;
    await tick(40);

    const msgs = msgStoreFor(panel.panelId, 32).getState().messages;
    idsUnique(msgs, '插话');
    blockIdsUnique(msgs, '插话');
    expect(userTexts(msgs)).toContain('主轮问题');
    expect(userTexts(msgs)).toContain('插话内容');
    const joined = assistantTextParts(msgs).join('');
    expect(joined).toContain('在途片段');
    expect(joined).toContain('挂起后片段');
    expect(joined).toContain('旧答一');
  });

  it(
    '停止后立刻重发——新轮消息/回复完整、旧流不冲坏',
    { timeout: 20_000 },
    async () => {
      seedVolumeFile(33, '停止卷');
      const pendingRuns: Array<() => void> = [];
      const panel = freshPanel(undefined, pendingRuns);
      await panel.loadSessionFromDisk(PROJ, 33);

      const run1 = send(panel, '将被停止的问题');
      await tick(40); // 等主轮在途事件落地
      panel.abort();
      pendingRuns[0]();
      await run1.catch(() => {});
      await tick(40);

      await send(panel, '停止后的新问题');
      const msgs = msgStoreFor(panel.panelId, 33).getState().messages;
      idsUnique(msgs, '停止重发');
      blockIdsUnique(msgs, '停止重发');
      expect(userTexts(msgs)).toContain('将被停止的问题');
      expect(userTexts(msgs)).toContain('停止后的新问题');
      expect(assistantTextParts(msgs).join('')).toContain('回「停止后的新问题」');
      expect(assistantTextParts(msgs).join('')).toContain('旧答一');
    },
    20_000,
  );

  it('重启形态：快照卷回填旧 id + counter 归零 → 发消息不撞号、流不冲坏（主症状）', async () => {
    H.kernelFs!.fs.setFile(`${PROJ}/.lantai/sessions/50.ndjson`, snapshotVolumeFile(50, '快照卷'));
    H.kernelFs!.fs.setFile(`${PROJ}/.lantai/sessions/50.json`, snapshotVolumeCache(50, '快照卷'));
    // 模拟重启：全局发号器归零（上一运行的 uiMessages 仍带旧 id m1/m2）
    getChatStore('__default__').sess.setState({ msgIdSeq: 0 });
    const panel = freshPanel();
    await panel.loadSessionFromDisk(PROJ, 50);
    const restored = msgStoreFor(panel.panelId, 50).getState().messages;
    expect(userTexts(restored)).toEqual(['旧问一']);
    expect(assistantTextParts(restored)).toEqual(['旧答一']);

    await send(panel, '重启后第一发');
    const msgs = msgStoreFor(panel.panelId, 50).getState().messages;
    // ① 撞号红线：新消息铸出 m1/m2 → 与快照旧 id 重复（React key 撞车源）
    idsUnique(msgs, '重启快照回填');
    blockIdsUnique(msgs, '重启快照回填');
    // ② 消息不消失：新用户消息在场
    expect(userTexts(msgs)).toEqual(['旧问一', '重启后第一发']);
    // ③ 历史不被覆盖：旧助手消息的 parts 原样（新流不写进历史）
    const oldAssistant = msgs.find((m) => m._id === 'm2');
    expect(oldAssistant && oldAssistant.role === 'assistant' ? oldAssistant.parts : []).toEqual([
      { type: 'text', text: '旧答一', finalised: true },
    ]);
    // ④ 新流落在新助手消息里
    expect(assistantTextParts(msgs).join('')).toContain('回「重启后第一发」');
    expect(assistantTextParts(msgs).join('')).toContain('旧答一');
  });

  it('重启形态（启动摊开集恢复）：batchRestoreSessions 回填旧 id → 发消息不撞号', async () => {
    // 生产触发面 = restoreCanvasSpread → batchRestoreSessions（启动自动摊开）
    getChatStore('__default__').sess.setState({ msgIdSeq: 0 });
    const panel = freshPanel();
    // Phase 3b：`batchRestoreSessions` 的输入 = `readVolumeData` 的产物形状
    // （messages 派生自事件日志 + uiMessages 取自投影缓存）——直接按该形状构造
    const data = {
      id: 51,
      label: '摊开卷',
      savedAt: '',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '旧问一' },
        { role: 'assistant', content: '旧答一' },
      ],
      uiMessages: JSON.parse(snapshotVolumeCache(51, '摊开卷')).uiMessages,
    } as Session.StoredSession;
    const failed = await Session.batchRestoreSessions({ storeId: panel.panelId } as unknown as Session.SessionContext, [
      { sid: 51, data },
    ]);
    expect(failed).toBe(0);
    // batchRestore 不建句柄——拟文路径走 ensureSessionAgent 水合（真实启动形态）
    getChatStore(panel.panelId)
      .sess.getState()
      .setActiveIdx(
        getChatStore(panel.panelId)
          .sess.getState()
          .sessions.findIndex((s) => s.id === 51),
      );
    await send(panel, '启动后第一发');
    const msgs = msgStoreFor(panel.panelId, 51).getState().messages;
    idsUnique(msgs, '启动摊开恢复');
    blockIdsUnique(msgs, '启动摊开恢复');
    expect(userTexts(msgs)).toEqual(['旧问一', '启动后第一发']);
    const oldAssistant = msgs.find((m) => m._id === 'm2');
    expect(oldAssistant && oldAssistant.role === 'assistant' ? oldAssistant.parts : []).toEqual([
      { type: 'text', text: '旧答一', finalised: true },
    ]);
    expect(assistantTextParts(msgs).join('')).toContain('回「启动后第一发」');
  });

  it('合卷自动存快照必须含 uiMessages（C8 丢字段 = 重开降采样）', async () => {
    seedVolumeFile(34, '合卷卷');
    const panel = freshPanel();
    await panel.loadSessionFromDisk(PROJ, 34);
    await send(panel, '合卷前的消息');
    panel.closeSession(0);
    await tick(40);
    const written = H.kernelFs!.fs.files.get(`${PROJ}/.lantai/sessions/34.json`);
    expect(written).toBeTruthy();
    const parsed = JSON.parse(written!) as { uiMessages?: ChatMessage[] };
    expect(parsed.uiMessages, 'C8 合卷快照丢 uiMessages → 重开走降采样重建').toBeDefined();
    expect(parsed.uiMessages!.length).toBeGreaterThan(0);
  });

  it('案头双回车竞态：并发两次建卷——两卷两号、互不覆盖', async () => {
    const panel = freshPanel(15); // 工厂 await 窗口拉宽
    const p1 = panel.createNewSession();
    const p2 = panel.createNewSession();
    await Promise.all([p1, p2]);
    const st = getChatStore(panel.panelId).sess.getState();
    const ids = st.sessions.map((s) => s.id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size, '并发建卷铸出同号卷（共享同一 msgStore 的根因）').toBe(2);
  });

  it('建卷与续开并发（lost-update 竞态）——续开的卷不得从列表消失', async () => {
    seedVolumeFile(40, '并发续开卷');
    const panel = freshPanel(15);
    const loadP = panel.loadSessionFromDisk(PROJ, 40); // 工厂在途
    const createP = panel.createNewSession(); // 在途窗口内用户又建卷
    await Promise.all([loadP, createP]);
    const st = getChatStore(panel.panelId).sess.getState();
    const ids = st.sessions.map((s) => s.id);
    expect(
      ids.some((i) => i === 40),
      '建卷的陈旧快照写回把续开的卷挤出了列表',
    ).toBe(true);
    expect(ids.length).toBe(2);
  });
});
