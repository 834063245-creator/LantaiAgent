// 停止链路回归（2026-09-03「停止后会话坏掉」诊断）：
//   ① abort() 的 3s 安全网定时器不得误杀停止后新发起的轮次
//      （旧缺陷：stop() 同步置 idle 后才注册 onChange 订阅 → 订阅永不在意
//       「已过去」的 idle 转变 → safety 永不清除 → 3s 后把用户新轮 forceReset，
//       aborted 错误被 sendMessage catch 静默吞掉 → 「新输入无任何响应」）
//   ② 旧轮（停止后迟到解旋）的 finally 不得终结新轮刚建立的流式助手
//      （旧缺陷：finishTurn 无轮次身份守卫，会把新轮 streamingAssistantId
//       清空、新轮助手标 done → 新轮响应丢失/劈开）
// mock 面沿用 session-unify-u3.test.ts（bridge rpc 归一化 + 静态模块替身）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellStore } from '../src/app/shell-store';

const mockInvoke = vi.fn();
async function mockRpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const snakeKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
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
  const createNoopTween = () => ({
    kill: () => {},
    play: () => {},
    pause: () => {},
    resume: () => {},
    restart: () => {},
    seek: () => {},
    // biome-ignore lint/suspicious/noThenProperty: GSAP tween 接口形状（thenable mock）
    then: () => {},
    eventCallback: () => {},
    timeScale: () => {},
    progress: () => {},
    totalProgress: () => {},
  });
  const gsap = {
    set: vi.fn(),
    to: vi.fn(createNoopTween),
    from: vi.fn(createNoopTween),
    fromTo: vi.fn(createNoopTween),
    killTweensOf: vi.fn(),
    isTweening: vi.fn(() => false),
    utils: { toArray: vi.fn(() => []) },
  };
  return { default: gsap, gsap };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { ChatCore } from '../src/app/chat/chat-core';
import * as Session from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage } from '../src/ui/message-model';
import { createAssistantMessage } from '../src/ui/message-model';

/** 可控的假 Agent —— run() 返回由测试手动结算的 promise（模拟挂起/迟到解旋）。 */
interface ControlledRun {
  signal: AbortSignal;
  resolve: () => void;
  reject: (e: unknown) => void;
}

function controlledAgent(runs: ControlledRun[]) {
  return {
    id: 'main-test',
    run: (signal: AbortSignal, _text: string) =>
      new Promise<void>((resolve, reject) => {
        runs.push({ signal, resolve, reject });
      }),
    insertMessage: vi.fn(),
    setUiSessionId: vi.fn(),
    cascadeAbort: vi.fn(),
    getSession: () => [{ role: 'system', content: 'sys' }] as any,
    setSession: vi.fn(),
    newSession: vi.fn(),
    retractTurnAt: vi.fn(),
    setThinking: vi.fn(),
    setProvider: vi.fn(),
    setContextWindow: vi.fn(),
    runGoal: vi.fn(),
    resumeGoal: vi.fn(),
    compactNow: vi.fn(async () => ''),
    stopAllSubAgents: vi.fn(() => []),
    runningSubAgentCount: vi.fn(() => 0),
    get nextInsertIndex() {
      return 0;
    },
    dispose: vi.fn(),
    bindSession: vi.fn(),
  } as any;
}

/** 建面板 + 单会话 + 可控 agent；返回发起轮次的辅助。 */
async function setupPanel() {
  const runs: ControlledRun[] = [];
  const panel = new ChatCore();
  panel.setProjectPath('D:/ws-stop');
  panel.setAgentFactory(async () => controlledAgent(runs));
  await panel.createNewSession();
  const sid = Session.getSessions(panel.panelId)[0]?.id ?? 1;
  const send = (text: string) => {
    getChatStore(panel.panelId).input.getState().setInputText(text);
    void panel.sendMessage();
  };
  return { panel, runs, sid, send };
}

/** 微任务排水（无定时器依赖的链路收敛）。 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
  useShellStore.setState({ projectPath: '' });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('停止链路：停止后新输入必须能正常得到响应', () => {
  it('① 停止后 3 秒内发送的新轮次不被 abort() 的安全网定时器误杀', async () => {
    vi.useFakeTimers();
    const { panel, runs, sid, send } = await setupPanel();
    const exec = Session.getSessionExecState(panel.panelId, sid);

    // 第一轮发起 → agent 挂起（模拟 shell 工具挂死）
    send('第一轮（挂起）');
    await flush();
    expect(runs.length).toBe(1);
    expect(exec.isRunning).toBe(true);
    const sigA = runs[0].signal;

    // 用户点停：本轮 signal 中止、exec 同步复位
    panel.abort();
    expect(sigA.aborted).toBe(true);
    expect(exec.isRunning).toBe(false);

    // 用户在 3 秒窗口内发新消息（挂起时输入框通常已打好字）
    send('第二轮（新输入）');
    await flush();
    expect(runs.length).toBe(2);
    const sigB = runs[1].signal;
    expect(exec.isRunning).toBe(true);

    // 3s 安全网到点 —— 新轮必须仍然活着
    await vi.advanceTimersByTimeAsync(3500);
    expect(sigB.aborted).toBe(false);
    expect(exec.isRunning).toBe(true);

    // 收尾：结算 pending 的 run，防悬挂 promise
    runs[0].resolve();
    runs[1].resolve();
    await flush();
  });

  it('② 旧轮（停止后迟到解旋）的 finishTurn 不得终结新轮刚建立的流式助手', async () => {
    vi.useFakeTimers();
    const { panel, runs, sid, send } = await setupPanel();

    // 第一轮发起 → 挂起 → 用户点停
    send('第一轮（挂起）');
    await flush();
    panel.abort();

    // 3 秒窗口内用户发第二轮，且新轮已开始流式（消息 store 出现流式助手）
    send('第二轮（新输入）');
    await flush();
    expect(runs.length).toBe(2);
    const store = msgStoreFor(panel.panelId, sid);
    const assistant = createAssistantMessage('m-user-2');
    store.getState().setMessages([...store.getState().messages, assistant]);
    store.getState().setStreamingAssistantId(assistant._id);

    // 旧轮此刻才解旋（abort 传播到挂起工具的落地延迟）
    runs[0].resolve();
    await flush();

    // 新轮的流式助手必须原封不动（未被旧轮 finally 终结）
    expect(store.getState().streamingAssistantId).toBe(assistant._id);
    const kept = store.getState().messages.find((m) => m._id === assistant._id) as AssistantMessage;
    expect(kept).toBeDefined();
    expect(kept.status).toBe('streaming');

    // 收尾
    runs[1].resolve();
    await flush();
  });
});
