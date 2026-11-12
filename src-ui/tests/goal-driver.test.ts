// @vitest-environment jsdom

// 目标续行驱动器（ChatCore）· 卷身份与重排回归（2026-11-12）。
//
// 考官对象 = GoalDriver 的 `scheduleGoalDrive` / `driveGoal` / `settleGoalRound`
// （2026-11-12 自 chat-core 整件搬出，断言面不变）与 `_runAgentTurn` / `sendMessage`
// 的收尾排程（轮次脚手架仍在 chat-core）。用假 Agent 把「轮」变成可控的
// promise，逐步结算，观察目标状态机与起轮次数（不依赖真实模型）。
//
// 钉住的四条事实（每条都对应一个「目标停在 active 却再也不跑」的真实病灶）：
//   ① 目标轮全程钉在**发起时刻的目标卷**：切卷后运行账、收尾裁决、下一轮排队都不许换卷；
//   ② 切回目标卷会重新排续行（旧实现切走即永久哑火）；
//   ③ 模型在**直人轮里**创建的目标，该轮收尾就开第 1 轮（旧实现只有 /goal 命令那条路会开）；
//   ④ 该卷账上还有别的运行时，排程不丢弃，改挂到空闲转变上（旧实现当场放弃且无人再排）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellStore } from '../src/app/shell-store';

const mockInvoke = vi.fn();
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...(args as [])),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
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
  restoreSecrets: vi.fn((s: unknown) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => {
  const noopTween = () => ({
    kill: () => {},
    play: () => {},
    pause: () => {},
    resume: () => {},
    restart: () => {},
    seek: () => {},
    eventCallback: () => {},
    timeScale: () => {},
    progress: () => {},
    totalProgress: () => {},
  });
  const gsap = {
    set: vi.fn(),
    to: vi.fn(noopTween),
    from: vi.fn(noopTween),
    fromTo: vi.fn(noopTween),
    killTweensOf: vi.fn(),
    isTweening: vi.fn(() => false),
    utils: { toArray: vi.fn(() => []) },
  };
  return { default: gsap, gsap };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import type { RunKind } from '../src/agent/execution-state';
import { createGoal, type GoalHost, readGoal, recordGoalRound } from '../src/agent/goal/service';
import { registerGoalHost } from '../src/agent/goal/session-registry';
import { SessionLog } from '../src/agent/session-log';
import { ChatCore } from '../src/app/chat/chat-core';
import * as Session from '../src/ui/chat-session';
import { getChatStore } from '../src/ui/chat-store';

/** 目标宿主桩：日志就是真源，runKind 由假 Agent 在轮内切换。 */
class HostStub implements GoalHost {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null = null;
  readonly log = new SessionLog();
  kind: RunKind | null = null;
  constructor(id: string, sid: number) {
    this.id = id;
    this.sessionId = String(sid);
  }
  getSessionLog(): SessionLog {
    return this.log;
  }
  currentRunKind(): RunKind | null {
    return this.kind;
  }
}

interface PendingRun {
  kind: 'turn' | 'goal';
  resolve: () => void;
  reject: (e: unknown) => void;
}

let pending: PendingRun[] = [];
const hosts = new Map<number, HostStub>();

/** 假 Agent：run / runGoalRound 各压一条待结算记录；goal 轮按真实语义先落准入事件。 */
function controlledAgent(sid: number) {
  const id = `main-s${sid}`;
  const host = new HostStub(id, sid);
  hosts.set(sid, host);
  const unregister = registerGoalHost(host);
  return {
    id,
    getSession: () => [{ role: 'system', content: 'sys' }],
    setSession: vi.fn(),
    insertMessage: vi.fn(),
    setUiSessionId: vi.fn(),
    cascadeAbort: vi.fn(),
    newSession: vi.fn(),
    retractTurnAt: vi.fn(),
    setThinking: vi.fn(),
    setProvider: vi.fn(),
    setContextWindow: vi.fn(),
    compactNow: vi.fn(async () => ''),
    stopAllSubAgents: vi.fn(() => []),
    runningSubAgentCount: vi.fn(() => 0),
    dispose: vi.fn(() => unregister()),
    bindSession: vi.fn(),
    get nextInsertIndex() {
      return 0;
    },
    run: (signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ kind: 'turn', resolve, reject });
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    runGoalRound: (signal: AbortSignal) => {
      const view = readGoal(host);
      if (!view) return Promise.reject(new Error('no current goal'));
      if (view.phase !== 'active' || view.activation !== 'armed') {
        return Promise.reject(new Error('goal is not armed'));
      }
      recordGoalRound(host, view.roundsStarted + 1);
      host.kind = 'goal';
      return new Promise<void>((resolve, reject) => {
        pending.push({
          kind: 'goal',
          resolve: () => {
            host.kind = null;
            resolve();
          },
          reject: (e) => {
            host.kind = null;
            reject(e);
          },
        });
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
}

async function flush(times = 40): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function setup() {
  pending = [];
  hosts.clear();
  const panel = new ChatCore();
  panel.setProjectPath('D:/ws-goal');
  panel.setAgentFactory(async (sid: number) => controlledAgent(sid));
  await panel.createNewSession();
  await flush();
  const sid = Session.getSessions(panel.panelId)[0]?.id ?? 1;
  const host = hosts.get(sid);
  if (!host) throw new Error('host missing');
  return { panel, host, sid };
}

/** 目标驱动器住自己的模块：测试从排程入口进（与生产调用点同一路径）。
 *  chat-core 只持有一个 GoalDriver 实例，取它即可——不再穿私有字段。 */
function drive(panel: ChatCore, sid?: number): void {
  (panel as unknown as { _goal: { scheduleGoalDrive(s?: number): void } })._goal.scheduleGoalDrive(sid);
}

function kindSequence(): string {
  return pending.map((r) => r.kind).join(',');
}

beforeEach(() => {
  localStorage.clear();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
  useShellStore.setState({ projectPath: '' });
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('目标驱动器 · 正常推进与终结', () => {
  it('一轮结束自动续下一轮；轮上限到顶 = blocked(round-limit)', async () => {
    const { panel, host, sid } = await setup();
    createGoal(host, { objective: 'x', maxGoalRounds: 2 });
    drive(panel, sid);
    await flush();
    expect(kindSequence()).toBe('goal');

    pending[0].resolve();
    await flush();
    expect(kindSequence()).toBe('goal,goal');

    pending[1].resolve();
    await flush();
    const view = readGoal(host);
    expect(view?.phase).toBe('blocked');
    expect(view?.blockedReason?.code).toBe('round-limit');
    expect(view?.roundsStarted).toBe(2);
  });

  it('用户停止 = paused（不是「悄悄不再续行」）', async () => {
    const { panel, host, sid } = await setup();
    createGoal(host, { objective: 'x' });
    drive(panel, sid);
    await flush();
    panel.abort();
    await flush();
    const view = readGoal(host);
    expect(view?.phase).toBe('paused');
    expect(view?.roundsStarted).toBe(1);
    expect(kindSequence()).toBe('goal');
  });

  it('轮内异常 = 只停续行（phase 仍 active，状态条可见「续行已停」，/goal resume 能救）', async () => {
    const { panel, host, sid } = await setup();
    createGoal(host, { objective: 'x' });
    drive(panel, sid);
    await flush();
    pending[0].reject(new Error('连接中断'));
    await flush(60);

    const view = readGoal(host);
    expect(view?.phase).toBe('active');
    expect(view?.activation).toBe('disarmed');
    expect(kindSequence()).toBe('goal');
    // 状态条数据源同源刷新（用户在纸面上看得到「续行已停」）
    expect(getChatStore(panel.panelId).panel.getState().goalView?.activation).toBe('disarmed');
  });
});

describe('目标驱动器 · 卷身份（切卷不再把目标跑丢）', () => {
  it('目标轮在跑时切到新卷：本轮不跨卷续行；切回目标卷立刻接上', async () => {
    const { panel, host, sid } = await setup();
    createGoal(host, { objective: 'A 卷的活', maxGoalRounds: 5 });
    drive(panel, sid);
    await flush();
    expect(kindSequence()).toBe('goal');

    await panel.createNewSession();
    await flush();
    pending[0].resolve();
    await flush(80);

    // 本轮按**目标卷**结算：A 卷仍 active+armed，B 卷没有目标，且没有人替 A 卷开轮
    expect(readGoal(host)?.phase).toBe('active');
    expect(readGoal(host)?.activation).toBe('armed');
    expect(kindSequence()).toBe('goal');

    // 切回 A 卷 = 续行重新排上（旧实现切走即永久哑火）
    panel.switchToSession(sid);
    await flush(80);
    expect(kindSequence()).toBe('goal,goal');
    expect(readGoal(host)?.roundsStarted).toBe(2);
  });

  it('A 卷目标轮在跑时本卷又来了直人轮：两条运行落在同一本账上（不串到活跃的 B 卷）', async () => {
    const { panel, host, sid } = await setup();
    createGoal(host, { objective: 'x', maxGoalRounds: 5 });
    drive(panel, sid);
    await flush();
    expect(kindSequence()).toBe('goal');

    await panel.createNewSession();
    await flush();
    const sessions = Session.getSessions(panel.panelId);
    const sidB = sessions[1].id;
    const execA = Session.getSessionExecState(panel.panelId, sid);
    const execB = Session.getSessionExecState(panel.panelId, sidB);

    // A 卷账上在跑（目标轮），B 卷账空闲
    expect(execA.isRunning).toBe(true);
    expect(execB.isRunning).toBe(false);

    pending[0].resolve();
    await flush(80);
    // B 卷上发一条直人消息：不能因为 A 卷在跑而被吞掉（旧实现按活跃卷判，A 的账挂着
    // 一条记录 → 一切切卷后的判断都是别人的）
    getChatStore(panel.panelId).input.getState().setInputText('B 卷的问题');
    void panel.sendMessage();
    await flush(40);
    expect(kindSequence()).toBe('goal,turn');
  });

  it('两卷各自有目标：A 卷的轮收尾不会替 B 卷开轮', async () => {
    const { panel, host, sid } = await setup();
    createGoal(host, { objective: 'A 的活', maxGoalRounds: 5 });
    drive(panel, sid);
    await flush();

    await panel.createNewSession();
    await flush();
    const sessions = Session.getSessions(panel.panelId);
    const hostB = hosts.get(sessions[1].id);
    if (!hostB) throw new Error('host B missing');
    createGoal(hostB, { objective: 'B 的活', maxGoalRounds: 5 });

    pending[0].resolve();
    await flush(120);
    expect(kindSequence()).toBe('goal');
    expect(readGoal(host)?.roundsStarted).toBe(1);
    expect(readGoal(hostB)?.roundsStarted).toBe(0);
  });
});

describe('目标驱动器 · 进入续行的两条入口', () => {
  it('模型在直人轮里建的目标：该轮收尾就开第 1 轮', async () => {
    const { panel, host, sid } = await setup();
    getChatStore(panel.panelId).input.getState().setInputText('帮我做个大工程');
    void panel.sendMessage();
    await flush(20);
    expect(kindSequence()).toBe('turn');
    // 模型在轮内调用 goal(create)（直人授权的那条路）
    createGoal(host, { objective: '大工程', maxGoalRounds: 5 });
    pending[0].resolve();
    await flush(120);

    expect(kindSequence()).toBe('turn,goal');
    expect(readGoal(host)?.roundsStarted).toBe(1);
    void sid;
  });

  it('该卷账上还有别的运行时，排程挂到空闲转变上，不被丢弃', async () => {
    const { panel, host, sid } = await setup();
    createGoal(host, { objective: 'x', maxGoalRounds: 5 });
    const exec = Session.getSessionExecState(panel.panelId, sid);
    const busy = exec.beginRun('wake');
    drive(panel, sid);
    await flush(40);
    expect(kindSequence()).toBe('');

    busy.end();
    await flush(80);
    expect(kindSequence()).toBe('goal');
    expect(readGoal(host)?.roundsStarted).toBe(1);
  });
});
