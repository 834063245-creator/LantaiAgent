// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// session-restore-snapshot — 2026-08-31 会话流专项回归：
//   刀一 恢复路径直接采信磁盘 UI 快照（uiMessages），不再按 provider 消息
//        重建（重建是降采样：工具 err 丢弃、status 归一、label 变名）。
//   刀二 撤回/重发后底层会话与界面同源：内容兜底定位 + 剩余轮次重映射 +
//        旧 turnPair 残留清除（重发叠尸 = 恢复重复渲染的数据根因）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock bridge — 与 chat-session.test.ts 同款（Tauri invoke 通道）──
const mockInvoke = vi.fn();
async function mockRpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const snakeKey = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
      normalized[snakeKey] = value;
    }
  }
  return mockInvoke('rpc', { method, params: normalized });
}
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));

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
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
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
import { ChatCore } from '../src/app/chat/chat-core';
import { useShellStore } from '../src/app/shell-store';
import * as Session from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

const PROJ = 'D:/snapshot-proj';

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
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(null);
    useShellStore.setState({ projectPath: '' });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('带 UI 快照的卷恢复直接采信快照：工具 err/error 态/label 不被降采样', async () => {
    panel = createChatPanel();
    panel.setProjectPath(PROJ);
    const { factory } = storingFactory();
    panel.setAgentFactory(factory);
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method, params } = payload;
      if (method === 'read_file_content' && params.file_path?.endsWith('/71.json')) {
        return Promise.resolve(snapshotVolumeFile());
      }
      void params;
      return Promise.resolve('ok');
    });

    await panel.loadSessionFromDisk(PROJ, 71);

    const msgs = msgStoreFor(panel.panelId, 71).getState().messages as any[];
    const assistant = msgs.find((m) => m.role === 'assistant');
    const toolPart = assistant?.parts?.find((p: any) => p.type === 'tool');
    // 快照字段全保真（修复前：按 provider 重建 → err 丢、status 归一 done、label 变名）
    expect(toolPart).toMatchObject({ err: 'boom', status: 'error', label: '读取文件', readOnly: true });
    // 轮次表已派生（撤回/重发定位可用）
    expect(Session.getTurnPairs(panel.panelId, 71)).toHaveLength(1);
    expect(Session.getTurnPairs(panel.panelId, 71)[0]).toMatchObject({ userText: 'hi', sessionIndex: 1 });
  });

  it('旧档（无 uiMessages）仍走 provider 重建兜底，不炸', async () => {
    panel = createChatPanel();
    panel.setProjectPath(PROJ);
    const { factory } = storingFactory();
    panel.setAgentFactory(factory);
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method, params } = payload;
      if (method === 'read_file_content' && params.file_path?.endsWith('/72.json')) {
        return Promise.resolve(legacyVolumeFile());
      }
      void params;
      return Promise.resolve('ok');
    });

    await panel.loadSessionFromDisk(PROJ, 72);

    const msgs = msgStoreFor(panel.panelId, 72).getState().messages as any[];
    const assistants = msgs.filter((m) => m.role === 'assistant');
    expect(assistants.some((a) => a.parts?.some((p: any) => p.type === 'text' && p.text === '旧答'))).toBe(true);
    expect(Session.getTurnPairs(panel.panelId, 72)).toHaveLength(1);
  });
});

describe('撤回/重发双源收敛（2026-08-31 会话流专项）', () => {
  let panel: ChatCore;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(null);
    useShellStore.setState({ projectPath: '' });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** 半真实 agent 桩：session 真数组 + 真 retractTurnAt（splice 到下一 user 轮）。 */
  function makeAgent() {
    const session: any[] = [
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
        dispose: vi.fn(),
        cascadeAbort: vi.fn(),
        bindSession: vi.fn(),
      },
      session,
    };
  }

  function seedVolume(agent: any): void {
    getChatStore(panel.panelId).sess.setState({
      sessions: [{ id: 9, label: '卷' }],
      activeIdx: 0,
      nextSessionId: 10,
      sessionTokens: {},
    });
    agentSessionState.setAgent(panel.panelId, 9, agent);
    agentSessionState.setTurnPairs(panel.panelId, 9, [
      { userText: '第一问', userBubble: null, assistantBubble: null, sessionIndex: 1 },
      { userText: '第二问', userBubble: null, assistantBubble: null, sessionIndex: 3 },
      { userText: '第三问', userBubble: null, assistantBubble: null, sessionIndex: 5 },
    ]);
    msgStoreFor(panel.panelId, 9)
      .getState()
      .setMessages([
        { _id: 'm1', role: 'user', text: '第一问', sessionIndex: 1 },
        { _id: 'a1', role: 'assistant', text: '答一' },
        { _id: 'm2', role: 'user', text: '第二问', sessionIndex: 3 },
        { _id: 'a2', role: 'assistant', text: '答二' },
        { _id: 'm3', role: 'user', text: '第三问', sessionIndex: 5 },
        { _id: 'a3', role: 'assistant', text: '答三' },
      ] as any);
  }

  const ctx = { storeId: 'snap-panel' } as any;

  it('重发撤回：底层会话撤对轮次、剩余配对重映射、旧 pair 清除', async () => {
    panel = createChatPanel();
    panel.panelId = 'snap-panel';
    const { agent, session } = makeAgent();
    seedVolume(agent);

    const msg = msgStoreFor(panel.panelId, 9)
      .getState()
      .messages.find((m: any) => m.text === '第二问') as any;
    Session._retractUserMessage(ctx, msg);

    // 底层会话：第二问轮整体撤除，第三问上移（不再叠尸）
    expect(session.map((m: any) => m.content).filter(Boolean)).toEqual(['sys', '第一问', '答一', '第三问', '答三']);
    // 旧 turnPair 清除 + 剩余配对 sessionIndex 重映射（第三问 5 → 3）
    const tp = Session.getTurnPairs(panel.panelId, 9);
    expect(tp).toHaveLength(2);
    expect(tp[1]).toMatchObject({ userText: '第三问', sessionIndex: 3 });
    // 界面 store 同步移除该轮
    expect(
      msgStoreFor(panel.panelId, 9)
        .getState()
        .messages.some((m: any) => m.text === '第二问'),
    ).toBe(false);
  });

  it('记录索引已漂移（越界）时按内容兜底对位，不撤错轮', async () => {
    panel = createChatPanel();
    panel.panelId = 'snap-panel';
    const { agent, session } = makeAgent();
    seedVolume(agent);

    // 毒化 sessionIndex：越界（模拟旧数据/压缩后未重映射）
    const msg = msgStoreFor(panel.panelId, 9)
      .getState()
      .messages.find((m: any) => m.text === '第二问') as any;
    msg.sessionIndex = 99;
    Session._retractUserMessage(ctx, msg);

    // 仍撤掉第二问那轮（内容兜底命中 provider 会话），其余轮次保留
    expect(session.map((m: any) => m.content).filter(Boolean)).toEqual(['sys', '第一问', '答一', '第三问', '答三']);
    const tp = Session.getTurnPairs(panel.panelId, 9);
    expect(tp.find((p) => p.userText === '第二问')).toBeUndefined();
    expect(tp.find((p) => p.userText === '第三问')?.sessionIndex).toBe(3);
  });
});
