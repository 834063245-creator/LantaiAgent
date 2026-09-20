// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 案卷侧栏**双视角**（案卷 ⇄ 枝）的渲染面守护（立项件 `docs/plans/sidebar-two-views-plan.md` §3）：
//   ① 分段切换 + 视角持久化（`lantai.sidebar.view`，坏值 → 默认案卷）；
//   ② 案卷视图：血缘卡（父卷名 + 摊开父卷）、悬空朱砂记号；
//   ③ 检索：**保祖先上下文行**（弱墨在场，血缘不因检索丢）；
//   ④ 枝视图：←/→ 折枝与回父；族不拆（跨摊开/已合卷）。
//
// 渲染面走真组件（生产单点）；纯函数面见 tests/session-sidebar-views-model.test.ts。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { SpaceService } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { SessionSidebar } from '../src/plugins/builtin/canvas-nav/SessionSidebar';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { getChatStore } from '../src/ui/chat-store';

const T1 = '2026-01-01T00:00:00Z';
const T2 = '2026-02-01T00:00:00Z';

describe('案卷侧栏双视角（案卷 ⇄ 枝）', () => {
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
    panelId = `test-ss-views-${Math.random().toString(36).slice(2)}`;
    resetCanvasStoresForTests();
    useShellStore.getState().setProjectPath('');
    useCanvasViewStore.getState().requestFocus(null);
    localStorage.removeItem('lantai.sidebar.folds');
    localStorage.removeItem('lantai.sidebar.width');
    localStorage.removeItem('lantai.sidebar.view');
    new SpaceService(new Context());
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  async function mount(core: ChatCore, sessions: Array<{ id: number; label: string }> = []): Promise<void> {
    getChatStore(panelId).sess.setState({
      sessions,
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 99,
    });
    useCoreStore.getState().setChatCore(core);
    await act(async () => {
      root?.unmount();
      root = createRoot(container);
      root.render(<SessionSidebar />);
    });
    await act(async () => {});
  }

  const rows = () => [...container.querySelectorAll('.ss-row')] as HTMLElement[];
  const viewButtons = () => [...container.querySelectorAll('.ss-views button')] as HTMLElement[];
  const click = async (el: Element | null | undefined) => {
    await act(async () => {
      (el as HTMLElement).click();
    });
  };

  it('默认案卷视图；切到枝视图后写 localStorage，重挂仍生效', async () => {
    const core = fakeCore([
      { id: 1, label: '父卷', msgCount: 2, savedAt: T1 },
      { id: 2, label: '枝卷', msgCount: 1, savedAt: T2, parentId: 1 },
    ]);
    await mount(core);
    expect(container.querySelector('.ss-list')?.getAttribute('data-view')).toBe('case');
    expect(viewButtons()[0].getAttribute('aria-selected')).toBe('true');

    await click(viewButtons()[1]);
    expect(container.querySelector('.ss-list')?.getAttribute('data-view')).toBe('tree');
    expect(localStorage.getItem('lantai.sidebar.view')).toBe('tree');

    // 重挂（新组件实例）= 读回持久化视角
    await mount(core);
    expect(container.querySelector('.ss-list')?.getAttribute('data-view')).toBe('tree');
  });

  it('坏值容错：未知视角一律回落到案卷视图', async () => {
    localStorage.setItem('lantai.sidebar.view', '支');
    await mount(fakeCore([{ id: 1, label: '独卷', msgCount: 1, savedAt: T1 }]));
    expect(container.querySelector('.ss-list')?.getAttribute('data-view')).toBe('case');
  });

  /** hover 一枚记号（React 的 onMouseEnter 由 mouseover 合成——原生 mouseenter 不触发）。 */
  const hover = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
  };

  it('血缘卡：hover「枝」牌 ⇒ 出父卷名 + 「摊开父卷」；指针移到卡上**不消失**（热区不断链）', async () => {
    const core = fakeCore([
      { id: 1, label: '父卷', msgCount: 2, savedAt: T1 },
      { id: 2, label: '枝卷', msgCount: 1, savedAt: T2, parentId: 1 },
    ]);
    await mount(core);
    const tag = rows()[0].querySelector('.ss-branch-tag') as HTMLElement;
    expect(tag.textContent).toContain('枝'); // 枝卷的明显标识（与书脊/卷首同一枚标）
    expect(tag.querySelector('.ss-tag-src')?.textContent).toBe('1'); // 牌上带父卷号
    expect(container.querySelector('.ss-lineage-card')).toBeNull(); // 常态不出卡

    await hover(tag);
    const card = container.querySelector('.ss-lineage-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector('.t')?.textContent).toBe('父卷');
    // 卡与牌同属 .ss-lineage 子树：从牌移到卡 = 仍在热区内，mouseleave 不该关它
    await act(async () => {
      tag.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: card }));
    });
    expect(container.querySelector('.ss-lineage-card')).not.toBeNull();

    await click([...card.querySelectorAll('.acts button')].find((b) => b.textContent === '摊开父卷'));
    expect(useCanvasViewStore.getState().pendingFocusId).toBe('1'); // expand(父卷)
    expect(container.querySelector('.ss-lineage-card')).toBeNull(); // 用完即收
  });

  it('血缘卡：指针掉出热区后有 200ms 宽限（横穿 meta 行那一截不判死）', async () => {
    vi.useFakeTimers();
    try {
      await mount(
        fakeCore([
          { id: 1, label: '父卷', msgCount: 2, savedAt: T1 },
          { id: 2, label: '枝卷', msgCount: 1, savedAt: T2, parentId: 1 },
        ]),
      );
      const tag = rows()[0].querySelector('.ss-branch-tag') as HTMLElement;
      await act(async () => {
        tag.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(container.querySelector('.ss-lineage-card')).not.toBeNull();
      await act(async () => {
        (container.querySelector('.ss-lineage') as HTMLElement).dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
        );
      });
      expect(container.querySelector('.ss-lineage-card')).not.toBeNull(); // 宽限内不关
      await act(async () => {
        vi.advanceTimersByTime(260);
      });
      expect(container.querySelector('.ss-lineage-card')).toBeNull(); // 宽限过后果断收
    } finally {
      vi.useRealTimers();
    }
  });

  it('悬空血缘：案卷视图那枚牌转朱砂边（.orphan），卡里说「不在场」且不给「摊开父卷」', async () => {
    await mount(fakeCore([{ id: 5, label: '孤枝', msgCount: 1, savedAt: T1, parentId: 99 }]));
    const row = rows()[0];
    expect(row.className).toContain('orphan');
    await hover(row.querySelector('.ss-branch-tag') as HTMLElement);
    const card = container.querySelector('.ss-lineage-card') as HTMLElement;
    expect(card.querySelector('.t')?.textContent).toContain('不在场');
    expect([...card.querySelectorAll('.acts button')].map((b) => b.textContent)).toEqual(['知道了']);
  });

  it('检索保祖先链：搜子卷名 ⇒ 父卷以「上下文」行在场（弱墨），血缘不因检索丢', async () => {
    await mount(
      fakeCore([
        { id: 1, label: '父卷', msgCount: 2, savedAt: T1 },
        { id: 2, label: '枝卷', msgCount: 1, savedAt: T2, parentId: 1 },
      ]),
    );
    const input = container.querySelector('.ss-search input') as HTMLInputElement;
    await act(async () => {
      // React 受控输入：走原生 setter + input 事件
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '枝卷');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const labels = [...container.querySelectorAll('.ss-row .ss-label')].map((e) => e.textContent);
    expect(labels).toEqual(['父卷', '枝卷']); // 父卷作为上下文补出
    expect(rows()[0].className).toContain('context');
    expect(rows()[0].querySelector('.ss-context-tag')?.textContent).toBe('上下文');
    expect(rows()[1].className).not.toContain('context');
  });

  it('枝视图键盘：← 折枝 / → 展开；族不拆（父已合卷、子在摊开集也同屏）', async () => {
    const core = fakeCore([
      { id: 1, label: '父卷', msgCount: 2, savedAt: T1 },
      { id: 2, label: '枝卷', msgCount: 1, savedAt: T2, parentId: 1 },
    ]);
    // 子卷摊开、父卷已合卷：案卷视图会分居两节；枝视图必须同屏
    await mount(core, [{ id: 2, label: '枝卷' }]);
    await click(viewButtons()[1]);
    expect(rows().map((r) => r.dataset.id)).toEqual(['1', '2']);
    expect(rows().map((r) => r.dataset.depth)).toEqual(['0', '1']);

    const list = container.querySelector('.ss-list') as HTMLElement;
    const key = async (k: string) => {
      await act(async () => {
        list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    };
    const focusRow = async (i: number) => {
      await act(async () => {
        rows()[i].focus();
      });
    };
    await focusRow(0);
    await key('ArrowLeft');
    expect(rows()).toHaveLength(1); // 折起
    await key('ArrowRight');
    expect(rows()).toHaveLength(2); // 展开
    await focusRow(0);
    await key('ArrowRight'); // 已展开 ⇒ 进第一个子行
    expect(document.activeElement?.getAttribute('data-id')).toBe('2');
    await key('ArrowLeft'); // 子行无枝 ⇒ 回父行
    expect(document.activeElement?.getAttribute('data-id')).toBe('1');
  });
});
