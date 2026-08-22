// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// C8 书脊列守护：SpineRack 渲染链 + 交互分派（换卷/另起一卷/双击改名/合卷）
// + session-store renameSession action + 合卷自动存数据面（closeSession 落盘
// 路径在 chat-session 单元测——本文件钉 UI 层分派不断）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionState } from '../src/agent/agent-session-state';
import { createExecState } from '../src/agent/execution-state';
import type { ChatCore } from '../src/app/chat/chat-core';
import { SpineRack } from '../src/app/panels/SpineRack';
import { getChatStore } from '../src/ui/chat-store';

/** 最小 ChatCore 桩：SpineRack 只消费这五个面。 */
function makeCore(panelId: string) {
  return {
    panelId,
    switchSession: vi.fn(),
    closeSession: vi.fn(),
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
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

describe('C8 SpineRack — 书脊列', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it('恒显：两卷出两条书脊 + 列尾另起一卷；当前卷 sr-active', () => {
    const core = makeCore('sr-t1');
    seedSessions(
      'sr-t1',
      [
        { id: 1, label: '卷首名甲' },
        { id: 2, label: '卷首名乙' },
      ],
      0,
    );
    act(() => {
      root?.render(<SpineRack core={core} />);
    });
    const spines = container!.querySelectorAll('.sr-spine');
    expect(spines).toHaveLength(2);
    expect(container!.querySelector('.sr-new')).not.toBeNull(); // 列尾虚脊恒显
    expect(spines[0].className).toContain('sr-active');
    expect(spines[1].className).not.toContain('sr-active');
    const labels = [...container!.querySelectorAll('.sr-label')].map((e) => e.textContent);
    expect(labels).toEqual(['卷首名甲', '卷首名乙']);
  });

  it('单卷也是一条脊（恒显语义）+ 虚脊', () => {
    const core = makeCore('sr-t2');
    seedSessions('sr-t2', [{ id: 1, label: '案卷 1' }], 0);
    act(() => {
      root?.render(<SpineRack core={core} />);
    });
    expect(container!.querySelectorAll('.sr-spine')).toHaveLength(1);
    expect(container!.querySelector('.sr-new')).not.toBeNull();
  });

  it('点脊换卷：按 id 反查索引调 core.switchSession', () => {
    const core = makeCore('sr-t3');
    seedSessions(
      'sr-t3',
      [
        { id: 1, label: 'a' },
        { id: 2, label: 'b' },
        { id: 3, label: 'c' },
      ],
      2,
    );
    act(() => {
      root?.render(<SpineRack core={core} />);
    });
    const mains = [...container!.querySelectorAll('.sr-spine-main')] as HTMLButtonElement[];
    act(() => {
      mains[1].click(); // 卷 id=2 → idx 1
    });
    expect(core.switchSession).toHaveBeenCalledWith(1);
    // 点当前卷（id=3, idx 2）不触发
    act(() => {
      mains[2].click();
    });
    expect(core.switchSession).toHaveBeenCalledTimes(1);
  });

  it('列尾虚脊另起一卷 → createNewSession', () => {
    const core = makeCore('sr-t4');
    seedSessions('sr-t4', [{ id: 1, label: 'x' }], 0);
    act(() => {
      root?.render(<SpineRack core={core} />);
    });
    act(() => {
      (container!.querySelector('.sr-new') as HTMLButtonElement).click();
    });
    expect(core.createNewSession).toHaveBeenCalledTimes(1);
  });

  it('双击题签 → 改名输入；Enter 提交调 core.renameSession', () => {
    const core = makeCore('sr-t5');
    seedSessions('sr-t5', [{ id: 7, label: '旧名' }], 0);
    act(() => {
      root?.render(<SpineRack core={core} />);
    });
    const main = container!.querySelector('.sr-spine-main') as HTMLButtonElement;
    act(() => {
      main.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = container!.querySelector('.sr-rename-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('旧名');
    act(() => {
      // React 受控输入：setter 直接驱动（dispatchEvent 不触发 React onChange）
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '新题签');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(core.renameSession).toHaveBeenCalledWith(7, '新题签');
    expect(container!.querySelector('.sr-rename-input')).toBeNull(); // 退出编辑态
  });

  it('运行中卷：呼吸点 + 合卷钮禁用 + 点击不 closeSession', () => {
    const core = makeCore('sr-t6');
    seedSessions(
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
    act(() => {
      root?.render(<SpineRack core={core} />);
    });
    act(() => {
      exec.start();
    });
    const spine0 = container!.querySelectorAll('.sr-spine')[0];
    expect(spine0.className).toContain('sr-running');
    expect(container!.querySelector('.sr-run-dot')).not.toBeNull();
    const closeBtns = [...container!.querySelectorAll('.sr-close-btn')] as HTMLButtonElement[];
    expect(closeBtns[0].disabled).toBe(true);
    act(() => {
      closeBtns[0].click();
    });
    expect(core.closeSession).not.toHaveBeenCalled();
    act(() => {
      exec.done();
    });
  });

  it('闲卷合卷钮 → core.closeSession(idx)', () => {
    const core = makeCore('sr-t7');
    seedSessions(
      'sr-t7',
      [
        { id: 1, label: 'a' },
        { id: 2, label: 'b' },
      ],
      0,
    );
    act(() => {
      root?.render(<SpineRack core={core} />);
    });
    const closeBtns = [...container!.querySelectorAll('.sr-close-btn')] as HTMLButtonElement[];
    act(() => {
      closeBtns[1].click(); // id=2 → idx 1
    });
    expect(core.closeSession).toHaveBeenCalledWith(1);
  });
});

describe('C8 session-store — renameSession action', () => {
  it('按 id 定位改 label，他卷不动', () => {
    const { sess } = getChatStore('sr-store-t1');
    sess.setState({
      sessions: [
        { id: 1, label: '一' },
        { id: 2, label: '二' },
      ],
      activeIdx: 0,
    });
    sess.getState().renameSession(2, '新名');
    const st = sess.getState();
    expect(st.sessions.map((s) => s.label)).toEqual(['一', '新名']);
    expect(st.activeIdx).toBe(0);
  });
});
