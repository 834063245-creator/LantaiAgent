// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 题签态发斜杠命令（2026-11-21 用户报）：**命令不许交给别的卷**。
//
// 用户原话：「题签态直接发斜杠命令不允许交给其他卷」。病灶形状：待题纸在场时这一句是
// 这张纸的话，而「带卷语义」的命令（/compact /export /goal /memory /remember）作用于
// **活跃卷**——纸上敲下去，改的是画布上另一张卷，用户根本没在说那张卷。
//
// 而今语义只留一条线：**纸期这一类命令既不陈列也不执行**（先发一句话开卷，再在卷里用）；
// 与卷无关的（/settings /new…）照常；未知斜杠（技能）= 一句要发给模型的话，**先开卷再发**，
// 发给**刚开出来的那一卷**。
//
// 穿的真实面：ChatCore.sendMessage（纸在场分支 + 斜杠分派）→ 真 openDraftVolume（真发号）
// → 真 Agent.run。只有 provider 是假的。

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockRpc('rpc', ...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));

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

import './helpers/kernel-registry';
import { installCompactionForTest } from './helpers/compaction-impl';

installCompactionForTest();

import { ToolRegistry } from '../src/agent/tool';
import { ChatCore } from '../src/app/chat/chat-core';
import { listCommands } from '../src/app/commands/command-catalog';
import { useShellStore } from '../src/app/shell-store';
import type { Chunk, Provider, Request } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { useToastStore } from '../src/state/toast-store';
import { resetSessionListCacheForTests } from '../src/ui/chat-session';
import { getChatStore } from '../src/ui/chat-store';
import { createTestAgent } from './helpers/agent';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

const PROJ = 'D:/ws-draft-slash';

/** 记录请求的 provider（正常应答一轮就结束）。 */
function recordingProvider(sink: Request[]): Provider {
  return {
    name: () => 'mock',
    model: () => 'mock',
    stream: (_signal: AbortSignal, req: Request) =>
      (async function* (): AsyncGenerator<Chunk> {
        sink.push(req);
        yield { type: ChunkType.Text, text: '收到。' };
        yield { type: ChunkType.Done } as Chunk;
      })(),
  };
}

function panelWith(prov: Provider): ChatCore {
  const panel = new ChatCore();
  panel.setProjectPath(PROJ);
  panel.setAgentFactory(
    async (sid: number) =>
      createTestAgent(prov, new ToolRegistry(), 'sys', {
        eventSink: panel.eventSinkFor(sid),
        contextWindow: 0,
      }) as unknown as never,
  );
  return panel;
}

function inputOf(panel: ChatCore) {
  return getChatStore(panel.panelId).input.getState();
}

function sessionCount(panel: ChatCore): number {
  return getChatStore(panel.panelId).sess.getState().sessions.length;
}

/** 轮询等待（起轮是异步的：开卷 → 句柄水合 → Agent.run，微任务 ticks 数不定）。 */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function lastUser(req: Request | undefined) {
  const msgs = req?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return msgs[i];
  }
  return undefined;
}

beforeEach(() => {
  localStorage.clear();
  mockRpc.mockReset();
  mockRpc.mockResolvedValue(null);
  useShellStore.setState({ projectPath: PROJ });
  useToastStore.setState({ toasts: [] });
  useDraftSheetStore.getState().dismissAll();
  resetSessionListCacheForTests();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('题签态 · 带卷语义的命令不跨卷', () => {
  it('出厂命令的卷语义标记成立（/new 不标：它不作用于某一卷）', () => {
    const panel = panelWith(recordingProvider([]));
    const byId = new Map(listCommands(panel).map((c) => [c.id, c]));
    // local 型才会拿别的卷当靶子（send / skill 型本来就是「一句要发出去的话」，纸期照常开卷发送）
    for (const id of ['compact', 'export', 'goal', 'remember']) {
      expect(byId.get(id)?.volumeCommand, `${id} 必须标 volumeCommand（否则纸期会拿别的卷当靶子）`).toBe(true);
    }
    expect(byId.get('new')?.volumeCommand).toBeUndefined();
  });

  it('纸上敲 /compact：不建卷、不执行、字还在（旧形态 = 回车后开了张空卷并吃掉这句话）', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    await panel.createNewSession(); // 画布上有一张别的卷（命令面本来会打到它头上）
    panel.renameSession(1, '别的卷');
    useDraftSheetStore.getState().openSheet();
    inputOf(panel).setInputText('/compact');

    await panel.sendMessage();
    await Promise.resolve();

    expect(sessionCount(panel), '纸期敲带卷语义的命令不该开卷').toBe(1);
    expect(useDraftSheetStore.getState().papers.length, '纸必须还在（这一句没发出去）').toBe(1);
    expect(inputOf(panel).inputText, '那句话被吃掉了').toBe('/compact');
    expect(reqs, '命令被交给活跃卷的 Agent 了').toEqual([]);
    expect(useToastStore.getState().toasts.length, '拒绝要可见（错误不静默）').toBeGreaterThan(0);
  });
});

describe('题签态 · 与卷无关的命令照常，但不开卷', () => {
  it('纸上敲 /settings：照常执行，画布上不多出一张空卷', async () => {
    const panel = panelWith(recordingProvider([]));
    useDraftSheetStore.getState().openSheet();
    const dispose = ensureProductionChannelsBooted().then((root) =>
      root.commands.register({
        id: 'probe/settings-like',
        label: '开关型探针',
        group: '测试',
        slash: '/probe-settings',
        action: { type: 'local', handler: () => {} },
      }),
    );
    const off = await dispose;
    try {
      inputOf(panel).setInputText('/probe-settings');
      await panel.sendMessage();
      await Promise.resolve();
      expect(sessionCount(panel), '开关型命令不该替用户烧一个号').toBe(0);
      expect(useDraftSheetStore.getState().papers.length, '纸该还在').toBe(1);
    } finally {
      off();
    }
  });

  it('纸上敲 /new：提示「这张纸就是新卷」，不烧号', async () => {
    const panel = panelWith(recordingProvider([]));
    await panel.createNewSession();
    useDraftSheetStore.getState().openSheet();
    inputOf(panel).setInputText('/new');

    await panel.sendMessage();
    await Promise.resolve();

    expect(sessionCount(panel), '纸期按 /new 又烧了一个号（双卷病灶）').toBe(1);
    expect(useDraftSheetStore.getState().papers.length, '纸该还在').toBe(1);
    expect(inputOf(panel).inputText, '那句话被吃掉了').toBe('/new');
  });
});

describe('题签态 · send 型命令 = 一句要发给模型的话', () => {
  it('纸上敲 /memory：开卷并把命令发给**新卷**（不碰画布上别的卷）', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    await panel.createNewSession(); // 别的卷在案头，旧形态会把 /memory 发给它
    panel.renameSession(1, '别的卷');
    useDraftSheetStore.getState().openSheet();
    inputOf(panel).setInputText('/memory');

    await panel.sendMessage();
    await until(() => reqs.length > 0);

    expect(sessionCount(panel), '纸没有化成新卷').toBe(2);
    expect(reqs.length, '/memory 没发出去').toBeGreaterThan(0);
    expect(lastUser(reqs[0])?.content ?? '', '命令发给了别的卷的 Agent').toContain('列出所有已保存的记忆');
  });
});

describe('题签态 · 未知斜杠（技能）= 一句要发出去的话', () => {
  it('先开卷再发，且发给**刚开出来的那一卷**', async () => {
    const reqs: Request[] = [];
    const panel = panelWith(recordingProvider(reqs));
    useDraftSheetStore.getState().openSheet();
    inputOf(panel).setInputText('/some-skill');

    await panel.sendMessage();
    await until(() => reqs.length > 0);

    expect(sessionCount(panel), '纸化成卷失败').toBe(1);
    expect(reqs.length, '技能请求没发出去').toBeGreaterThan(0);
    expect(lastUser(reqs[0])?.content ?? '', '技能没有发给新卷的 Agent').toContain('Execute skill: some-skill');
  });
});

describe('题签态 · 面板点选同一条闸（executeCommand 不经过 sendMessage）', () => {
  it('纸上点选 /goal：被拒，不执行、不建卷（旧形态直接落到活跃卷头上）', async () => {
    const panel = panelWith(recordingProvider([]));
    await panel.createNewSession();
    useDraftSheetStore.getState().openSheet();
    const goal = listCommands(panel).find((c) => c.id === 'goal');
    if (!goal) throw new Error('出厂命令里没有 /goal');

    // 直接走面板点选那条路（executeCommand），绕开 sendMessage——这正是过去漏判的入口
    const blocked = panel.commandBlockedInDraft(goal);
    expect(blocked, '纸期点选 /goal 竟然没被拦').not.toBeNull();
    panel.executeCommand(goal, 'pause');
    await Promise.resolve();

    expect(sessionCount(panel), '面板点选把卷烧掉了').toBe(1);
    expect(useDraftSheetStore.getState().papers.length, '纸该还在').toBe(1);
  });

  it('纸上点选与卷无关的开关：照常执行', () => {
    const panel = panelWith(recordingProvider([]));
    useDraftSheetStore.getState().openSheet();
    const handler = vi.fn();
    const command = {
      id: 'probe/panel-ok',
      label: '开关探针',
      group: '测试',
      slash: '/probe-ok',
      action: { type: 'local' as const, handler },
    };
    expect(panel.commandBlockedInDraft(command)).toBeNull();
    panel.executeCommand(command);
    expect(handler).toHaveBeenCalled();
  });
});
