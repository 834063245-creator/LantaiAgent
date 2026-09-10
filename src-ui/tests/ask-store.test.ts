// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask-store 回归测试（P1 事件归零：prompt:ask → state/ask-store；
// 见 docs/plans/eventbus-zero-and-ui-split-plan.md 风险表——callback 生命周期）。
// 覆盖：
//   1. pushAsk 递增 seq；consumeAsk 取走 pending 并清空（幂等，不会双消费）
//   2. pending 期 chat-core 重建：构造即回放在途请求（bus 时代 emit 早于订阅即丢失）
//   3. 已消费的请求不会被第二个 chat-core 实例重复回答

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock bridge / 重模块（与 audit-fixes.test.ts 同款 ChatCore 构造前置）──
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
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'test', apiKey: 'k', baseUrl: '', model: 'm', kind: 'openai' })),
  CHAT_MODES: [],
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => {
  const tween = () => ({ kill: vi.fn(), play: vi.fn(), pause: vi.fn() });
  return {
    default: {
      set: vi.fn(),
      to: vi.fn(tween),
      from: vi.fn(tween),
      fromTo: vi.fn(tween),
      killTweensOf: vi.fn(),
      isTweening: vi.fn(() => false),
      utils: { toArray: vi.fn(() => []) },
    },
    gsap: { set: vi.fn() },
  };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { type AskRequest, pushAsk, useAskStore } from '../src/state/ask-store';

function makeReq(overrides: Partial<AskRequest> = {}): AskRequest {
  return {
    id: 'ask-1',
    question: '继续吗？',
    header: '确认',
    options: [{ label: '继续', description: '' }],
    multiSelect: false,
    callback: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useAskStore.setState({ pendingBySession: new Map(), seq: 0 });
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue('ok');
});

describe('ask-store（prompt:ask 退役）', () => {
  it('pushAsk 递增 seq；consumeAsk 取走队首并清空（幂等）', () => {
    const req = makeReq();
    expect(useAskStore.getState().seq).toBe(0);

    // 无 agentId 归属 → -1 队列（活跃卷兜底）
    pushAsk(req);
    expect(useAskStore.getState().seq).toBe(1);

    expect(useAskStore.getState().consumeAsk(-1)).toBe(req);
    expect(useAskStore.getState().consumeAsk(-1)).toBeNull();
    // 幂等：第二次消费返回 null，不会把同一请求交给两个消费者
    expect(useAskStore.getState().consumeAsk(-1)).toBeNull();
  });

  it('pending 期 chat-core 重建：无承接面不消费（注册 shelf 才送达，不静默取消）', async () => {
    const { ChatCore } = await import('../src/app/chat/chat-core');
    const cb = vi.fn();
    // 无任何 chat-core 存活时请求到达（旧 bus 语义下此刻 emit 即静默丢失）
    pushAsk(makeReq({ id: 'ask-orphan', callback: cb }));

    // 重建 chat-core —— 构造回放撞上无承接面：请求留在 store（2026-09-10
    // 完备化——旧语义此处 callback(null) = 用户没见过问题却被报「用户取消」）
    new ChatCore();
    expect(cb).not.toHaveBeenCalled();
    // 第二个实例构造同样不消费、不重复回答
    new ChatCore();
    expect(cb).not.toHaveBeenCalled();

    // 注册承接面（PromptShelf 挂载）：pending 立即送达
    const core = new ChatCore();
    const shown: string[] = [];
    core.registerPromptShelf({
      active: null,
      showAsk: (p) => {
        shown.push(p.id);
        return Promise.resolve(['继续']);
      },
      showAskBatch: () => Promise.resolve(null),
      showPermission: () => Promise.resolve({ allow: false, remember: false }),
      dismiss: () => {},
      dismissByOwner: () => {},
      answerActiveText: () => false,
    });
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    expect(cb).toHaveBeenCalledWith(['继续']);
    expect(shown).toEqual(['ask-orphan']);
  });

  it('订阅者在 pushAsk 后同步收到请求（等价旧 bus.emit 同步分发语义）', async () => {
    const { ChatCore } = await import('../src/app/chat/chat-core');
    const cb = vi.fn();
    const shown: string[] = [];
    const core = new ChatCore(); // 先有实例（订阅就位）+ 承接面
    core.registerPromptShelf({
      active: null,
      showAsk: (p) => {
        shown.push(p.id);
        return Promise.resolve(['继续']);
      },
      showAskBatch: () => Promise.resolve(null),
      showPermission: () => Promise.resolve({ allow: false, remember: false }),
      dismiss: () => {},
      dismissByOwner: () => {},
      answerActiveText: () => false,
    });
    expect(cb).not.toHaveBeenCalled();

    pushAsk(makeReq({ id: 'ask-live', callback: cb }));
    // zustand subscribe 同步通知 —— 与 bus.emit 的同步时序等价（showAsk 已同步入队）
    expect(shown).toEqual(['ask-live']);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    expect(cb).toHaveBeenCalledWith(['继续']);
  });
});
