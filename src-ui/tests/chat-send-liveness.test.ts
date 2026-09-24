// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 发送→回复链路活性（2026-09-13 诊断 / 2026-09-14 收口）——反馈环测试台。
//
// 用户症状：「发出消息到收到回复的 pipeline 肯定有断点，经常莫名其妙的模型不响应，
// 模型通讯是通的」。用词是「不响应」——不是报错、不是崩溃，是**什么都没发生**：
// 来文气泡出现，然后既没有回复，也没有任何留在案卷里的痕迹。
//
// 本环断言两类不变量：
//   ① 一轮发送结束后，案卷里不得留下「悬空来文」——要么有助手消息（回复到了），
//      要么有持久的错误墓碑（回合自身写下的败因）。只有瞬时 toast 不算数：
//      toast 6.4 秒后消失，案卷里仍是相邻两条来文——既让用户看见「模型不响应」，
//      又让下一轮载荷带着两条相邻 user 消息上路。
//   ② 用户主动停止仍然必须是**静默**的——不许因为「错误不静默」把用户自己的
//      停止意图变成一条报错（这是本环的守门用例，防过度纠正）。
//
// 穿的真实面：ChatCore.sendMessage → 真 Agent.run（真 stream/streamOnce/retry 分类）
// → 真 eventSinkFor → 真 chat-stream → 真消息 store。只有 provider 是假的
// （故障注入点就在这）。
//
// ⚠ 第三种形态「永不落定的传输 = 回合永久挂起」**不在本环**：它要求请求级硬截止 /
// 回合看门狗（另一批），复现配方与现状见 docs/landmine-map.md 第四批 L3。
// mock 面沿用 send-stream-corruption.test.ts + agent-stream-stall-retry.test.ts。

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

import { NO_PROGRESS_WARN_MS, RUN_ABANDON_MS, setRunWatchdogThresholds } from '../src/agent/run-watchdog';
// 批 6d-2：压缩实现（compaction 产物）在生产由装载器常驻登记；
// service 类 ⇒ 缺实现在调用点 fail-loud——本文件自行装配/驱动 Agent，须先复现该登记态。
import { installCompactionForTest } from './helpers/compaction-impl';

installCompactionForTest();

import { ToolRegistry } from '../src/agent/tool';
import { ChatCore } from '../src/app/chat/chat-core';
import { useShellStore } from '../src/app/shell-store';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { useToastStore } from '../src/state/toast-store';
import { resetSessionListCacheForTests } from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage } from '../src/ui/message-model';
import { createTestAgent } from './helpers/agent';

const PROJ = 'D:/ws-liveness';

/** 生产日志原文（2026-08-17 / 08-21 实机出现过三次）——传输出自己断的形态。 */
const TRANSPORT_ABORT_MSG = 'BodyStreamBuffer was aborted';

/* ── 假 provider 工厂（故障注入点）── */

/** 正常应答（基线必须绿）。 */
function healthyProvider(): Provider {
  return {
    name: () => 'mock',
    model: () => 'mock',
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        yield { type: ChunkType.Text, text: '收到。' };
        yield { type: ChunkType.Done } as Chunk;
      })(),
  };
}

/** 前 `failures` 次抛中止族错误，之后正常回答（模拟链路自愈）。 */
function flakyAbortProvider(failures: number): { prov: Provider; calls: () => number } {
  let calls = 0;
  const prov: Provider = {
    name: () => 'mock',
    model: () => 'mock',
    stream: () => {
      calls++;
      const n = calls;
      return (async function* (): AsyncGenerator<Chunk> {
        if (n <= failures) throw new Error(TRANSPORT_ABORT_MSG);
        yield { type: ChunkType.Text, text: '恢复了。' };
        yield { type: ChunkType.Done } as Chunk;
      })();
    },
  };
  return { prov, calls: () => calls };
}

/** 先吐一段文本，再等外部停止（真机形态：body stream 被掐断）。 */
function stoppableProvider(): Provider {
  return {
    name: () => 'mock',
    model: () => 'mock',
    stream: (signal: AbortSignal) =>
      (async function* (): AsyncGenerator<Chunk> {
        yield { type: ChunkType.Text, text: '开始回答' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error(TRANSPORT_ABORT_MSG);
      })(),
  };
}

/** 永不产出、永不结束，且**无视 signal**（landmine L3 的病灶形态）。 */
function blackHoleProvider(): Provider {
  return {
    name: () => 'mock',
    model: () => 'mock',
    stream: () =>
      (async function* (): AsyncGenerator<Chunk> {
        await new Promise<void>(() => {});
        yield { type: ChunkType.Text, text: '迟到的一口' };
      })(),
  };
}

/* ── 面板装配（真 Agent 经工厂进面板）── */

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

function send(panel: ChatCore, text: string): Promise<void> {
  getChatStore(panel.panelId).input.getState().setInputText(text);
  return panel.sendMessage();
}

/** 案卷终局：助手消息 / 持久错误墓碑 / 悬空来文。 */
function outcome(
  panel: ChatCore,
  sid: number,
): { msgs: ChatMessage[]; assistants: AssistantMessage[]; tombstoned: AssistantMessage[]; dangling: boolean } {
  const msgs = msgStoreFor(panel.panelId, sid).getState().messages;
  const assistants = msgs.filter((m): m is AssistantMessage => m.role === 'assistant');
  const tombstoned = assistants.filter((m) => m.status === 'error' || !!m.errorMessage);
  const last = msgs[msgs.length - 1];
  return { msgs, assistants, tombstoned, dangling: !!last && last.role === 'user' };
}

/** 不变量①：一轮结束后不得留下悬空来文。 */
function expectNoDanglingUser(panel: ChatCore, sid: number, label: string): void {
  const o = outcome(panel, sid);
  const toasts = useToastStore
    .getState()
    .toasts.map((t) => `${t.level}:${t.text}`)
    .join(' | ');
  expect(
    o.dangling,
    `${label}：回合静默蒸发——案卷里留下悬空来文，无助手消息、无持久墓碑` +
      `（瞬时 toast 不算数：${toasts || '（连 toast 都没有）'}）`,
  ).toBe(false);
}

const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  localStorage.clear();
  mockRpc.mockReset();
  mockRpc.mockResolvedValue(null);
  useShellStore.setState({ projectPath: '' });
  useToastStore.setState({ toasts: [] });
  // 工作区级模块态（卷目录 + 发号账，B·2026-09-21）逐例清空——每个用例 = 一个全新工作区，
  // 否则上一例发出的号会延续下来（号按工作区单调），而本文件的用例以「卷 1」为固定夹具。
  resetSessionListCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('发送链路活性（反馈环）', () => {
  it('基线：正常应答——助手回复落进案卷，无悬空来文', async () => {
    const panel = panelWith(healthyProvider());
    await panel.createNewSession();
    await send(panel, '在吗');
    const o = outcome(panel, 1);
    expect(o.assistants.length).toBeGreaterThan(0);
    expectNoDanglingUser(panel, 1, '基线');
  });

  it('中止族失败（非用户停止，链路自愈）——必须重试，且回复落进案卷', async () => {
    const { prov, calls } = flakyAbortProvider(2);
    const panel = panelWith(prov);
    await panel.createNewSession();

    // 退避是真实定时器（1s→2s + 抖动）——用假时钟推完
    vi.useFakeTimers();
    const done = send(panel, '在吗');
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    // ① 不再冒充用户停止：传输出自己断的中止照样重试
    expect(calls(), '中止族错误被当成用户按了停止，一次都没重试').toBeGreaterThan(1);
    // ② 链路恢复后回复落进案卷
    const o = outcome(panel, 1);
    expect(o.assistants.length).toBeGreaterThan(0);
    expectNoDanglingUser(panel, 1, '中止族失败（自愈）');
  });

  it('中止族失败（持续）——重试耗尽后必须落墓碑，不得静默', async () => {
    const { prov, calls } = flakyAbortProvider(Number.MAX_SAFE_INTEGER);
    const panel = panelWith(prov);
    await panel.createNewSession();

    vi.useFakeTimers();
    const done = send(panel, '在吗');
    await vi.advanceTimersByTimeAsync(60_000);
    await done;

    // 计数预算：首次 + MAX_RETRIES(3) = 4 次尝试，一次不多
    expect(calls()).toBe(4);
    const o = outcome(panel, 1);
    expect(o.tombstoned.length, '重试耗尽却无墓碑——错误被静默吞掉').toBeGreaterThan(0);
    expect(o.tombstoned[0].errorMessage ?? '').toContain('[传输中断]');
    expectNoDanglingUser(panel, 1, '中止族失败（持续）');
  });

  it('守门：用户主动停止仍然静默——只落已产出的文本，不落错误墓碑', async () => {
    const panel = panelWith(stoppableProvider());
    await panel.createNewSession();

    const done = send(panel, '在吗');
    await flush(); // 等首个文本 chunk 落地（流式助手已建）
    panel.abort();
    await done;
    await flush();

    const o = outcome(panel, 1);
    const text = o.assistants
      .flatMap((m) => m.parts)
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text, '用户停止后已产出的文本不得丢失').toContain('开始回答');
    expect(o.tombstoned, '用户自己的停止被当成错误播报（过度纠正）').toEqual([]);
  });

  // 第三种形态（2026-09-20 补齐，原文件头注点名的缺口）：**永不落定的传输**
  // —— provider 不认 signal，停止钮对它无效。硬截止（运行看门狗）到期之后，
  // 用户必须看见墓碑而不是「模型不响应」。
  it('永不落定的传输：硬截止到期后必须落墓碑（结果未知，勿当成功继续），且不悬空来文', async () => {
    const panel = panelWith(blackHoleProvider());
    await panel.createNewSession();

    // 真机阈值 20 分钟不适合测试台：走看门狗的阈值注入面（同一份代码路径）
    setRunWatchdogThresholds({ warnMs: 200, abandonMs: 600 });
    vi.useFakeTimers();
    try {
      const done = send(panel, '在吗');
      // 先排空微任务（Agent 装配/首次请求发出），再推时钟——假时钟下别把
      // 「装配链的微任务」和「定时器推进」混在一句里（会互相等成死锁）。
      await flush(30);
      // 看门狗按固定间隔巡检（30s 步长），推进量要跨过巡检点才会看到 abandon=600ms
      await vi.advanceTimersByTimeAsync(60_000);
      await done;
      await flush();

      const o = outcome(panel, 1);
      expect(o.tombstoned.length, '硬截止到期却没有墓碑——用户只看见「模型不响应」').toBeGreaterThan(0);
      // 文案纪律（用户 2026-09-20 定的墓碑口径）：作废 + 结果未知 + 勿当成功继续，
      // 三件事都要在，缺一用户就会把作废轮当成功读下去。
      const text = o.tombstoned[0].errorMessage ?? '';
      expect(text, `墓碑文案不含作废口径：${text}`).toContain('超硬截止已作废');
      expect(text).toContain('结果未知，勿当成功继续');
      // 硬截止的事实也要可见（runId / 无进展时长 / 最后脉搏）
      expect(text).toMatch(/runId=\d+/);
      expectNoDanglingUser(panel, 1, '硬截止作废');
      // 作废之后立刻可重发：运行账空闲（用户不必等这条挂死的链路）
      const exec = (panel as unknown as { _activeExec(): { isRunning: boolean } })._activeExec();
      expect(exec.isRunning).toBe(false);
    } finally {
      setRunWatchdogThresholds({ warnMs: NO_PROGRESS_WARN_MS, abandonMs: RUN_ABANDON_MS });
    }
  });
});
