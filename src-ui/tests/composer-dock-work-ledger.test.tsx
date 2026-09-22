// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composer-dock-work-ledger.test.tsx — 役册落位与接线（2026-09-22）。
//
// 考官面：① 触发器恒驻设置行（有活跃卷即渲染），读数随台账走（空档 `役 —`，
// 有活 `役 N`，他卷另计 `N+M`）；② 点开是册页：在役 / 他卷 / 已了三段，
// 空态诚实（「本卷无在役」）；③ 逐条停止**只出在 shell 条目上**（子代理侧
// 暂无 UI 可达的池通道，见台账头注）；④ 并入浮层互斥（开役册关墨量册，
// 反之亦然）；⑤ 切卷清本地态（册页不跨卷残留）。

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

import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { resetWorkLedgerForTests, setOwnerSessionResolver, useWorkLedgerStore } from '../src/state/work-ledger-store';
import { getChatStore } from '../src/ui/chat-store';

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    registerComposer: vi.fn(),
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
    shells.push({ jobId, label, agent: 'main-1', elapsedSecs: 5, stalled: false, ...over });
  };

  const trigger = () => container.querySelector<HTMLButtonElement>('.pp-work-trigger');
  const triggerText = () => trigger()?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    resetWorkLedgerForTests();
    shells.length = 0;
    kernelProcessCall.mockReset();
    // 对账读的就是这本替身账（空表 = 后端无在役 job）
    kernelProcessCall.mockImplementation(async () => JSON.stringify({ shells, browsers: [] }));
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
    expect(trigger()?.title).toContain('本卷在役 1 条');
    expect(trigger()?.title).toContain('另 1 条在他卷');
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
    expect(kernelProcessCall).toHaveBeenCalledWith('background_activity');
    expect(panel?.querySelector('.pp-work-sub')?.textContent).toMatch(/^已 1m0\ds · 停滞$/);
  });

  it('空卷册页显「本卷无在役」，不出假的空列表', async () => {
    await mountDock();
    act(() => trigger()?.click());
    await act(async () => {});
    expect(container.querySelector('.pp-work-empty')?.textContent).toBe('本卷无在役');
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
    expect(actions).toContain('bash_kill');
    expect(kernelProcessCall.mock.calls.find((c) => c[0] === 'bash_kill')?.[1]).toEqual({ job_id: 9 });
    expect(actions).toContain('background_activity');
    // 立刻落到「已了」——不等下一个轮询周期
    expect(container.querySelector('.pp-work-state-done')).not.toBeNull();
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
});
