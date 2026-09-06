// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// session-restore-snapshot — 2026-08-31 会话流专项回归：
//   刀一 恢复路径直接采信磁盘 UI 快照（uiMessages），不再按 provider 消息
//        重建（重建是降采样：工具 err 丢弃、status 归一、label 变名）。
//   刀二 撤回/重发后底层会话与界面同源：内容兜底定位 + 剩余轮次重映射 +
//        旧 turnPair 残留清除（重发叠尸 = 恢复重复渲染的数据根因）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fs 域收口（2026-09-04）：会话卷读经 kernelReadFileRaw（rpc-contract 具名
// helper，内部直呼 fs_cap）——mock 站到 helper 层（不再拦 bridge +
// legacyDispatchShim 翻信封）。恢复卷预置进共享内存 fs。

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

// ── Mock DOM-heavy libs（照 chat-session.test.ts，最小化）──
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
vi.mock('../src/state/canvas-store', () => ({
  ...vi.importActual('../src/state/canvas-store'),
  default: {},
}));

import { agentSessionState } from '../src/agent/agent-session-state';
import { createExecState } from '../src/agent/execution-state';
import { ChatCore } from '../src/app/chat/chat-core';
import { useShellStore } from '../src/app/shell-store';
import * as Session from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

// 会话持久化 seam 装配（seam 接线 C 批 3）：卷 CRUD 已换轨 sessionExecute——
// builtin provider 需在册（走 kernel-fs mock 内存盘）。
await ensureProductionChannelsBooted();

const PROJ = 'D:/snapshot-proj';

/** 清空共享内存盘（每用例独立起测）。 */
function freshFs(): void {
  const k = H.kernelFs;
  if (!k) throw new Error('kernelFs mock 未就绪（vi.mock 工厂未执行）');
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.lists.length = 0;
  k.fs.fail = {};
}

function createChatPanel(): ChatCore {
  return new ChatCore();
}

/** 工厂桩：setSession 真正落进闭包（loadSessionFromDisk 重建/推导依赖 agent 会话）。 */
function storingFactory() {
  let agentSession: any[] = [{ role: 'system', content: 'sys' }];
  const agent = {
    getSession: () => agentSession,
    setSession: (msgs: any[]) => {
      agentSession = msgs;
    },
    dispose: vi.fn(),
    bindSession: vi.fn(),
  };
  return { factory: async () => agent, agent };
}

/** 带 UI 快照的卷文件：provider 形状无 err（抽象会话），快照保真（err/error 态在）。 */
function snapshotVolumeFile() {
  return JSON.stringify({
    id: 71,
    label: '快照卷',
    savedAt: new Date().toISOString(),
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', name: 'fs_read', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 't1', content: '' },
    ],
    uiMessages: [
      { _id: 'u1', role: 'user', text: 'hi', sessionIndex: 1 },
      {
        _id: 'a1',
        role: 'assistant',
        status: 'done',
        respondingTo: 'u1',
        parts: [
          {
            type: 'tool',
            toolId: 't1',
            name: 'fs_read',
            args: '{}',
            label: '读取文件',
            readOnly: true,
            status: 'error',
            err: 'boom',
          },
        ],
      },
    ],
    tokensUsed: 100,
  });
}

/** 旧档卷文件：只有 provider 消息（无 uiMessages 字段）。 */
function legacyVolumeFile() {
  return JSON.stringify({
    id: 72,
    label: '旧档卷',
    savedAt: new Date().toISOString(),
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '旧问' },
      { role: 'assistant', content: '旧答' },
    ],
  });
}

describe('会话恢复采信现场快照（2026-08-31 会话流专项）', () => {
  let panel: ChatCore;

  beforeEach(() => {
    localStorage.clear();
    freshFs();
    useShellStore.setState({ projectPath: '' });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('带 UI 快照的卷恢复直接采信快照：工具 err/error 态/label 不被降采样', async () => {
    // 预置快照卷 71（恢复路径 = 工作区会话根单读——kernelReadFileRaw 命中）
    H.kernelFs!.fs.setFile(`${PROJ}/.lantai/sessions/71.json`, snapshotVolumeFile());

    panel = createChatPanel();
    panel.setProjectPath(PROJ);
    const { factory } = storingFactory();
    panel.setAgentFactory(factory);

    await panel.loadSessionFromDisk(PROJ, 71);

    const msgs = msgStoreFor(panel.panelId, 71).getState().messages as any[];
    const assistant = msgs.find((m) => m.role === 'assistant');
    const toolPart = assistant?.parts?.find((p: any) => p.type === 'tool');
    // 快照字段全保真（修复前：按 provider 重建 → err 丢、status 归一 done、label 变名）
    expect(toolPart).toMatchObject({ err: 'boom', status: 'error', label: '读取文件', readOnly: true });
    // 轮次簿册已派生（撤回/重发定位权威在沙盒映射——pair 只带身份不带索引）
    expect(Session.getTurnPairs(panel.panelId, 71)).toHaveLength(1);
    expect(Session.getTurnPairs(panel.panelId, 71)[0]).toMatchObject({ userText: 'hi' });
  });

  it('旧档（无 uiMessages）仍走 provider 重建兜底，不炸', async () => {
    // 预置旧档卷 72
    H.kernelFs!.fs.setFile(`${PROJ}/.lantai/sessions/72.json`, legacyVolumeFile());

    panel = createChatPanel();
    panel.setProjectPath(PROJ);
    const { factory } = storingFactory();
    panel.setAgentFactory(factory);

    await panel.loadSessionFromDisk(PROJ, 72);

    const msgs = msgStoreFor(panel.panelId, 72).getState().messages as any[];
    const assistants = msgs.filter((m) => m.role === 'assistant');
    expect(assistants.some((a) => a.parts?.some((p: any) => p.type === 'text' && p.text === '旧答'))).toBe(true);
    expect(Session.getTurnPairs(panel.panelId, 72)).toHaveLength(1);
  });
});

describe('撤回/重发 ID 直达（2026-09-01 重发锚点工程）', () => {
  let panel: ChatCore;

  beforeEach(() => {
    localStorage.clear();
    freshFs();
    useShellStore.setState({ projectPath: '' });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** 半真实 agent 桩：session 真数组 + 真 retractTurnAt（splice 到下一 user 轮）。 */
  function makeAgent(seed?: any[]) {
    const session: any[] = seed ?? [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '答二' },
      { role: 'user', content: '第三问' },
      { role: 'assistant', content: '答三' },
    ];
    return {
      agent: {
        getSession: () => session,
        setSession: (msgs: any[]) => {
          session.length = 0;
          session.push(...msgs);
        },
        retractTurnAt: (i: number) => {
          let end = i + 1;
          while (end < session.length && session[end].role !== 'user') end++;
          session.splice(i, end - i);
        },
        run: vi.fn(async () => {}),
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
        bindSession: vi.fn(),
      },
      session,
    };
  }

  function uiTurn(id: string, text: string): any[] {
    return [
      { _id: id, role: 'user', text },
      {
        _id: `a-${id}`,
        role: 'assistant',
        status: 'done',
        respondingTo: id,
        parts: [{ type: 'text', text: `答-${text}`, finalised: true }],
      },
    ];
  }

  /** 三轮现场：provider 会话 + UI 消息 + pair 簿册（uiMsgId 身份）。 */
  function seedVolume(agent: any, uiMsgs?: any[]): void {
    getChatStore(panel.panelId).sess.setState({
      sessions: [{ id: 9, label: '卷' }],
      activeIdx: 0,
      nextSessionId: 10,
      sessionTokens: {},
    });
    agentSessionState.setAgent(panel.panelId, 9, agent);
    agentSessionState.setTurnPairs(panel.panelId, 9, [
      { userText: '第一问', uiMsgId: 'm1', userBubble: null, assistantBubble: null },
      { userText: '第二问', uiMsgId: 'm2', userBubble: null, assistantBubble: null },
      { userText: '第三问', uiMsgId: 'm3', userBubble: null, assistantBubble: null },
    ]);
    msgStoreFor(panel.panelId, 9)
      .getState()
      .setMessages(uiMsgs ?? [...uiTurn('m1', '第一问'), ...uiTurn('m2', '第二问'), ...uiTurn('m3', '第三问')]);
  }

  const ctx = { storeId: 'snap-panel' } as any;
  const providerTexts = (session: any[]) => session.map((m) => m.content).filter(Boolean);

  it('重发撤回：ID 直达撤对轮次，pair 按 uiMsgId 清理（同文本不互删）', async () => {
    panel = createChatPanel();
    panel.panelId = 'snap-panel';
    const { agent, session } = makeAgent();
    seedVolume(agent);

    const msg = msgStoreFor(panel.panelId, 9)
      .getState()
      .messages.find((m: any) => m._id === 'm2') as any;
    expect(Session.canRetraceUserTurn('snap-panel', 9, 'm2')).toBe(true);
    expect(Session.retractUserMessage(ctx, msg)).toBe(true);

    // 底层会话：第二问轮整体撤除，第三问上移（不叠尸）
    expect(providerTexts(session)).toEqual(['sys', '第一问', '答一', '第三问', '答三']);
    // pair 簿册按 uiMsgId 直达清理，其余两对保留
    const tp = Session.getTurnPairs(panel.panelId, 9);
    expect(tp.map((p) => p.uiMsgId)).toEqual(['m1', 'm3']);
    // 界面 store 同步移除该轮（user + 其 assistant）
    const after = msgStoreFor(panel.panelId, 9).getState().messages;
    expect(after.some((m: any) => m._id === 'm2' || m._id === 'a-m2')).toBe(false);
    expect(after.some((m: any) => m._id === 'm1')).toBe(true);
  });

  it('同文本两条：重发第二条只撤第二条（旧内容兜底的误撤 bug 用例）', async () => {
    panel = createChatPanel();
    panel.panelId = 'snap-panel';
    const { agent, session } = makeAgent([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答二' },
    ]);
    seedVolume(agent, [...uiTurn('u1', '问'), ...uiTurn('u2', '问')]);

    // 撤第二条（位置对位，不按文本搜索——旧实现会同文本命中第一条）
    const second = msgStoreFor(panel.panelId, 9)
      .getState()
      .messages.find((m: any) => m._id === 'u2') as any;
    expect(Session.retractUserMessage(ctx, second)).toBe(true);
    expect(providerTexts(session)).toEqual(['sys', '问', '答一']);

    // 再撤第一条——两轮各自独立可达
    const first = msgStoreFor(panel.panelId, 9)
      .getState()
      .messages.find((m: any) => m._id === 'u1') as any;
    expect(Session.retractUserMessage(ctx, first)).toBe(true);
    expect(providerTexts(session)).toEqual(['sys']);
  });

  it('会话压缩后（sessionIndex 漂移世界）：尾对齐自愈仍撤对轮，被压缩轮降级', async () => {
    panel = createChatPanel();
    panel.panelId = 'snap-panel';
    const { agent, session } = makeAgent();
    seedVolume(agent);
    // 先落一次定位（建立沙盒映射戳），再模拟运行中压缩：头部两轮被摘要替换
    expect(Session.canRetraceUserTurn('snap-panel', 9, 'm2')).toBe(true);
    agent.setSession([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '<compacted-context>前文摘要</compacted-context>' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '答二' },
      { role: 'user', content: '第三问' },
      { role: 'assistant', content: '答三' },
    ]);

    // 第一问已在 provider 里被压缩掉 → 无法唯一定位 → 降级（整体不动）
    const gone = msgStoreFor(panel.panelId, 9)
      .getState()
      .messages.find((m: any) => m._id === 'm1') as any;
    expect(Session.canRetraceUserTurn('snap-panel', 9, 'm1')).toBe(false);
    expect(Session.retractUserMessage(ctx, gone)).toBe(false);
    expect(providerTexts(session)).toEqual([
      'sys',
      '<compacted-context>前文摘要</compacted-context>',
      '第二问',
      '答二',
      '第三问',
      '答三',
    ]);

    // 第二/三问在保留尾内：ID 直达照常撤对（不靠任何记录索引）
    const m2 = msgStoreFor(panel.panelId, 9)
      .getState()
      .messages.find((m: any) => m._id === 'm2') as any;
    expect(Session.retractUserMessage(ctx, m2)).toBe(true);
    expect(providerTexts(session)).toEqual([
      'sys',
      '<compacted-context>前文摘要</compacted-context>',
      '第三问',
      '答三',
    ]);
  });

  it('重建后重发：fresh _id 引用失配不再漏撤（rebuild → retract）', async () => {
    panel = createChatPanel();
    panel.panelId = 'snap-panel';
    const { agent, session } = makeAgent();
    seedVolume(agent);

    // 模拟 /compact 重建：UI 消息按 provider 全量重铸（_id 全新——旧实现
    // msgs.indexOf(msg) 引用失配收不干净，此处以新 _id 直达）
    Session.rebuildMessagesFromMessages(agent.getSession(), panel.panelId, 9);
    const rebuilt = msgStoreFor(panel.panelId, 9)
      .getState()
      .messages.filter((m: any) => m.role === 'user');
    expect(rebuilt).toHaveLength(3);
    const second = rebuilt.find((m: any) => m.text === '第二问') as any;
    expect(second._id).not.toBe('m2');

    expect(Session.retractUserMessage(ctx, second)).toBe(true);
    expect(providerTexts(session)).toEqual(['sys', '第一问', '答一', '第三问', '答三']);
    expect(
      msgStoreFor(panel.panelId, 9)
        .getState()
        .messages.some((m: any) => m.text === '第二问'),
    ).toBe(false);
  });

  it('降级：文本对不上（命令轮）定位失败 → 整体不动，绝不按内容猜下刀', async () => {
    panel = createChatPanel();
    panel.panelId = 'snap-panel';
    const { agent, session } = makeAgent([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '请将以下事实保存到记忆库：x\n\n使用 hologram_memory_save 工具。' },
      { role: 'assistant', content: '已记' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '答二' },
    ]);
    seedVolume(agent, [
      { _id: 'cmd', role: 'user', text: '/remember x' },
      {
        _id: 'a-cmd',
        role: 'assistant',
        status: 'done',
        respondingTo: 'cmd',
        parts: [{ type: 'text', text: '已记', finalised: true }],
      },
      ...uiTurn('m2', '第二问'),
    ]);

    // 气泡文本 ≠ 底层 content（显示标签与实发指令不同源）→ 对不齐 → 降级
    const cmd = msgStoreFor(panel.panelId, 9)
      .getState()
      .messages.find((m: any) => m._id === 'cmd') as any;
    expect(Session.canRetraceUserTurn('snap-panel', 9, 'cmd')).toBe(false);
    expect(Session.retractUserMessage(ctx, cmd)).toBe(false);
    // 两边都原样：provider 不缺轮、UI 不缺块（绝不半撤）
    expect(providerTexts(session)).toEqual([
      'sys',
      '请将以下事实保存到记忆库：x\n\n使用 hologram_memory_save 工具。',
      '已记',
      '第二问',
      '答二',
    ]);
    expect(
      msgStoreFor(panel.panelId, 9)
        .getState()
        .messages.some((m: any) => m._id === 'cmd'),
    ).toBe(true);

    // 正常轮不受连累
    const m2 = msgStoreFor(panel.panelId, 9)
      .getState()
      .messages.find((m: any) => m._id === 'm2') as any;
    expect(Session.retractUserMessage(ctx, m2)).toBe(true);
    expect(providerTexts(session)).toEqual([
      'sys',
      '请将以下事实保存到记忆库：x\n\n使用 hologram_memory_save 工具。',
      '已记',
    ]);
  });
});

describe('改/重发/重试三操作语义（ChatCore 级，2026-09-01 重发锚点工程）', () => {
  let panel: ChatCore;

  beforeEach(() => {
    localStorage.clear();
    freshFs();
    useShellStore.setState({ projectPath: '' });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** 活卷现场：真撤回语义 + run 桩按真 agent 语义落用户消息（可侦察）。 */
  function seedLive(): { p: ChatCore; run: ReturnType<typeof vi.fn> } {
    panel = createChatPanel();
    const session: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '答一' },
    ];
    const run = vi.fn(async (_signal: unknown, text: string) => {
      session.push({ role: 'user', content: text });
    });
    const agent = {
      getSession: () => session,
      setSession: (msgs: any[]) => {
        session.length = 0;
        session.push(...msgs);
      },
      retractTurnAt: (i: number) => {
        let end = i + 1;
        while (end < session.length && session[end].role !== 'user') end++;
        session.splice(i, end - i);
      },
      run,
      setUiSessionId: vi.fn(),
      dispose: vi.fn(),
      cascadeAbort: vi.fn(),
      bindSession: vi.fn(),
    };
    getChatStore(panel.panelId).sess.setState({
      sessions: [{ id: 1, label: '卷' }],
      activeIdx: 0,
      nextSessionId: 2,
      sessionTokens: {},
    });
    agentSessionState.setAgent(panel.panelId, 1, agent as any);
    agentSessionState.setExec(panel.panelId, 1, createExecState());
    msgStoreFor(panel.panelId, 1)
      .getState()
      .setMessages([
        { _id: 'm1', role: 'user', text: '第一问' },
        {
          _id: 'a1',
          role: 'assistant',
          status: 'done',
          respondingTo: 'm1',
          parts: [{ type: 'text', text: '答一', finalised: true }],
        },
      ] as any);
    return { p: panel, run };
  }

  const uiMsgs = (p: ChatCore) => msgStoreFor(p.panelId, 1).getState().messages;
  const inputText = (p: ChatCore) => getChatStore(p.panelId).input.getState().inputText;

  it('改：抄文本进输入框 + 撤旧轮，不自动发送', async () => {
    const { p, run } = seedLive();

    const m1 = uiMsgs(p).find((m) => m.role === 'user') as any;
    p.editUserMessage(m1);
    await new Promise((r) => setTimeout(r, 0));

    expect(inputText(p)).toBe('第一问');
    expect((p.getAgent()!.getSession() as any[]).map((m) => m.content).filter(Boolean)).toEqual(['sys']);
    expect(uiMsgs(p)).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('重发：撤旧轮 + 原文本立即新发（新轮出现）', async () => {
    const { p, run } = seedLive();

    const m1 = uiMsgs(p).find((m) => m.role === 'user') as any;
    p.resendUserMessage(m1);
    await new Promise((r) => setTimeout(r, 0));

    expect(run).toHaveBeenCalledWith(expect.anything(), '第一问');
    expect((p.getAgent()!.getSession() as any[]).map((m) => m.content).filter(Boolean)).toEqual(['sys', '第一问']);
    // 新气泡已铸（新 _id），旧轮（m1/a1）已消失
    const after = uiMsgs(p);
    expect(after.some((m) => m.role === 'user' && m._id !== 'm1')).toBe(true);
    expect(after.some((m) => m._id === 'm1' || m._id === 'a1')).toBe(false);
  });

  it('重试：与重发同轨（撤旧轮 + 原文本重发）', async () => {
    const { p, run } = seedLive();

    const a1 = uiMsgs(p).find((m) => m.role === 'assistant') as any;
    p.retryAssistant(a1);
    await new Promise((r) => setTimeout(r, 0));

    expect(run).toHaveBeenCalledWith(expect.anything(), '第一问');
    expect(uiMsgs(p).some((m) => m._id === 'a1')).toBe(false);
  });

  it('运行中拦截：不撤回、不发送、不抄文本', async () => {
    const { p, run } = seedLive();
    agentSessionState.getExec(p.panelId, 1)!.start();

    const m1 = uiMsgs(p).find((m) => m.role === 'user') as any;
    p.editUserMessage(m1);
    p.resendUserMessage(m1);

    expect(inputText(p)).toBe('');
    expect(uiMsgs(p).some((m) => m._id === 'm1')).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('降级：不可定位轮 → toast 拦截，现场原样（输入框不覆写）', async () => {
    const { p, run } = seedLive();
    // 毒化 UI 文本使对位失败（模拟压缩后 UI 与底层内容错位）
    const m1 = uiMsgs(p).find((m) => m.role === 'user') as any;
    m1.text = '完全对不上的文本';

    getChatStore(p.panelId).input.getState().setInputText('用户正在输入的草稿');
    p.editUserMessage(m1);
    p.resendUserMessage(m1);
    await new Promise((r) => setTimeout(r, 0));

    expect(inputText(p)).toBe('用户正在输入的草稿');
    expect(run).not.toHaveBeenCalled();
    expect((p.getAgent()!.getSession() as any[]).map((m) => m.content).filter(Boolean)).toEqual([
      'sys',
      '第一问',
      '答一',
    ]);
  });
});
