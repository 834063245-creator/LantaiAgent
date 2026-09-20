// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话树「枝」的**侧面守护**（P2 立项件 `docs/plans/session-tree-plan.md` §5/§7；
// 2026-09-20 双视角批 `docs/plans/sidebar-two-views-plan.md` §4 **规格变更**后）：
//   ① 合流：血缘只在盘上那一源（摊开集没有它）——摊开行沿用其盘上行的边；
//   ② **票面排布（纯模型）** `treeRows`：子行紧随其父（DFS）、depth 逐层 +1、`lastAt`/`kids`；
//   ③ 血缘悬空（父卷不在场）= 外部删除/拷走 ⇒ 标「父卷已删」，不阻塞打开；
//   ④ 坏血缘（环/自环）**绝不吞行**；
//   ⑤ **票面渲染**：案卷视图 = 扁平时间序 + `↳N` 记号（不缩进——规格变更）；枝视图 = 族不拆 +
//      引线折角 + 「▾ N 枝」汇总（视角用例见 tests/session-sidebar-views.test.tsx）。
//
// 纯函数面直接测（不走渲染），渲染面走真组件（生产单点）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { SpaceService } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { SessionSidebar } from '../src/plugins/builtin/canvas-nav/SessionSidebar';
import {
  mergeSessionRows,
  type SidebarRow,
  sessionMeta,
  splitSections,
  treeRows,
} from '../src/plugins/builtin/canvas-nav/session-sidebar-model';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { getChatStore } from '../src/ui/chat-store';

const T1 = '2026-01-01T00:00:00Z';
const T2 = '2026-02-01T00:00:00Z';

/** 行工厂（纯函数面用；只填被测字段）。 */
function row(id: number, extra: Partial<SidebarRow> = {}): SidebarRow {
  return { id, label: `卷${id}`, savedAt: T1, open: false, msgCount: 1, status: 'idle', ...extra };
}

describe('会话树「枝」——合流与树形排布（纯模型）', () => {
  it('合流：血缘只在盘上那一源——摊开行沿用其盘上行的边', () => {
    const rows = mergeSessionRows(
      [{ id: 2, label: '枝卷', msgCount: 1 }],
      [
        { id: 1, label: '父卷', msgCount: 2, savedAt: T1 },
        { id: 2, label: '', msgCount: 1, savedAt: T2, parentId: 1 },
      ],
    );
    expect(rows.find((r) => r.id === 1)?.parentId).toBeUndefined(); // 根卷无父
    expect(rows.find((r) => r.id === 2)?.parentId).toBe(1); // 摊开行带上了盘上的边
    expect(rows.find((r) => r.id === 2)?.label).toBe('枝卷'); // 内存最新优先（原行为未变）
  });

  it('树形：子行紧随其父（DFS）+ depth 逐层 +1；兄弟间保持合流序', () => {
    const rows = [row(3, { parentId: 1 }), row(1), row(4, { parentId: 2 }), row(2, { parentId: 1 })];
    const tree = treeRows(rows, new Set([1, 2, 3, 4]));
    expect(tree.map((r) => r.id)).toEqual([1, 3, 2, 4]);
    expect(tree.map((r) => r.depth)).toEqual([0, 1, 1, 2]);
    expect(tree.every((r) => !r.orphan)).toBe(true);
  });

  it('父不在本节 ⇒ 当根行（缩进归 0）；父不在场 ⇒ 标「父卷已删」', () => {
    const sections = splitSections([
      row(1, { open: true }),
      row(2, { open: true, parentId: 1 }), // 父在本节 → 嵌套
      row(5, { parentId: 1 }), // 父在另一节 → 本节根行
      row(6, { parentId: 99 }), // 父不在场 → 悬空
    ]);
    const openTree = treeRows(sections.open, new Set([1, 2, 5, 6]));
    expect(openTree.map((r) => [r.id, r.depth])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    const closedTree = treeRows(sections.closed, new Set([1, 2, 5, 6]));
    expect(closedTree.map((r) => [r.id, r.depth])).toEqual([
      [5, 0],
      [6, 0],
    ]);
    expect(closedTree.find((r) => r.id === 5)?.orphan).toBeUndefined(); // 父在场（只是不在此节）
    expect(closedTree.find((r) => r.id === 6)?.orphan).toBe(true);
    expect(sessionMeta(closedTree.find((r) => r.id === 6) as SidebarRow, Date.now())).toContain('父卷已删');
  });

  it('坏血缘（环/自环）绝不吞行：从根走不到的行末尾按根行补出', () => {
    const cyclic = treeRows([row(1, { parentId: 2 }), row(2, { parentId: 1 })], new Set([1, 2]));
    expect(cyclic.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(cyclic.map((r) => r.depth)).toEqual([0, 1]); // 一环被当根行，另一环跟随
    const self = treeRows([row(7, { parentId: 7 })], new Set([7]));
    expect(self.map((r) => [r.id, r.depth])).toEqual([[7, 0]]);
  });
});

describe('会话树「枝」——侧栏树面（渲染）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let panelId: string;

  function fakeCore(saved: Array<Record<string, unknown>>): ChatCore {
    return {
      panelId,
      listSavedSessions: vi.fn(async () => saved),
      createNewSession: vi.fn(),
      renameSession: vi.fn(),
      renameSavedSession: vi.fn(),
      closeSession: vi.fn(),
      deleteSessionFile: vi.fn(),
      loadSessionFromDisk: vi.fn(async () => true),
      switchSession: vi.fn(),
    } as unknown as ChatCore;
  }

  beforeEach(() => {
    panelId = `test-ss-tree-${Math.random().toString(36).slice(2)}`;
    resetCanvasStoresForTests();
    useShellStore.getState().setProjectPath('');
    useCanvasViewStore.getState().requestFocus(null);
    localStorage.removeItem('lantai.sidebar.folds');
    localStorage.removeItem('lantai.sidebar.width');
    localStorage.removeItem('lantai.sidebar.view'); // 视角也持久化：不隔离就会串到下一个用例
    new SpaceService(new Context()); // 激活 activeSpace()（行点击 = expand 摊开/定位）
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  async function mount(core: ChatCore): Promise<void> {
    useCoreStore.getState().setChatCore(core);
    await act(async () => {
      root?.unmount();
      root = createRoot(container);
      root.render(<SessionSidebar />);
    });
    await act(async () => {});
  }

  it('案卷视图（默认）：**扁平时间序**——枝卷在前（它更新）、不缩进、带「枝」牌 + 父卷号', async () => {
    getChatStore(panelId).sess.setState({
      sessions: [
        { id: 1, label: '父卷' },
        { id: 2, label: '枝卷' },
      ],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 3,
    });
    await mount(
      fakeCore([
        { id: 1, label: '父卷', msgCount: 2, savedAt: T1 },
        { id: 2, label: '枝卷', msgCount: 1, savedAt: T2, parentId: 1 },
      ]),
    );

    // 口径变更（2026-09-20 双视角批，plan §4）：案卷视图**不排树**——时间序说话
    const labels = [...container.querySelectorAll('.ss-row .ss-label')].map((e) => e.textContent);
    expect(labels).toEqual(['枝卷', '父卷']);
    const rows = [...container.querySelectorAll('.ss-row')] as HTMLElement[];
    expect(rows[0].style.paddingLeft).toBe(''); // 扁平：不缩进（缩进归枝视图的引线）
    expect(rows[0].className).toContain('branch');
    // 枝卷的明显标识 = 「枝」牌（与书脊/卷首同一枚标），牌上带父卷号
    const tags = [...container.querySelectorAll('.ss-row .ss-branch-tag')];
    expect(tags).toHaveLength(1);
    expect(tags[0].textContent).toContain('枝');
    expect(tags[0].querySelector('.ss-tag-src')?.textContent).toBe('1');
    expect(rows[0].getAttribute('title')).toContain('枝（父卷 Nº 1）');
  });

  it('枝视图：族不拆——父子同屏且子行带引线折角 + 父行「▾ N 枝」汇总', async () => {
    getChatStore(panelId).sess.setState({
      sessions: [
        { id: 1, label: '父卷' },
        { id: 2, label: '枝卷' },
      ],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 3,
    });
    await mount(
      fakeCore([
        { id: 1, label: '父卷', msgCount: 2, savedAt: T1 },
        { id: 2, label: '枝卷', msgCount: 1, savedAt: T2, parentId: 1 },
      ]),
    );
    await act(async () => {
      (container.querySelector('.ss-views button:last-child') as HTMLElement).click();
    });

    const rows = [...container.querySelectorAll('.ss-row')] as HTMLElement[];
    expect(rows.map((r) => r.dataset.depth)).toEqual(['0', '1']); // 父子同屏，子行 depth 1
    expect(rows[1].querySelectorAll('.ss-guide .gl')).toHaveLength(1); // 一层引线
    expect(rows[0].querySelector('.ss-kids')?.textContent).toContain('1 枝');
    expect(rows[0].querySelector('.ss-kids')?.getAttribute('aria-expanded')).toBe('true');
    // 折枝：子行退场，出折起注记；再点回来
    await act(async () => {
      (rows[0].querySelector('.ss-kids') as HTMLElement).click();
    });
    expect(container.querySelectorAll('.ss-row')).toHaveLength(1);
    expect(container.querySelector('.ss-folded-note')?.textContent).toContain('折起的 1 枝');
    await act(async () => {
      (container.querySelector('.ss-kids') as HTMLElement).click();
    });
    expect(container.querySelectorAll('.ss-row')).toHaveLength(2);
  });

  it('血缘悬空（父卷不在场）：行照常出、注记「父卷已删」、不阻塞点开', async () => {
    await mount(fakeCore([{ id: 5, label: '孤枝', msgCount: 3, savedAt: T1, parentId: 99 }]));

    const meta = container.querySelector('.ss-row .ss-meta')?.textContent ?? '';
    expect(meta).toContain('父卷已删');
    expect(container.querySelector('.ss-row .ss-tag-src')?.textContent).toBe('99');
    expect(container.querySelector('.ss-row')?.className).toContain('orphan');
    // 点开照常（不因血缘悬空被挡）
    await act(async () => {
      (container.querySelector('.ss-row') as HTMLElement).click();
    });
    expect(useCanvasViewStore.getState().pendingFocusId).toBe('5');
  });
});
