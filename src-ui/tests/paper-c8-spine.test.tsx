// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Stage-3 书脊列守护（2026-08-25 用户反馈收敛）：SpineRack = 画布空间导航器。
// 职责：左键定位 / 拖动落位 / hover 合卷（改名·删除在侧边栏，右键菜单已移除）。
// 旧 C8 语义（单击换卷 / 另起一卷 / 双击改名 / 卷目目录）随拆旧迭代拆除；
// 本文件钉当前行为。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionState } from '../src/agent/agent-session-state';
import { createExecState } from '../src/agent/execution-state';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { SpaceService } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { SpineRack } from '../src/plugins/builtin/canvas-nav/SpineRack';
import { getCanvasStore, resetCanvasStoresForTests } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { getChatStore } from '../src/ui/chat-store';

/** 最小 ChatCore 桩：SpineRack 只消费这几个面。listSavedSessions 供卷序
 *  合流（spineOrder，对齐侧边栏排序）——空盘 = 未落盘按卷号新者上。 */
function makeCore(panelId: string) {
  return {
    panelId,
    switchSession: vi.fn(),
    closeSession: vi.fn(),
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    deleteSessionFile: vi.fn(),
    listSavedSessions: vi.fn(async () => []),
  } as unknown as ChatCore & Record<string, ReturnType<typeof vi.fn>>;
}

function seedSessions(panelId: string, sessions: Array<{ id: number; label: string }>, activeIdx: number): void {
  getChatStore(panelId).sess.setState({
    sessions,
    activeIdx,
    sessionTokens: {},
    nextSessionId: sessions.length + 1,
  });
}

function bootSpine(panelId: string, sessions: Array<{ id: number; label: string }>, activeIdx: number) {
  const core = makeCore(panelId);
  useCoreStore.getState().setChatCore(core);
  seedSessions(panelId, sessions, activeIdx);
  const ctx = new Context();
  new SpaceService(ctx); // 激活 activeSpace()（书脊命令通道）
  return { core };
}

describe('SpineRack — 画布空间导航器（定位 / 拖落 / hover 合卷）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    resetCanvasStoresForTests();
    useCanvasViewStore.getState().requestFocus(null);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it('恒显：两卷出两条书脊 + 会话侧边栏开关；当前卷 sr-active（卷序对齐侧边栏：未落盘按卷号新者上）', async () => {
    bootSpine(
      'sr-t1',
      [
        { id: 1, label: '卷首名甲' },
        { id: 2, label: '卷首名乙' },
      ],
      0,
    );
    await act(async () => {
      root?.render(<SpineRack />);
    });
    const spines = container!.querySelectorAll('.sr-spine');
    expect(spines).toHaveLength(2);
    expect(container!.querySelector('.sr-sidebar-toggle')).not.toBeNull(); // 会话侧边栏开关
    // 卷序 = 侧边栏合流序（savedAt 缺省 → 卷号倒序）：乙(2) 在前，甲(1) 当前
    expect(spines[0].className).not.toContain('sr-active');
    expect(spines[1].className).toContain('sr-active');
    const labels = [...container!.querySelectorAll('.sr-label')].map((e) => e.textContent);
    expect(labels).toEqual(['卷首名乙', '卷首名甲']);
  });

  it('单卷也是一条脊（恒显语义）', async () => {
    bootSpine('sr-t2', [{ id: 1, label: '案卷 1' }], 0);
    await act(async () => {
      root?.render(<SpineRack />);
    });
    expect(container!.querySelectorAll('.sr-spine')).toHaveLength(1);
  });

  it('左键 = 定位器：切活跃会话 + 发定位请求（当前卷也飞）', async () => {
    const { core } = bootSpine(
      'sr-t3',
      [
        { id: 1, label: 'a' },
        { id: 2, label: 'b' },
        { id: 3, label: 'c' },
      ],
      2,
    );
    await act(async () => {
      root?.render(<SpineRack />);
    });
    const mains = [...container!.querySelectorAll('.sr-spine-main')] as HTMLElement[];
    act(() => {
      mains[1].click(); // 卷 id=2 → idx 1
    });
    expect(core.switchSession).toHaveBeenCalledWith(1);
    expect(useCanvasViewStore.getState().pendingFocusId).toBe('2');
    // 点当前卷（id=3，新序渲染在首位）：定位器语义 = 仍发定位请求（飞回当前流区）
    act(() => {
      mains[0].click();
    });
    expect(useCanvasViewStore.getState().pendingFocusId).toBe('3');
  });

  it('右键不弹菜单（书脊右键已移除——改名/删除归侧边栏）', async () => {
    bootSpine('sr-t4', [{ id: 7, label: '旧名' }], 0);
    await act(async () => {
      root?.render(<SpineRack />);
    });
    const main = container!.querySelector('.sr-spine-main') as HTMLElement;
    act(() => {
      main.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(container!.querySelector('.sr-menu')).toBeNull();
  });

  it('hover 小卡合卷：闲卷 → core.closeSession(idx)', async () => {
    const { core } = bootSpine(
      'sr-t5',
      [
        { id: 1, label: 'a' },
        { id: 2, label: 'b' },
      ],
      0,
    );
    await act(async () => {
      root?.render(<SpineRack />);
    });
    const closeBtns = [...container!.querySelectorAll('.sr-close-btn')] as HTMLButtonElement[];
    expect(closeBtns).toHaveLength(2);
    act(() => {
      closeBtns[0].click(); // 新序 b(id=2) 在前位 → store idx 1
    });
    expect(core.closeSession).toHaveBeenCalledWith(1);
  });

  it('运行中卷：合卷钮禁用（不可半途 dispose agent）', async () => {
    const { core } = bootSpine(
      'sr-t6',
      [
        { id: 1, label: '跑着的' },
        { id: 2, label: '闲的' },
      ],
      0,
    );
    const exec = createExecState();
    act(() => {
      agentSessionState.setExec('sr-t6', 1, exec);
    });
    await act(async () => {
      root?.render(<SpineRack />);
    });
    act(() => {
      exec.start();
    });
    const closeBtns = [...container!.querySelectorAll('.sr-close-btn')] as HTMLButtonElement[];
    expect(closeBtns[1].disabled).toBe(true); // 新序：跑着的(id=1) 渲染在后位
    act(() => {
      closeBtns[1].click();
    });
    // 运行中点击（disabled 按钮不触发 onClick）不得触达 closeSession
    expect(core.closeSession).not.toHaveBeenCalled();
    act(() => {
      exec.done();
    });
  });

  it('拖动落位：抽书放桌——松手 place 到吸附网格空列', async () => {
    bootSpine('sr-t7', [{ id: 1, label: 'a' }], 0);
    await act(async () => {
      root?.render(<SpineRack />);
    });
    // 画布坐标源（书脊跨组件读取 .pp-canvas 视口 rect——React root 会清空
    // 容器，所以渲染后再铺画布元素）
    const canvas = document.createElement('div');
    canvas.className = 'pp-canvas';
    container!.appendChild(canvas);
    const main = container!.querySelector('.sr-spine-main') as HTMLElement;
    act(() => {
      main.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 20 }));
    });
    expect(container!.querySelector('.sr-drag-ghost')).not.toBeNull(); // 幽灵预览
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 2600, clientY: 30 }));
    });
    // 世界 x=2600 空位（无重叠）→ 拖到哪落哪（P6 区间模型，不吸附）；y=用户落点 30
    expect(getCanvasStore('sr-t7').getState().spread['1']).toEqual({
      anchorX: 2600,
      anchorY: 30,
      width: 1440,
    });
  });
});
