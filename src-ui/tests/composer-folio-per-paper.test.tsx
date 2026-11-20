// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸 · **题签读数是自己的那张**（2026-11-29 多纸错位批）。
//
// 病灶（用户报）：「非焦点态显示的组合 / 模型 / 思考强度 / 权限 和实际设置的不符，很奇怪。」
//   · 题签行按纸挂（`DraftSheet` 每张纸各挂一行，`DraftFolioLine` → 'draft-folio' 槽 →
//     compose-dock 的 `DraftFolioSurface`），但那一批 hook 一律读
//     `draft-sheet-store.focusedId` ⇒ **每张纸的行显示的都是焦点那张纸的三笔**；
//   · 写入同理：在非焦点那张上拨一下，写进的是焦点那张的记录。
//
// 现行语义（本文件钉的就是它）：**纸是宿主，读数与写入都归自己那条记录**。
// 覆盖层贡献的契约是 `ComponentType`（无 props），故宿主经 `DraftPaperContext` 下发纸 id。
//
// 判据全部读 DOM（用户看得见的那一行），不钉实现细节。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '../src/cordis';

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  clearCache: vi.fn(),
  prepareSegments: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text })),
  walkLineRanges: vi.fn(),
  materializeLineRange: vi.fn(() => ({ width: 100, text: 'mock' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
  watchFileDragDrop: vi.fn(async () => () => {}),
}));

import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { overlayServicePlugin } from '../src/composition/overlay-service';
import { DraftPaperContext, PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerSheet } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { DraftFolioSurface } from '../src/plugins/builtin/compose-dock/DraftFolioSurface';
import { DraftFolioLine } from '../src/plugins/builtin/paper-shell/DraftFolioLine';
import { loadSettings } from '../src/settings';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { useModeStore } from '../src/state/mode-store';
import { usePresetStore } from '../src/state/preset-store';
import { getChatStore } from '../src/ui/chat-store';

const PANEL = 'folio-per-paper';

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    registerComposer: vi.fn(),
    builtinCommands: () => [],
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = { activeSessionId: '1', flyToPoint: vi.fn() };

/** 一行里的可读面（组合 / 模型 / 权限 三笔的显示值）。 */
function rowText(row: Element | null): string {
  return (row?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('题签行 · 每张纸显示自己的三笔（2026-11-29）', () => {
  let root: Root | null = null;
  let fiber: { dispose: () => Promise<void> } | null = null;
  let container: HTMLDivElement;
  let paperA = '';
  let paperB = '';

  beforeEach(async () => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    useDraftSheetStore.getState().dismissAll();
    usePresetStore.setState({ selected: 'standard', error: null });
    useModeStore.setState({
      permissionMode: 'ask',
      sheetPermission: null,
      sessionModes: {},
      pendingYolo: false,
      pendingYoloPaper: null,
    });
    useCoreStore.getState().setChatCore(fakeCore(PANEL));
    getChatStore(PANEL).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    /* 覆盖层贡献 = 生产那一份（compose-dock 注册的 'draft-folio'） */
    const ctx = new Context();
    fiber = ctx.plugin(overlayServicePlugin);
    await fiber;
    ctx.overlays.register({ id: 'draft-folio', slot: 'draft-folio', component: DraftFolioSurface });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    await fiber?.dispose();
    fiber = null;
    useDraftSheetStore.getState().dismissAll();
  });

  /** 两张纸 + 各挂一行；题签各写各的（三笔全不同）。 */
  async function openTwoPapers() {
    await act(async () => {
      paperA = useDraftSheetStore.getState().openSheet();
      paperB = useDraftSheetStore.getState().openSheet();
      const st = useDraftSheetStore.getState();
      st.setPicks(
        { presetId: 'minimal', providerName: 'deepseek', model: 'model-a', thinking: 'high', permission: 'auto' },
        paperA,
      );
      st.setPicks(
        { presetId: 'standard', providerName: 'deepseek', model: 'model-b', thinking: 'low', permission: 'ask' },
        paperB,
      );
    });
    await act(async () => {
      root = createRoot(container);
      /* 结构与 DraftSheet 同形：天头那一行（DraftFolioLine）+ 天头之下的输入面栈。
       * 两处都由宿主下发 `DraftPaperContext`（生产里由 DraftSheet 提供）。 */
      root.render(
        <PaperDockContext.Provider value={DOCK_CONTEXT}>
          {[paperA, paperB].map((pid) => (
            <div key={pid} data-row={pid}>
              <DraftPaperContext.Provider value={pid}>
                <DraftFolioLine paperId={pid} />
                <ComposerSheet />
              </DraftPaperContext.Provider>
            </div>
          ))}
        </PaperDockContext.Provider>,
      );
    });
  }

  const row = (paperId: string) => container.querySelector(`[data-row="${paperId}"] .pp-folio-picks`);

  const picksOf = (paperId: string) =>
    useDraftSheetStore.getState().papers.find((p) => p.id === paperId)?.picks ?? null;

  it('两张纸的行各显示自己的组合 / 模型 / 思考 / 权限（焦点在第二张）', async () => {
    await openTwoPapers();
    expect(useDraftSheetStore.getState().focusedId, '焦点在最后摊开的那张').toBe(paperB);

    const a = rowText(row(paperA));
    const b = rowText(row(paperB));
    expect(a).toContain('minimal');
    expect(a).toContain('model-a');
    expect(a).toContain('半放');
    expect(a).not.toContain('model-b');

    expect(b).toContain('standard');
    expect(b).toContain('model-b');
    expect(b).toContain('常询');
    expect(b).not.toContain('model-a');

    /* 来源记号（2026-11-30）：B 的组合就是全局默认 ⇒ 标「默认」；A 的组合是本卷自己定的
     * ⇒ 不标。用户据此能分清「这一卷定的」与「跟着默认的」——「我选了它却没记住」的那
     * 一半误读就此消失。 */
    expect(b).toContain('默认');
    expect(a).not.toContain('默认');
  });

  it('拨一下之后来源记号消失（那一格从「跟默认」变成「本卷的」）', async () => {
    await openTwoPapers();
    expect(rowText(row(paperB))).toContain('默认');
    const signBtn = [...(row(paperB)?.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-btn') ?? [])].find((b) =>
      b.textContent?.includes('组合'),
    );
    await act(async () => signBtn?.click());
    const opt = [...(row(paperB)?.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-opt') ?? [])].find(
      (o) => o.textContent === 'minimal',
    );
    await act(async () => opt?.click());
    expect(picksOf(paperB)?.presetId).toBe('minimal');
    expect(rowText(row(paperB))).not.toContain('默认');
  });

  it('焦点交回画布（没有任何纸拿焦点）时，两张行仍是各自的值', async () => {
    await openTwoPapers();
    await act(async () => {
      useDraftSheetStore.getState().focusSheet(null);
    });
    expect(useDraftSheetStore.getState().focusedId).toBeNull();
    expect(rowText(row(paperA))).toContain('model-a');
    expect(rowText(row(paperB))).toContain('model-b');
  });

  it('在**非焦点那张**上拨权限：写它自己的题签，并记成下一张纸的出厂值', async () => {
    await openTwoPapers();
    // 焦点先放到 B（A 变成非焦点那张）
    await act(async () => {
      useDraftSheetStore.getState().focusSheet(paperB);
    });
    const permBtnA = [...(row(paperA)?.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-btn') ?? [])].find((b) =>
      b.textContent?.includes('权限'),
    );
    await act(async () => permBtnA?.click());
    const opt = [...(row(paperA)?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])].find(
      (o) => o.textContent === '常询',
    );
    await act(async () => opt?.click());

    expect(picksOf(paperA)?.permission, '写的是 A 自己').toBe('ask');
    expect(picksOf(paperB)?.permission, 'B 一个字没动').toBe('ask');
    expect(useModeStore.getState().sheetPermission, '下一张纸的出厂值跟着同一笔').toBe('ask');
    expect(useModeStore.getState().permissionMode, '工作区默认不许被顺手改').toBe('ask');
    expect(loadSettings().agent.sheetPermissionMode, '出厂值要落盘').toBe('ask');
  });

  /* ⚠ 全放走的是**确认模态**（落账归渲染模态的那位 = 纸期输入面）。这条钉三件事：
   *   ① 那一笔也记「下一张纸的出厂值」（2026-11-29 前从不落盘——全放用户因此永远记不住）；
   *   ② 落账目标是**请求它的那张纸**，不是「此刻焦点那张」；
   *   ③ 模态只由请求者那张纸渲染（多纸同屏不该叠 N 个确认框）。 */
  it('全放确认：落到请求它的那张纸，并记住出厂权限', async () => {
    await openTwoPapers();
    const openPerm = async (pid: string) => {
      const btn = [...(row(pid)?.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-btn') ?? [])].find((b) =>
        b.textContent?.includes('权限'),
      );
      await act(async () => btn?.click());
    };
    /* A 先回到「跟随工作区」，再选全放（这样才走确认这条路径） */
    await openPerm(paperA);
    const inherit = [...(row(paperA)?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])].find((o) =>
      o.textContent?.startsWith('跟随工作区'),
    );
    await act(async () => inherit?.click());
    await openPerm(paperA);
    const yolo = [...(row(paperA)?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])].find(
      (o) => o.textContent === '全放',
    );
    await act(async () => yolo?.click());

    expect(useModeStore.getState().pendingYolo, '只弹确认').toBe(true);
    expect(useModeStore.getState().pendingYoloPaper, '请求者记名 = A').toBe(paperA);
    expect(picksOf(paperA)?.permission, '确认之前题签一个字没改').toBeNull();
    /* 多纸：确认框只出一只（请求者那张纸的输入面渲染的） */
    expect(document.querySelectorAll('[role="dialog"][aria-label="确认全放模式"]')).toHaveLength(1);

    /* 焦点挪到 B 再确认：那一笔仍要落回请求者 A（旧实现落「此刻焦点那张」） */
    await act(async () => {
      useDraftSheetStore.getState().focusSheet(paperB);
    });
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.pp-mode-dialog-actions button')].find(
      (b) => b.textContent === '确定',
    );
    expect(confirm, '确认按钮在').toBeDefined();
    await act(async () => confirm?.click());

    expect(picksOf(paperA)?.permission, 'A 拿到全放').toBe('yolo');
    expect(picksOf(paperB)?.permission, 'B 一个字没动').toBe('ask');
    expect(useModeStore.getState().sheetPermission, '出厂值 = 全放（下一张纸预填它）').toBe('yolo');
    expect(loadSettings().agent.sheetPermissionMode, '出厂值要落盘（重启后还在）').toBe('yolo');
    expect(loadSettings().agent.permissionMode ?? 'ask', '工作区默认没被写').toBe('ask');
    expect(useModeStore.getState().pendingYolo, '确认完模态收起').toBe(false);
    expect(document.querySelector('[aria-label="确认全放模式"]')).toBeNull();
  });
});
