// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionSidebar 注疏重排守护（2026-08-31）+ UX 批（2026-09-02）：
// 分节渲染（摊开中 OPEN / 已合卷 CLOSED）+ 当前卷标记 + 常驻检索 +
// 键盘导航（↓ / ↑↓ / F2 / Delete 两击 / C 合卷 / X 勾选 / Ctrl+A）+
// 多选批量删除（两击确认）+ 节/桶折叠（「更早」默认收起 + localStorage）+
// Esc 四级撤退（清选择 → 收侧栏）+ 行拖放落位（闭合卷先落位再摊开）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { agentSessionState } from '../src/agent/agent-session-state';
import { createExecState } from '../src/agent/execution-state';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { SpaceService } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { SessionSidebar } from '../src/plugins/builtin/canvas-nav/SessionSidebar';
import { getCanvasStore, resetCanvasStoresForTests } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { getChatStore } from '../src/ui/chat-store';

function fakeCore(panelId: string): { core: ChatCore; deleteSessionFile: Mock } {
  const deleteSessionFile = vi.fn();
  const core = {
    panelId,
    listSavedSessions: vi.fn(async () => [
      // 3 天前 = 恒落「7 天内」桶（单桶 → 不立桶头，标签序断言稳定）
      { id: 2, label: '盘卷甲', msgCount: 5, savedAt: new Date(Date.now() - 3 * 86400_000).toISOString() },
    ]),
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    renameSavedSession: vi.fn(),
    closeSession: vi.fn(),
    deleteSessionFile,
    loadSessionFromDisk: vi.fn(async () => {}),
    switchSession: vi.fn(),
  } as unknown as ChatCore;
  return { core, deleteSessionFile };
}

/** React 受控 input 的原生设值（绕开 value tracker 去重）。 */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function keydown(el: Element, key: string, opts: { ctrlKey?: boolean } = {}): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
}

describe('SessionSidebar 注疏重排（分节/检索/键盘）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let panelId: string;
  let core: ChatCore;
  let deleteSessionFile: Mock;

  beforeEach(() => {
    panelId = `test-ss-ux-${Math.random().toString(36).slice(2)}`;
    resetCanvasStoresForTests();
    useShellStore.getState().setProjectPath('');
    useCanvasViewStore.getState().requestFocus(null);
    // 折叠面/宽度持久键清零——测试间不泄漏（jsdom localStorage 同进程共享）
    localStorage.removeItem('lantai.sidebar.folds');
    localStorage.removeItem('lantai.sidebar.width');
    container = document.createElement('div');
    document.body.appendChild(container);
    ({ core, deleteSessionFile } = fakeCore(panelId));
    useCoreStore.getState().setChatCore(core);
    // 摊开两卷（卷 1 = 当前卷，均未落盘）+ 盘上一卷（未摊开）
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

  it('分节渲染：摊开中 OPEN 在前 + 已合卷 CLOSED 在后；当前卷带标记；未落盘出「未存」', async () => {
    await mount();
    const heads = [...container.querySelectorAll('.ss-section-head .n')].map((e) => e.textContent);
    expect(heads).toEqual(['OPEN · 2', 'CLOSED · 1']);
    // 摊开节在前（同组新者上——未落盘卷按卷号倒序），合卷节殿后
    const labels = [...container.querySelectorAll('.ss-row .ss-label')].map((e) => e.textContent);
    expect(labels).toEqual(['Cordis 迁移', '案卷一', '盘卷甲']);
    const current = container.querySelector('.ss-row.current .ss-label');
    expect(current?.textContent).toBe('案卷一'); // activeIdx → 卷 1
    expect(container.querySelector('.ss-count')?.textContent).toBe('SESSIONS · 3');
    // 未落盘卷（无 savedAt）行注记出「未存」段（2026-09-02）
    const metas = [...container.querySelectorAll('.ss-row .ss-meta')].map((e) => e.textContent);
    expect(metas[0]).toContain('未存'); // Cordis 迁移（未落盘摊开卷）
  });

  it('检索：即输即滤 + 无匹配空态 + Esc 清空还原（不误收侧栏）', async () => {
    useDockStore.getState().openPanel('canvas-sidebar');
    await mount();
    const input = container.querySelector('.ss-search input') as HTMLInputElement;
    act(() => setNativeValue(input, '甲'));
    const labels = [...container.querySelectorAll('.ss-row .ss-label')].map((e) => e.textContent);
    expect(labels).toEqual(['盘卷甲']); // 只剩已合卷节命中行
    expect([...container.querySelectorAll('.ss-section-head .n')].map((e) => e.textContent)).toEqual(['CLOSED · 1']);
    act(() => setNativeValue(input, '不存在'));
    expect(container.querySelectorAll('.ss-row')).toHaveLength(0);
    expect(container.querySelector('.ss-empty')?.textContent).toBe('无匹配案卷');
    act(() => keydown(input, 'Escape'));
    expect(input.value).toBe(''); // 清空还原
    expect(container.querySelectorAll('.ss-row')).toHaveLength(3);
    // 检索条 Esc 截停（stopPropagation）——不落收侧栏
    expect(useDockStore.getState().open['canvas-sidebar']).toBe(true);
  });

  it('键盘：↓ 落列表首行，↑↓ 移动游标（roving tabindex）', async () => {
    await mount();
    const input = container.querySelector('.ss-search input') as HTMLInputElement;
    const rows = [...container.querySelectorAll('.ss-row')] as HTMLElement[];
    act(() => keydown(input, 'ArrowDown'));
    expect(document.activeElement).toBe(rows[0]);
    expect(rows[0].tabIndex).toBe(0);
    expect(rows[1].tabIndex).toBe(-1);
    act(() => keydown(rows[0], 'ArrowDown'));
    expect(document.activeElement).toBe(rows[1]);
    act(() => keydown(rows[1], 'ArrowUp'));
    expect(document.activeElement).toBe(rows[0]);
  });

  it('键盘 F2 进入改名 + Esc 取消', async () => {
    await mount();
    const row = container.querySelector('.ss-row') as HTMLElement;
    act(() => row.focus()); // onFocus → 游标切到该行
    act(() => keydown(row, 'F2'));
    const renameInput = container.querySelector('.ss-rename-input') as HTMLInputElement;
    expect(renameInput).not.toBeNull();
    expect(renameInput.value).toBe('Cordis 迁移');
    act(() => keydown(renameInput, 'Escape'));
    expect(container.querySelector('.ss-rename-input')).toBeNull();
  });

  it('键盘 Delete：一击武装（确删?）再一击写墓碑', async () => {
    await mount();
    const rows = [...container.querySelectorAll('.ss-row')] as HTMLElement[];
    const closed = rows[rows.length - 1]; // 盘卷甲（id 2，未摊开）
    act(() => closed.focus()); // onFocus → 游标切到该行
    act(() => keydown(closed, 'Delete')); // 一击：武装
    const danger = container.querySelector('.ss-danger') as HTMLButtonElement;
    expect(danger?.textContent).toBe('确删?');
    expect(deleteSessionFile).not.toHaveBeenCalled();
    act(() => {
      danger.click();
    }); // 再击：写墓碑
    expect(deleteSessionFile).toHaveBeenCalledWith('', 2);
  });

  it('键盘 C 合卷：游标在摊开卷 → closeSession；闭合卷无效', async () => {
    await mount();
    const rows = [...container.querySelectorAll('.ss-row')] as HTMLElement[];
    act(() => rows[0].focus()); // Cordis 迁移（id 3，摊开）
    act(() => keydown(rows[0], 'c'));
    expect(core.closeSession).toHaveBeenCalledWith(1); // sessions [{1},{3}] → idx 1
    act(() => rows[2].focus()); // 盘卷甲（闭合）
    act(() => keydown(rows[2], 'c'));
    expect(core.closeSession).toHaveBeenCalledTimes(1); // 闭合卷 C 无效
  });

  it('多选批量删除：勾选两卷 → 批量条两击确认 → 逐卷写墓碑', async () => {
    await mount();
    const checks = [...container.querySelectorAll('.ss-check')] as HTMLButtonElement[];
    act(() => checks[0].click()); // Cordis 迁移
    act(() => checks[2].click()); // 盘卷甲
    expect(container.querySelector('.ss-batch-n')?.textContent).toBe('已选 2 卷');
    const del = container.querySelector('.ss-batch-del') as HTMLButtonElement;
    expect(del.textContent).toBe('删除所选');
    act(() => del.click()); // 一击：武装
    const armed = container.querySelector('.ss-batch-del') as HTMLButtonElement;
    expect(armed.textContent).toBe('确删 2 卷?');
    expect(deleteSessionFile).not.toHaveBeenCalled();
    act(() => armed.click()); // 再击：执行
    expect(deleteSessionFile).toHaveBeenCalledTimes(2);
    expect(deleteSessionFile).toHaveBeenCalledWith('', 3);
    expect(deleteSessionFile).toHaveBeenCalledWith('', 2);
    expect(container.querySelector('.ss-new')).not.toBeNull(); // 选择清空 → 脚部复位
  });

  it('批量删除：运行中卷跳过并报数', async () => {
    await mount();
    const exec = createExecState();
    act(() => {
      agentSessionState.setExec(panelId, 3, exec); // Cordis 迁移运行中
    });
    act(() => {
      exec.start();
    });
    const checks = [...container.querySelectorAll('.ss-check')] as HTMLButtonElement[];
    act(() => checks[0].click()); // 运行中的 Cordis
    act(() => checks[2].click()); // 闲的盘卷甲
    const del = container.querySelector('.ss-batch-del') as HTMLButtonElement;
    act(() => del.click()); // 武装
    act(() => del.click()); // 执行
    expect(deleteSessionFile).toHaveBeenCalledTimes(1);
    expect(deleteSessionFile).toHaveBeenCalledWith('', 2); // 只删闲卷
    expect(container.querySelector('.ss-notice')?.textContent).toContain('1 卷运行中已跳过');
    act(() => {
      exec.done();
    });
  });

  it('Ctrl+A 全选可见 + Esc 清选择复位脚部（不收侧栏）', async () => {
    useDockStore.getState().openPanel('canvas-sidebar');
    await mount();
    const list = container.querySelector('.ss-list') as HTMLElement;
    act(() => keydown(list, 'a', { ctrlKey: true }));
    expect(container.querySelector('.ss-batch-n')?.textContent).toBe('已选 3 卷');
    // Esc（列表容器上冒泡到根）→ 清选择（不是收侧栏）
    act(() => keydown(list, 'Escape'));
    expect(container.querySelector('.ss-batch')).toBeNull();
    expect(container.querySelector('.ss-new')).not.toBeNull();
    expect(useDockStore.getState().open['canvas-sidebar']).toBe(true); // 侧栏未收
  });

  it('Esc 四级撤退：无武装无选择时收侧栏（互斥两态回书脊）', async () => {
    useDockStore.getState().openPanel('canvas-sidebar');
    await mount();
    const aside = container.querySelector('.ss-sidebar') as HTMLElement;
    expect(useDockStore.getState().open['canvas-sidebar']).toBe(true);
    act(() => keydown(aside, 'Escape'));
    expect(useDockStore.getState().open['canvas-sidebar']).toBe(false);
  });

  it('节/桶折叠：多桶立头、「更早」默认收起、展开可点、localStorage 持久', async () => {
    // 换盘：一卷今天 + 一卷 30 天前（更早）→ 双桶立头
    (core as unknown as { listSavedSessions: Mock }).listSavedSessions.mockResolvedValue([
      { id: 2, label: '今天的盘卷', msgCount: 5, savedAt: new Date().toISOString() },
      { id: 4, label: '上月旧卷', msgCount: 9, savedAt: new Date(Date.now() - 30 * 86400_000).toISOString() },
    ]);
    await mount();
    const bucketHeads = [...container.querySelectorAll('.ss-bucket-head')];
    expect(bucketHeads.map((h) => h.textContent)).toEqual(['今天TODAY · 1', '更早EARLIER · 1']);
    // 更早默认收起：旧卷行不在场
    expect([...container.querySelectorAll('.ss-label')].map((e) => e.textContent)).not.toContain('上月旧卷');
    expect(bucketHeads[1].className).toContain('folded');
    // 点「更早」头展开
    act(() => bucketHeads[1].click());
    expect([...container.querySelectorAll('.ss-label')].map((e) => e.textContent)).toContain('上月旧卷');
    // 折叠态持久（localStorage）——重挂载后仍展开
    await mount();
    expect([...container.querySelectorAll('.ss-label')].map((e) => e.textContent)).toContain('上月旧卷');
    // 已合卷节头整体折叠：全部闭合卷退场，摊开节不受影响
    const closedHead = [...container.querySelectorAll('.ss-section-head')].find((h) =>
      h.textContent?.includes('CLOSED'),
    ) as HTMLButtonElement;
    act(() => closedHead.click());
    const labels = [...container.querySelectorAll('.ss-row .ss-label')].map((e) => e.textContent);
    expect(labels).toEqual(['Cordis 迁移', '案卷一']); // 只剩摊开节
  });

  it('行拖放落位：闭合卷拖进画布 = 先落位再摊开（expand 承接聚焦）', async () => {
    const ctx = new Context();
    new SpaceService(ctx); // 激活 activeSpace()（空间命令通道）
    await mount();
    // 画布坐标源（跨组件读 .pp-canvas 视口 rect——React root 会清空容器，
    // 渲染后再铺画布元素）
    const canvas = document.createElement('div');
    canvas.className = 'pp-canvas';
    container.appendChild(canvas);
    const rows = [...container.querySelectorAll('.ss-row')] as HTMLElement[];
    const closed = rows[rows.length - 1]; // 盘卷甲（id 2，闭合）
    act(() => {
      closed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 40 }));
    });
    expect(container.querySelector('.ss-drag-ghost')).not.toBeNull(); // 幽灵预览
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 5000, clientY: 30 }));
    });
    // 世界 x=5000 空位（摊开卷默认位 0/1560 不重叠）→ 拖到哪落哪；y=用户落点
    expect(getCanvasStore(panelId).getState().spread['2']).toEqual({
      anchorX: 5000,
      anchorY: 30,
      width: 1440,
    });
    expect((core as unknown as { loadSessionFromDisk: Mock }).loadSessionFromDisk).toHaveBeenCalledWith('', 2); // 闭合卷 = 摊开
  });
});
