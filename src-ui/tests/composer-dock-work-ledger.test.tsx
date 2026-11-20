// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composer-dock-work-ledger.test.tsx — 役册落位与接线（2026-09-22）。
//
// 考官面：① 触发器恒驻设置行（有活跃卷即渲染），读数随台账走（空档 `役 —`，
// 有活 `役 N`，他卷另计 `N+M`）；② 点开是册页：在役 / 他卷 / 已了三段，
// 空态诚实（「本卷无在役」）；③ 逐条停止**只出在 shell 条目上**（子代理侧
// 暂无 UI 可达的池通道，见台账头注）；④ 并入浮层互斥（开役册关墨量册，
// 反之亦然）；⑤ 切卷清本地态（册页不跨卷残留）；⑥ **触发器恒活**——对账是
// 触发器自己的事，不随册页开合（2026-10-07 修：此前只在点开后对账，用户报
// 「后台任务起停后非得点一下才计数」）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { kernelProcessCall } = vi.hoisted(() => ({
  kernelProcessCall: vi.fn<(action: string, args?: Record<string, unknown>) => Promise<string>>(),
}));
vi.mock('../src/rpc-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/rpc-contract')>()),
  kernelProcessCall,
}));

import { agentSessionState } from '../src/agent/agent-session-state';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { WORK_PULL_MS } from '../src/plugins/builtin/compose-dock/WorkLedger';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { resetWorkLedgerForTests, setOwnerSessionResolver, useWorkLedgerStore } from '../src/state/work-ledger-store';
import { getChatStore } from '../src/ui/chat-store';

/** 切卷回调（他卷跳转）：模块级共享，便于断言。 */
const switchSession = vi.fn();

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    registerComposer: vi.fn(),
    switchSession,
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  flyToPoint: vi.fn(),
};

describe('役册（创作坞后台工作监视装置）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const PANEL = 'wl-dock';
  /** 后端账本的可变替身——对账读的就是它（不预置 store，走真实路径）。 */
  const shells: Array<Record<string, unknown>> = [];

  const mountDock = async (value: PaperDockContextValue = DOCK_CONTEXT, sessions = [{ id: 1, label: '案卷一' }]) => {
    act(() => root?.unmount());
    root = null;
    container.innerHTML = '';
    useCoreStore.getState().setChatCore(fakeCore(PANEL));
    getChatStore(PANEL).sess.setState({
      sessions,
      activeIdx: sessions.length > 0 ? 0 : -1,
      sessionTokens: {},
      nextSessionId: sessions.length + 1,
    });
    getChatStore(PANEL).input.getState().setInputText('');
    act(() => {
      root = createRoot(container);
      root.render(createElement(PaperDockContext.Provider, { value }, createElement(ComposerDock)));
    });
    await act(async () => {});
  };

  /** 后端账本里放一条在役 job（owner 默认 main-1 → 归属解析给会话 1）。 */
  const withShellJob = (jobId: number, label: string, over: Record<string, unknown> = {}) => {
    const secs = typeof over.elapsedSecs === 'number' ? over.elapsedSecs : 5;
    shells.push({
      jobId,
      label,
      agent: 'main-1',
      elapsedSecs: secs,
      stalled: false,
      startedAt: Date.now() - secs * 1000,
      ...over,
    });
  };

  /** 已结算的 shell（名册里带着 status/exitCode/finishedAt——2026-11-12 起是直给）。 */
  const withSettledShell = (jobId: number, label: string, over: Record<string, unknown> = {}) => {
    shells.push({
      jobId,
      label,
      agent: 'main-1',
      elapsedSecs: 12,
      stalled: false,
      startedAt: Date.now() - 12_000,
      status: 'completed',
      exitCode: 0,
      finishedAt: Date.now(),
      ...over,
    });
  };
  const trigger = () => container.querySelector<HTMLButtonElement>('.pp-work-trigger');
  const triggerText = () => trigger()?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    resetWorkLedgerForTests();
    shells.length = 0;
    kernelProcessCall.mockReset();
    switchSession.mockReset();
    // 对账读的就是这本替身账（空表 = 后端无在役 job）
    kernelProcessCall.mockImplementation(async (action: string) => {
      // 展开输出的非消费读：固定回一段 stdout（stderr 空）
      if (action === 'job_read_at') {
        return JSON.stringify({
          stdout: { text: 'hello from job\n', next: 15, lossy: false },
          stderr: { text: '', next: 0, lossy: false },
        });
      }
      return JSON.stringify(
        shells.map((s) => ({
          id: s.jobId,
          label: s.label,
          owner: s.agent,
          status: s.status ?? 'running',
          stalled: s.stalled,
          exitCode: s.exitCode ?? null,
          detail: s.detail ?? null,
          startedAt: s.startedAt ?? Date.now(),
          finishedAt: s.finishedAt ?? null,
          output: s.output ?? {
            stdout: { total: 0, earliest: 0 },
            stderr: { total: 0, earliest: 0 },
            spill: { stdout: null, stderr: null },
          },
        })),
      );
    });
    // 归属解析：本测试文件不经 workspace 装配，直接注入同形的解析器
    setOwnerSessionResolver(PANEL, (owner) => (owner === 'main-1' ? 1 : null));
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  it('触发器恒驻设置行（有活跃卷即渲染），空档报 `役 —` 不冒充读数', async () => {
    await mountDock();
    expect(trigger()).not.toBeNull();
    expect(triggerText()).toBe('役 —');
    expect(container.querySelector('.pp-work-panel')).toBeNull(); // 默认关闭
  });

  it('无活跃卷：整枚不出现（同墨量册的无主待命态纪律）', async () => {
    await mountDock({ activeSessionId: null, flyToPoint: vi.fn() }, []);
    expect(container.querySelector('.pp-work-sel')).toBeNull();
  });

  it('读数随台账走：本卷在役计本卷，他卷另计 `N+M`', async () => {
    useWorkLedgerStore.getState().noteSubAgentSpawn(PANEL, 1, 'sub-1', null, '查依赖');
    useWorkLedgerStore.getState().noteSubAgentSpawn(PANEL, 2, 'sub-2', null, '别的卷');
    await mountDock();
    expect(triggerText()).toBe('役 1+1');
    expect(trigger()?.className).toContain('live');
    expect(trigger()?.getAttribute('data-tip-hint')).toContain('本卷在役 1 条');
    expect(trigger()?.getAttribute('data-tip-hint')).toContain('另 1 条在他卷');
  });

  it('册页关着也恒对账：后台任务起来 ⇒ 触发器当轮自亮（读数不是点开的副作用）', async () => {
    vi.useFakeTimers();
    try {
      await mountDock();
      expect(triggerText()).toBe('役 —');
      expect(trigger()?.className).not.toContain('live');

      // 节点外发生的事：Rust 账本里多了一条在役 job（册页始终没开）
      withShellJob(7, 'cargo test --workspace');
      await act(async () => {
        vi.advanceTimersByTime(WORK_PULL_MS);
      });

      expect(container.querySelector('.pp-work-panel')).toBeNull(); // 仍然关着
      expect(triggerText()).toBe('役 1');
      expect(trigger()?.className).toContain('live');
    } finally {
      vi.useRealTimers();
    }
  });

  it('后台任务停了 ⇒ 触发器当轮自灭（终态结转不用点开）', async () => {
    withShellJob(7, 'watch');
    vi.useFakeTimers();
    try {
      await mountDock();
      await act(async () => {
        vi.advanceTimersByTime(WORK_PULL_MS);
      });
      expect(triggerText()).toBe('役 1');

      shells.length = 0; // 节点外：job 结束，快照里查不到它了
      await act(async () => {
        vi.advanceTimersByTime(WORK_PULL_MS);
      });

      expect(triggerText()).toBe('役 —');
      expect(trigger()?.className).not.toContain('live');
      // 消失 = 结局未知：不冒充「已了」，也不外推成败
      const settled = Object.values(useWorkLedgerStore.getState().entries).find((e) => e.id === 'job-7');
      expect(settled?.state).toBe('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('点开是对账后的册页：在役段列条目（时长 + 旁注），读数与条目同源', async () => {
    withShellJob(7, 'cargo test --workspace', { elapsedSecs: 65, stalled: true });
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});

    const panel = container.querySelector('.pp-work-panel');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('.pp-work-head-title')?.textContent).toContain('案卷一');
    expect(panel?.querySelector('.pp-work-count')?.textContent).toBe('1');
    expect(panel?.querySelector('.pp-work-label')?.textContent).toBe('cargo test --workspace');
    // 打开即对账一次（补齐节点外发生的变化）——时长由 elapsedSecs 反推
    expect(kernelProcessCall).toHaveBeenCalledWith('job_list');
    expect(panel?.querySelector('.pp-work-sub')?.textContent).toMatch(/^已 1m0\ds · 停滞$/);
  });

  it('空卷册页显「本卷无在役」，不出假的空列表', async () => {
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});
    expect(container.querySelector('.pp-work-empty')?.textContent).toBe('本卷无在役');
    // 2026-10-22 P2：空态收成一句 + 一行去处说明；大号 0 / 段题「在役」同批退场
    expect(container.querySelector('.pp-work-empty-sub')?.textContent).toBe('子代理与后台命令会在这里出现');
    expect(container.querySelector('.pp-work-count')).toBeNull();
    expect([...container.querySelectorAll('.pp-work-section-title')].map((el) => el.textContent)).not.toContain('在役');
  });

  it('他卷段与已了段：他卷标卷名，终态标状态字', async () => {
    const s = useWorkLedgerStore.getState();
    s.noteSubAgentSpawn(PANEL, 2, 'sub-other', null, '别的卷的活');
    s.noteSubAgentSpawn(PANEL, 1, 'sub-done', null, '干完了');
    s.noteSubAgentFinished(PANEL, 'sub-done', true);
    await mountDock(DOCK_CONTEXT, [
      { id: 1, label: '案卷一' },
      { id: 2, label: '案卷二' },
    ]);
    act(() => trigger()?.click());
    await act(async () => {});

    const sections = [...container.querySelectorAll('.pp-work-section-title')].map((el) => el.textContent);
    expect(sections).toContain('他卷');
    expect(sections).toContain('已了');
    const subs = [...container.querySelectorAll('.pp-work-sub')].map((el) => el.textContent ?? '');
    expect(subs.some((t) => t.includes('案卷二'))).toBe(true); // 他卷标卷名（非裸卷号）
    expect(subs.some((t) => t.includes('已了'))).toBe(true);
  });

  it('逐条停止只出在 shell 条目上——子代理侧无 UI 可达的池通道（能力边界如实）', async () => {
    withShellJob(3, 'npm run dev');
    useWorkLedgerStore.getState().noteSubAgentSpawn(PANEL, 1, 'sub-1', null, '子代理');
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});

    const items = [...container.querySelectorAll('.pp-work-item')].map((li) => ({
      cls: li.className,
      hasStop: li.querySelector('.pp-work-stop') !== null,
    }));
    expect(items.find((x) => x.cls.includes('pp-work-shell'))?.hasStop).toBe(true);
    expect(items.find((x) => x.cls.includes('pp-work-subagent'))?.hasStop).toBe(false);
  });

  it('停止走 bash_kill 且不带 owner（用户路径），随后立刻对账', async () => {
    withShellJob(9, 'watch');
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});
    kernelProcessCall.mockClear();
    shells.length = 0; // 杀成功 = 后端账本里没了

    act(() => container.querySelector<HTMLButtonElement>('.pp-work-stop')?.click());
    await act(async () => {});

    const actions = kernelProcessCall.mock.calls.map((c) => c[0]);
    expect(actions).toContain('job_kill_human');
    expect(kernelProcessCall.mock.calls.find((c) => c[0] === 'job_kill_human')?.[1]).toEqual({
      job_id: 9,
      reason: 'cancelled by the user',
    });
    expect(actions).toContain('job_list');
    // 立刻落出「在役」——不等下一个轮询周期（结局未知 ⇒ 中断，不冒充「已了」）
    expect(container.querySelector('.pp-work-state-running')).toBeNull();
    expect(container.querySelector('.pp-work-state-interrupted')).not.toBeNull();
  });

  it('并入浮层互斥：开役册关墨量册，开墨量册关役册', async () => {
    await mountDock();
    const ink = () => container.querySelector<HTMLButtonElement>('.pp-ink-trigger');
    const work = () => trigger();

    act(() => work()?.click());
    await act(async () => {});
    expect(container.querySelector('.pp-work-panel')).not.toBeNull();
    expect(container.querySelector('.pp-ink-panel')).toBeNull();

    act(() => ink()?.click());
    await act(async () => {});
    expect(container.querySelector('.pp-ink-panel')).not.toBeNull();
    expect(container.querySelector('.pp-work-panel')).toBeNull();
  });

  it('切卷清本地态：册页不跨卷残留（与墨量册/翰/律/引同一条纪律）', async () => {
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});
    expect(container.querySelector('.pp-work-panel')).not.toBeNull();

    await mountDock({ activeSessionId: '2', flyToPoint: vi.fn() }, [
      { id: 1, label: '案卷一' },
      { id: 2, label: '案卷二' },
    ]);
    expect(container.querySelector('.pp-work-panel')).toBeNull();
  });

  /* ── 2026-11-27 役册 UX 批 ─────────────────────────────────────────── */

  it('在役子代理 ≥2：段题行尾出「全停」，点了立刻落「已停」', async () => {
    const s = useWorkLedgerStore.getState();
    s.noteSubAgentSpawn(PANEL, 1, 'sub-1', null, 'A');
    s.noteSubAgentSpawn(PANEL, 1, 'sub-2', null, 'B');
    const stopAllSubAgents = vi.fn(() => ['sub-1', 'sub-2']);
    const spy = vi
      .spyOn(agentSessionState, 'getAgent')
      .mockReturnValue({ stopAllSubAgents } as unknown as ReturnType<typeof agentSessionState.getAgent>);
    try {
      await mountDock();
      act(() => trigger()?.click());
      await act(async () => {});

      const btn = container.querySelector<HTMLButtonElement>('.pp-work-stopall');
      expect(btn).not.toBeNull();
      act(() => btn?.click());
      expect(stopAllSubAgents).toHaveBeenCalledTimes(1);
      // 立刻落「已停」——不等 abort 分支的收尾回调（那会写成「失败」）
      expect(container.querySelectorAll('.pp-work-state-stopped')).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('只有一条子代理时不出「全停」（它和「停这一条」是同一件事）', async () => {
    useWorkLedgerStore.getState().noteSubAgentSpawn(PANEL, 1, 'sub-1', null, 'A');
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});
    expect(container.querySelector('.pp-work-stopall')).toBeNull();
  });

  it('展开输出：已了的条目也能看（命令跑完的那一刻不再是信息盲区）', async () => {
    withSettledShell(11, 'cargo build');
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});

    const row = container.querySelector('.pp-work-state-done');
    expect(row).not.toBeNull();
    const btn = row?.querySelector<HTMLButtonElement>('.pp-work-expand');
    expect(btn).not.toBeNull();
    // 操作对聚在同一格（旧实现里「收」被网格推到面板外 217px）
    expect(row?.querySelector('.pp-work-actions .pp-work-expand')).not.toBeNull();

    act(() => btn?.click());
    await act(async () => {});
    expect(row?.querySelector('.pp-work-output-wrap')).not.toBeNull();
    expect(row?.querySelector('.pp-work-output')?.textContent).toContain('hello from job');
    expect(row?.querySelector('.pp-work-expand')?.getAttribute('aria-expanded')).toBe('true');

    // 再点收起 = 卸载输出、停流
    act(() => row?.querySelector<HTMLButtonElement>('.pp-work-expand')?.click());
    await act(async () => {});
    expect(row?.querySelector('.pp-work-output-wrap')).toBeNull();
  });

  it('他卷条目可点：整行跳到那一卷（监视面不再是死路）', async () => {
    useWorkLedgerStore.getState().noteSubAgentSpawn(PANEL, 2, 'sub-other', null, '别的卷的活');
    await mountDock(DOCK_CONTEXT, [
      { id: 1, label: '案卷一' },
      { id: 2, label: '案卷二' },
    ]);
    act(() => trigger()?.click());
    await act(async () => {});

    const jump = container.querySelector<HTMLButtonElement>('.pp-work-jump');
    expect(jump).not.toBeNull();
    expect(jump?.textContent).toContain('案卷二');

    act(() => jump?.click());
    // 会话 2 在会话表第 1 位（0 基）——走 core 的既有 switchSession
    expect(switchSession).toHaveBeenCalledWith(1);
  });

  it('Esc 关闭册页（与同行的模型菜单同语义）', async () => {
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});
    expect(container.querySelector('.pp-work-panel')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {});
    expect(container.querySelector('.pp-work-panel')).toBeNull();
  });

  it('点面板外关闭册页（旧实现只能再点触发器）', async () => {
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});
    expect(container.querySelector('.pp-work-panel')).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await act(async () => {});
    expect(container.querySelector('.pp-work-panel')).toBeNull();
  });

  it('读账失败：触发器自己显形（册页关着也看得见，不是只在页脚说）', async () => {
    kernelProcessCall.mockRejectedValue(new Error('bridge down'));
    await mountDock();
    await act(async () => {});
    expect(trigger()?.className).toContain('error');
    expect(trigger()?.getAttribute('data-tip-hint')).toContain('bridge down');
  });

  it('已了超过 8 条：如实报余量，不静默截断', async () => {
    const s = useWorkLedgerStore.getState();
    for (let i = 0; i < 10; i++) {
      s.noteSubAgentSpawn(PANEL, 1, `sub-${i}`, null, `活 ${i}`);
      s.noteSubAgentFinished(PANEL, `sub-${i}`, true);
    }
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});

    expect(container.querySelectorAll('.pp-work-state-done')).toHaveLength(8);
    expect(container.querySelector('.pp-work-more')?.textContent).toContain('另有 2 条');
    expect(container.querySelector('.pp-work-head-figures')?.textContent).toContain('已了 10');
  });

  it('退出码非 0 的命令：失败看得见（旧实现与成功同形）', async () => {
    withSettledShell(12, 'cargo test', { exitCode: 101, finishedAt: Date.now() });
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});

    const row = container.querySelector('.pp-work-state-done');
    expect(row?.className).toContain('pp-work-bad');
    expect(row?.querySelector('.pp-work-sub')?.textContent).toContain('exit 101');
  });
});
