// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 案卷侧栏「删除武装期间，点其它处 = 取消」语义守护（2026-09-21 用户报）。
//
// 病史（用户原话）：「点了删除之后需要点第二下确认，这些没问题，但是『点击别处取消』
// 操作很奇怪，点了别处会把卷摊开，逻辑冲突了。」
// 根因：行内提示写「再点一次确认删除；点其它处取消」，而「其它处」全是**别的动作**——
// 点另一行 = 摊开/定位那一卷（未摊开卷还要读盘摊上画布 + 视角飞过去）、点勾选格 = 勾选、
// 点节头 = 折节。取消与「摊开」焊在同一击上：提示承诺的那个手势从来不存在。
// 另一半（同族）：只在栏内动作里撤武装 ⇒ 去画布点一下再回来红态还在，下一击「删」被读成
// 第二次确认 = **一次点击直接删除**（`armSeqRef` 注里那条病的栏外版本）。
//
// 本文件钉的是**语义**（结构可调，语义不许回退）：
//   甲 武装期间点**别的卷**：只作取消——不摊开（不读盘、不切活跃、不飞视角），武装撤。
//   乙 武装期间点**本行**：同上；再点一次才摊开。
//   丙 本行「删」第二击照常删（守卫不许吃掉确认）。
//   丁 别的卷的「删」= 改删目标（照常执行，不摊开）。
//   戊 栏内**非行件**（节头/检索/新建/视图/批量条）照常执行，只顺带撤武装。
//   己 栏**外**按下即撤武装，且**不吞**那一击（画布/聊天照常收到点击）。
//   庚 键盘 Enter 与鼠标同一句话（Enter/Space 不走 click 事件，靠 onRowClick 内的同款守卫）。
//   辛 拖行落位 = 别的意图：武装同撤（红态不跨手势残留）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { SpaceService } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { SessionSidebar } from '../src/plugins/builtin/canvas-nav/SessionSidebar';
import { getCanvasStore, resetCanvasStoresForTests } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { getChatStore } from '../src/ui/chat-store';

describe('案卷侧栏：删除武装期间「点其它处 = 取消」（不许把卷摊开）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let panelId: string;
  let core: ChatCore;
  let planBranchDelete: Mock;
  let deleteSessionWithBranches: Mock;

  function fakeCore(pid: string): ChatCore {
    planBranchDelete = vi.fn(async (id: number) => ({
      roots: [id],
      order: [id],
      blocked: [] as Array<{ id: number; running: number[] }>,
      branchCount: 0,
    }));
    deleteSessionWithBranches = vi.fn(async (id: number) => ({
      deleted: [id],
      failed: [] as Array<{ id: number; reason: string }>,
      blocked: [] as Array<{ id: number; running: number[] }>,
    }));
    return {
      panelId: pid,
      // 盘上一卷（未摊开）：id 2 —— 「别处」里最容易看出摊开的那个（点它 = 读盘摊上画布）
      listSavedSessions: vi.fn(async () => [{ id: 2, label: '盘卷甲', msgCount: 5, savedAt: '2026-02-01T00:00:00Z' }]),
      createNewSession: vi.fn(),
      renameSession: vi.fn(),
      renameSavedSession: vi.fn(),
      closeSession: vi.fn(),
      planBranchDelete,
      deleteSessionWithBranches,
      loadSessionFromDisk: vi.fn(async () => true),
      switchSession: vi.fn(),
    } as unknown as ChatCore;
  }

  beforeEach(() => {
    panelId = `test-ss-armed-${Math.random().toString(36).slice(2)}`;
    resetCanvasStoresForTests();
    useShellStore.getState().setProjectPath('');
    useCanvasViewStore.getState().requestFocus(null);
    localStorage.removeItem('lantai.sidebar.folds');
    localStorage.removeItem('lantai.sidebar.width');
    localStorage.removeItem('lantai.sidebar.view');
    new SpaceService(new Context()); // 激活 activeSpace()（行点击 = expand 摊开/定位）
    container = document.createElement('div');
    document.body.appendChild(container);
    core = fakeCore(panelId);
    useCoreStore.getState().setChatCore(core);
    // 摊开两卷（卷 1 = 当前卷、卷 3）+ 盘上一卷（卷 2，未摊开）
    getChatStore(panelId).sess.setState({
      sessions: [
        { id: 1, label: '案卷一' },
        { id: 3, label: 'Cordis 迁移' },
      ],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 4,
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root?.unmount();
      root = createRoot(container);
      root.render(<SessionSidebar />);
    });
    await act(async () => {}); // listSavedSessions promise flush
  }

  const rowOf = (id: number) => container.querySelector(`.ss-row[data-id="${id}"]`) as HTMLElement;
  const delOf = (id: number) => rowOf(id).querySelector('[data-act="del"]') as HTMLButtonElement;
  const load = () => (core as unknown as { loadSessionFromDisk: Mock }).loadSessionFromDisk;
  const switchSession = () => (core as unknown as { switchSession: Mock }).switchSession;
  const armedRow = () =>
    (container.querySelector('.ss-row .ss-danger')?.closest('.ss-row') as HTMLElement | null) ?? null;

  /** 一击武装：点「删」→ 等血缘核对应答 → 该行进入武装态（`.ss-danger`）。 */
  async function arm(id: number): Promise<void> {
    await act(async () => {
      delOf(id).click();
    });
    expect(armedRow()?.dataset.id).toBe(String(id));
  }

  const click = async (el: Element) => {
    await act(async () => {
      (el as HTMLElement).click();
    });
  };

  it('甲 · 武装期间点别的卷（未摊开）：只取消——不读盘、不摊开；再点一次才摊开', async () => {
    await mount();
    expect(load()).not.toHaveBeenCalled();
    await arm(1); // 武装「案卷一」（摊开行）
    await click(rowOf(2)); // 用户照提示点别处取消 —— 旧实现在这里把卷 2 读盘摊上画布
    expect(load()).not.toHaveBeenCalled();
    expect(armedRow()).toBeNull(); // 武装已撤
    expect(rowOf(2).querySelector('.ss-meta')?.textContent).not.toContain('再点一次');
    // 取消那一击只作取消：要摊开得再点一次
    await click(rowOf(2));
    expect(load()).toHaveBeenCalledWith('', 2);
  });

  it('甲2 · 武装期间点别的**已摊开**卷：只取消——不切活跃卷、不飞视角', async () => {
    await mount();
    await arm(1);
    await click(rowOf(3)); // 已摊开行的正常语义 = focus（切活跃）+ 定位飞行
    expect(switchSession()).not.toHaveBeenCalled();
    expect(useCanvasViewStore.getState().pendingFocusId).toBeNull();
    expect(armedRow()).toBeNull();
    await click(rowOf(3)); // 再点一次：照常切活跃 + 定位
    expect(switchSession()).toHaveBeenCalledWith(1);
    expect(useCanvasViewStore.getState().pendingFocusId).toBe('3');
  });

  it('乙 · 武装期间点**本行**：只取消（不摊开本行）；再点一次才摊开', async () => {
    await mount();
    await arm(2); // 武装未摊开的「盘卷甲」
    await click(rowOf(2));
    expect(load()).not.toHaveBeenCalled();
    expect(armedRow()).toBeNull();
    await click(rowOf(2));
    expect(load()).toHaveBeenCalledWith('', 2);
  });

  it('丙 · 本行「删」第二击照常删（守卫不许吃掉确认）', async () => {
    await mount();
    await arm(2);
    await click(delOf(2));
    expect(deleteSessionWithBranches).toHaveBeenCalledWith(2);
    expect(armedRow()).toBeNull();
  });

  it('丁 · 武装期间点别的卷的「删」= 改删目标（照常核对武装，不摊开）', async () => {
    await mount();
    await arm(2);
    await click(delOf(1)); // 改删「案卷一」
    expect(deleteSessionWithBranches).not.toHaveBeenCalled();
    expect(planBranchDelete).toHaveBeenLastCalledWith(1);
    expect(armedRow()?.dataset.id).toBe('1'); // 武装移到新目标
    expect(load()).not.toHaveBeenCalled();
  });

  it('戊 · 栏内非行件照常执行：点节头折节 + 顺带撤武装', async () => {
    await mount();
    await arm(1);
    // 折**另一节**（已合卷）——被折的那一行本就不含武装行，武装撤没撤只由红态说了算
    // （若折的是武装行所在节，行随节退场，armedRow() 会因「不在场」而假绿）
    const closedHead = [...container.querySelectorAll('.ss-section-head')].find((h) =>
      h.textContent?.includes('CLOSED'),
    ) as HTMLButtonElement;
    await click(closedHead);
    expect([...container.querySelectorAll('.ss-label')].map((e) => e.textContent)).not.toContain('盘卷甲'); // 点击照常执行
    expect(rowOf(1)).toBeTruthy(); // 武装行仍在场
    expect(armedRow()).toBeNull(); // 而武装已撤
  });

  it('己 · 栏外按下即撤武装，且不吞那一击（画布/聊天照常收到点击）', async () => {
    await mount();
    await arm(1);
    const outside = document.createElement('button');
    const onOutsideClick = vi.fn();
    outside.addEventListener('click', onOutsideClick);
    container.appendChild(outside);
    // 真机序列：mousedown（守卫只在这里撤武装）→ mouseup → click（栏外点击必须照常送达）
    let notSwallowed = false;
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      outside.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      notSwallowed = outside.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(notSwallowed).toBe(true); // 没被 preventDefault（栏外那一击不吞）
    expect(onOutsideClick).toHaveBeenCalled();
    expect(armedRow()).toBeNull(); // 红态不跨栏残留（否则下一击「删」一次就删）
    outside.remove();
  });

  it('庚 · 键盘 Enter（武装期间在别的行）= 只取消，不摊开', async () => {
    await mount();
    await arm(1);
    await act(async () => {
      rowOf(2).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(load()).not.toHaveBeenCalled();
    expect(armedRow()).toBeNull();
    await act(async () => {
      rowOf(2).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(load()).toHaveBeenCalledWith('', 2);
  });

  it('辛 · 拖行落位 = 别的意图：落位照常 + 武装同撤（红态不跨手势残留）', async () => {
    await mount();
    await arm(1);
    const canvas = document.createElement('div');
    canvas.className = 'pp-canvas';
    container.appendChild(canvas);
    const closed = rowOf(2);
    act(() => {
      closed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 40 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 5000, clientY: 30 }));
    });
    expect(getCanvasStore(panelId).getState().spread['2']).toBeTruthy(); // 落位照常
    expect(load()).toHaveBeenCalledWith('', 2);
    expect(armedRow()).toBeNull(); // 武装随落位撤
  });
});
