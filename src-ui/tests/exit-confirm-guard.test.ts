// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 退出守卫（2026-09-19 用户拍板）——关窗时「有会话正在跑」先问一句。
//
// 病灶：回首页有确认（PaperPanel 关闭守卫），而紧挨着它的窗口 ✕ 没有——关窗路径
// 只做「退出落盘 → destroy」，在跑的一轮被掐死且用户零感知。
//
// 本文件按用户操作序列钉住六件事（走生产单点 bootPersistence 的关窗入口，不复制
// 编排逻辑到测试里）：
//   ① 无卷在跑：关窗照旧直接退（不弹层——空闲时弹层只是多一次点击）
//   ② 有卷在跑：拦下本次关闭（不落盘、不 destroy），确认弹层带卷数升起
//   ③ 取消：本次关闭作废（窗口留着），之后再点 ✕ 重新问一次
//   ④ 确认：落盘 → destroy，弹层清态
//   ⑤ 弹层在场时再点 ✕：不重复升起，也不越过用户直接 proceed
//   ⑥ 同一卷跑完后再关窗：不拦——判据是「正在跑」不是「有卷」

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeCloseEvent {
  preventDefault: () => void;
  destroy: () => Promise<void>;
}

const H = vi.hoisted(() => ({
  closeHandler: null as null | ((ev: FakeCloseEvent) => void),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// 关窗事件源（bridge 是 Tauri 路由面）：捕获生产单点注册的处理器，测试直接驱动它。
vi.mock('../src/bridge', () => ({
  isMockMode: () => false,
  watchWindowClose: vi.fn(async (h: (ev: FakeCloseEvent) => void) => {
    H.closeHandler = h;
    return () => {};
  }),
}));

vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: H.log.info, warn: H.log.warn, error: H.log.error, debug: H.log.debug },
}));

const STORE_ID = 'panel-exit-guard';
const WS = 'D:/ws';

/** 收尾桩：本文件只钉「拦不拦 / 何时收尾」，写盘面由 session-exit-flush.test.ts 钉。 */
function makePanel() {
  return {
    flushSessionsForExit: vi.fn(async () => ({
      saved: 0,
      total: 0,
      failed: 0,
      anomalies: [],
      cancelledDebounce: false,
    })),
    saveCanvasState: vi.fn(async () => {}),
    setOnOpenSettings: vi.fn(),
  };
}

function makeWorkspace() {
  return { path: WS, subAgentPool: { stopAll: vi.fn() }, runtime: null };
}

/** 铺一个在册句柄（+ 可选正在跑的账本）——运行态真源 = 运行账上的活记录（v43 唯一读面）。 */
async function armSession(sid: number, running: boolean) {
  const { agentSessionState } = await import('../src/agent/agent-session-state');
  agentSessionState.setAgent(STORE_ID, sid, {
    id: `agent-${sid}`,
    getSession: () => [],
    dispose: vi.fn(),
  } as never);
  const exec = agentSessionState.getOrCreateExec(STORE_ID, sid);
  const run = running ? exec.beginRun('turn') : null;
  return { exec, run };
}

/** 走生产入口：bootPersistence 注册关窗处理器（异步注册，等它落位）。 */
async function boot(panel: ReturnType<typeof makePanel>, ws: ReturnType<typeof makeWorkspace>) {
  const { bootPersistence } = await import('../src/shell/rows/persistence');
  bootPersistence({ workspace: ws, chatPanel: panel } as never);
  await vi.waitFor(() => expect(H.closeHandler).not.toBeNull());
}

/** 一次关窗请求（✕ / Alt+F4 / 任务栏关窗同一条 Tauri 事件）。 */
function closeRequest(): FakeCloseEvent {
  const ev: FakeCloseEvent = { preventDefault: vi.fn(), destroy: vi.fn(async () => {}) };
  H.closeHandler?.(ev);
  return ev;
}

async function pendingExit() {
  const { useExitGuardStore } = await import('../src/state/exit-guard-store');
  return useExitGuardStore.getState();
}

beforeEach(async () => {
  H.closeHandler = null;
  const { useExitGuardStore } = await import('../src/state/exit-guard-store');
  useExitGuardStore.setState({ pending: null });
});

afterEach(async () => {
  const { agentSessionState } = await import('../src/agent/agent-session-state');
  agentSessionState.clearPanelState(STORE_ID);
  const { useExitGuardStore } = await import('../src/state/exit-guard-store');
  useExitGuardStore.setState({ pending: null });
});

describe('退出守卫 —— 关窗时有会话在跑先问一句（2026-09-19 用户拍板）', () => {
  it('无卷在跑：关窗照旧直接退——落盘后 destroy，不弹层', async () => {
    const panel = makePanel();
    await boot(panel, makeWorkspace());

    const ev = closeRequest();

    expect(ev.preventDefault).toHaveBeenCalledTimes(1); // 默认关闭一律先摘
    expect((await pendingExit()).pending).toBeNull();
    await vi.waitFor(() => expect(ev.destroy).toHaveBeenCalledTimes(1));
    expect(panel.flushSessionsForExit).toHaveBeenCalledTimes(1); // 退出落盘照跑
    expect(panel.saveCanvasState).toHaveBeenCalledWith(WS);
  });

  it('有卷在跑：拦下本次关闭（不落盘、不 destroy），确认弹层带卷数升起', async () => {
    await armSession(7, true);
    const panel = makePanel();
    await boot(panel, makeWorkspace());

    const ev = closeRequest();

    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    const st = await pendingExit();
    expect(st.pending?.running).toBe(1);
    // 用户还没答话：既不落盘也不 destroy（窗口留着，账也没结）
    await new Promise((r) => setTimeout(r, 20));
    expect(ev.destroy).not.toHaveBeenCalled();
    expect(panel.flushSessionsForExit).not.toHaveBeenCalled();
    expect(panel.saveCanvasState).not.toHaveBeenCalled();
  });

  it('取消：本次关闭作废（窗口留着），之后再点 ✕ 重新问一次', async () => {
    await armSession(7, true);
    const panel = makePanel();
    await boot(panel, makeWorkspace());
    const ev = closeRequest();

    const st = await pendingExit();
    st.cancelExit();

    expect((await pendingExit()).pending).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(ev.destroy).not.toHaveBeenCalled();
    expect(panel.flushSessionsForExit).not.toHaveBeenCalled();

    // 卷还在跑 → 下一次关窗照旧先问（取消不作数到「本次关窗」之外）
    const again = closeRequest();
    expect((await pendingExit()).pending?.running).toBe(1);
    expect(again.destroy).not.toHaveBeenCalled();
  });

  it('确认：落盘 → destroy，弹层清态', async () => {
    await armSession(7, true);
    const panel = makePanel();
    await boot(panel, makeWorkspace());
    const ev = closeRequest();

    const st = await pendingExit();
    st.confirmExit();

    expect((await pendingExit()).pending).toBeNull();
    await vi.waitFor(() => expect(ev.destroy).toHaveBeenCalledTimes(1));
    expect(panel.flushSessionsForExit).toHaveBeenCalledTimes(1);
    expect(panel.saveCanvasState).toHaveBeenCalledWith(WS);
  });

  it('弹层在场时再点 ✕：不重复升起，也不越过用户直接 proceed', async () => {
    await armSession(7, true);
    const panel = makePanel();
    await boot(panel, makeWorkspace());
    const first = closeRequest();
    const st = await pendingExit();
    const held = st.pending;

    const second = closeRequest(); // 连点 ✕

    expect((await pendingExit()).pending).toBe(held); // 还是那一次请求
    await new Promise((r) => setTimeout(r, 20));
    expect(second.destroy).not.toHaveBeenCalled();
    expect(panel.flushSessionsForExit).not.toHaveBeenCalled();

    // 确认的是第一次那次关窗：proceed 归它，第二次请求不另行收尾
    st.confirmExit();
    await vi.waitFor(() => expect(first.destroy).toHaveBeenCalledTimes(1));
    expect(second.destroy).not.toHaveBeenCalled();
  });

  it('同一卷跑完后再关窗：不拦——判据是「正在跑」不是「有卷」', async () => {
    const { run } = await armSession(7, true);
    const panel = makePanel();
    await boot(panel, makeWorkspace());

    run?.end(); // 本轮收尾（句柄仍在册；账上记录注销 = 空闲）

    const ev = closeRequest();

    expect((await pendingExit()).pending).toBeNull();
    await vi.waitFor(() => expect(ev.destroy).toHaveBeenCalledTimes(1));
    expect(panel.flushSessionsForExit).toHaveBeenCalledTimes(1);
  });
});
