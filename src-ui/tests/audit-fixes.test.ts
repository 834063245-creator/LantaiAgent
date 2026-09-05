// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tests for the 15-issue audit fix batch.
// Grouped by concern area, matching existing test conventions.

// fs 域收口（2026-09-04）：exportSession/scheduleAutoSave 落盘经 kernelWriteFile
// （rpc-contract 具名 helper，内部直呼 fs_cap）——mock 站到 helper 层（不再
// 拦 bridge + toolCallArgsOfBridge 翻信封）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPersistenceService } from '../src/composition/session-persistence-service';
// 会话持久化 seam 装配（seam 接线 C 批 3）：scheduleAutoSave 落盘已换轨
// sessionExecute——builtin provider 需在册（走 kernel-fs mock 内存盘）。
// 只挂 sessionPersistence service + builtin provider（本文件仅消费该 seam，
// 不必 boot 全通道——composition-boot 全通道含 agentLoop/dynamicRunner 等
// 与本文件 mock 面无关联的插件，避免 mock 环境纠缠）。
import { Context } from '../src/cordis';
import { builtinSessionsPlugin } from '../src/plugins/builtin/sessions-builtin';

{
  const root = new Context();
  new SessionPersistenceService(root);
  await root.plugin(builtinSessionsPlugin);
}

// 顶层触发 rpc-contract 的 vi.mock 工厂求值：vitest 的 vi.mock 惰性执行于
// 首个 import 目标模块时——本文件用例全动态 import，若不在文件加载期触发，
// H.kernelFs 会在首个用例的 beforeEach 仍是 null。静态 import 一个经
// rpc-contract 的模块即可（仅作求值触发，模块本身被 vi.mock 拦截无害）。
import { kernelReadFileRaw } from '../src/rpc-contract';

void kernelReadFileRaw;

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
  invoke: null as null | ReturnType<typeof vi.fn>,
}));

// bridge mock：承载非 fs 的 invoke 兜底（dialog 之外无其它 rpc 需要——
// kernelWriteFile 已被 helper 覆写拦截，不进 bridge）
vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => H.invoke?.(...args),
  listen: vi.fn(),
  isMockMode: () => false,
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
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
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

// ═══════════════════════════════════════════════════════════════════
// #1 — exportSession uses `filePath` not `path` for write_file_content
// ═══════════════════════════════════════════════════════════════════

describe('#1 exportSession parameter name', () => {
  beforeEach(() => {
    const k = H.kernelFs!;
    k.fs.files.clear();
    k.fs.dirs.clear();
    k.fs.writes.length = 0;
    k.fs.fail = {};
    H.invoke = vi.fn(async () => 'ok');
  });

  it('sends file_path (not path) to write_file_content rpc', async () => {
    const { ChatCore } = await import('../src/app/chat/chat-core');
    const panel = new ChatCore();
    const fakeAgent = {
      getSession: () => [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      dispose: vi.fn(),
    } as any;
    panel.setAgent(fakeAgent);
    // 零目录退役（Stage-5）：创建必须要有目录——绑定工作区再建卷
    panel.setProjectPath('/test');
    // 归零重建：setAgent 不铺卷——建卷 1 领预留句柄（exportSession 导出活跃卷）
    await panel.createNewSession();

    // Mock the save dialog to return a file path
    vi.doMock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(async () => '/tmp/test.md') }));
    // Re-import to pick up the mock
    vi.resetModules();

    // Call exportSession — we need to invoke it via the panel
    // Since exportSession is internal, we test via the rpc call inspection
    const { exportSession } = await import('../src/ui/chat-session');
    const { getChatStore } = await import('../src/ui/chat-store');
    const storeId = panel.panelId;

    // Ensure agent is set up
    const { agentSessionState } = await import('../src/agent/agent-session-state');
    const { sessions } = getChatStore(storeId).sess.getState();
    if (sessions[0]) {
      agentSessionState.setAgent(storeId, sessions[0].id, fakeAgent);
    }

    // Mock the save dialog at the module level
    const dialogModule = await import('@tauri-apps/plugin-dialog');
    vi.spyOn(dialogModule, 'save').mockResolvedValue('/tmp/test-export.md');

    const ctx: any = {
      storeId,
      panel: document.createElement('div'),
      sessionTabs: document.createElement('div'),
      tabBar: document.createElement('div'),
      getProjectPath: () => '/test',
      flushReasoning: vi.fn(),
      flushText: vi.fn(),
      clearPendingToolCards: vi.fn(),
      getRunning: () => false,
      abort: vi.fn(),
      addNotice: vi.fn(),
      updateFooter: vi.fn(),
      getTotalTokensUsed: () => 100,
      setTotalTokensUsed: vi.fn(),
      clearToolUsage: vi.fn(),
      clearToolHistory: vi.fn(),
      getLastUsageText: () => '',
      setLastUsageText: vi.fn(),
      getLastAgentDiag: () => '',
      clearInputHistory: vi.fn(),
      getStarGraph: () => null,
    };

    await exportSession(ctx);

    // fs 域收口：export 写盘 = kernelWriteFile(filePath, content)——mock 层
    // 断言第一参即文件路径（旧「write_file_content 的 filePath 而非 path」
    // 的语义由 helper 签名天然保证——文件路径恒为第一参）。
    const writes = H.kernelFs!.fs.writes;
    expect(writes.length).toBe(1);
    // 导出到对话框返回的路径（filePath 键语义 = 第一参）
    expect(writes[0].file_path).toBe('/tmp/test-export.md');
  });
});

// ═══════════════════════════════════════════════════════════════════
// #10 — scheduleAutoSave uses per-panel timers (no cross-panel clearing)
// ═══════════════════════════════════════════════════════════════════

describe('#10 scheduleAutoSave per-panel isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const k = H.kernelFs!;
    k.fs.files.clear();
    k.fs.dirs.clear();
    k.fs.writes.length = 0;
    k.fs.fail = {};
    H.invoke = vi.fn(async () => 'ok');
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('panel A timer is NOT cleared when panel B schedules', async () => {
    const { scheduleAutoSave } = await import('../src/ui/chat-session');
    const { getChatStore } = await import('../src/ui/chat-store');
    const { agentSessionState } = await import('../src/agent/agent-session-state');
    // 用例 1 的 vi.resetModules 已重置模块缓存——动态 import 的 service 是新
    // 实例（无 provider）。此处动态 import 注册（builtin provider 走 kernel-fs
    // mock 内存盘；dup 注册拒绝：同模块实例重复跑本用例只注册一次）。
    const { SessionPersistenceService } = await import('../src/composition/session-persistence-service');
    const { builtinSessionsProvider } = await import('../src/plugins/builtin/sessions-builtin');
    const { Context } = await import('../src/cordis');
    const { activeSessionPersistenceProviders } = await import('../src/composition/session-persistence-service');
    if (activeSessionPersistenceProviders().length === 0) {
      const root = new Context();
      const svc = new SessionPersistenceService(root);
      svc.register(builtinSessionsProvider);
    }

    const storeA = 'panel-A';
    const storeB = 'panel-B';

    // Set up agents so saveActiveSession doesn't bail early
    for (const sid of [storeA, storeB]) {
      const id = 1;
      getChatStore(sid).sess.setState({
        sessions: [{ id, label: 'test' }],
        activeIdx: 0,
        sessionTokens: {},
        nextSessionId: 2,
        msgIdSeq: 0,
      });
      agentSessionState.setAgent(sid, id, {
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' },
        ],
        dispose: vi.fn(),
      } as any);
    }

    const ctxA: any = {
      storeId: storeA,
      getProjectPath: () => '/a',
      addNotice: vi.fn(),
      updateFooter: vi.fn(),
      getTotalTokensUsed: () => 0,
      setTotalTokensUsed: vi.fn(),
      panel: document.createElement('div'),
      sessionTabs: document.createElement('div'),
      tabBar: document.createElement('div'),
      flushReasoning: vi.fn(),
      flushText: vi.fn(),
      clearPendingToolCards: vi.fn(),
      getRunning: () => false,
      abort: vi.fn(),
      clearToolUsage: vi.fn(),
      clearToolHistory: vi.fn(),
      getLastUsageText: () => '',
      setLastUsageText: vi.fn(),
      getLastAgentDiag: () => '',
      clearInputHistory: vi.fn(),
      getStarGraph: () => null,
    };
    const ctxB: any = { ...ctxA, storeId: storeB };

    // Panel A schedules save
    scheduleAutoSave(ctxA, '/a');
    // Panel B schedules save — should NOT clear panel A's timer
    scheduleAutoSave(ctxB, '/b');

    // Advance time — both timers should fire independently
    await vi.advanceTimersByTimeAsync(600);

    // Both panels should have written to disk (at least the session file)
    const writes = H.kernelFs!.fs.writes;
    // L3（session-ledger）：_active.json tracker 写入退役（总目接任）——
    // 每面板至少 1 份卷文件，两面板合计 ≥ 2
    expect(writes.length).toBeGreaterThanOrEqual(2);

    // Verify both panels' saves appear — workspace-session-ownership-rework 后
    // 归属 = 存储位置：面板 A/B 写各自 {workspace}/.lantai/sessions/{id}.json
    // （workspace 字段标签已退役——同一 storeId 跨面板隔离仍由复合键保证）
    const paths = writes.map((w) => w.file_path);
    expect(paths.some((p: string) => p === '/a/.lantai/sessions/1.json')).toBe(true);
    expect(paths.some((p: string) => p === '/b/.lantai/sessions/1.json')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// #15 — computeCostStr removed（dead code cleanup）：chat-utils 已随 C13 休眠层
// sweep 整体退役，本负向测试随之失去对象，删除（2026-08-22）。
