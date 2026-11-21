// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 题签的**模型 / 思考**要能记住（2026-11-19 用户问「每次新建会话都要手动设置一遍？」）。
//
// 语义分层：题签拨的那一笔 = **这一卷**（开卷时落会话覆盖）；同一笔同时落成
// 「新卷出生默认」——否则每开一张新纸都要重选一遍模型与档位。
// 本文件挂真组件（hooks 必须跑在 React 里），打的是纸期输入面同一个 hook 的写入口。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { DraftPaperContext, PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { DraftFolioSurface } from '../src/plugins/builtin/compose-dock/DraftFolioSurface';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests, resolveNewSessionDefault } from '../src/state/compose-store';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { useModeStore } from '../src/state/mode-store';
import { usePresetStore } from '../src/state/preset-store';
import { getChatStore } from '../src/ui/chat-store';

const PANEL = 'folio-remembers-models';
const DOCK_CONTEXT: PaperDockContextValue = { activeSessionId: '1', flyToPoint: vi.fn() };

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

describe('题签 · 模型 / 思考被记住为新卷出生默认', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let paperId = '';

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    useDraftSheetStore.getState().dismissAll();
    usePresetStore.setState({ selected: 'standard', error: null });
    useModeStore.setState({ permissionMode: 'ask', sheetPermission: null, sessionModes: {}, pendingYolo: false });
    useCoreStore.getState().setChatCore(fakeCore(PANEL));
    getChatStore(PANEL).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  const picks = () => useDraftSheetStore.getState().papers.find((p) => p.id === paperId)?.picks ?? null;

  async function open() {
    /* 2026-11-29 收口批：题签行必须知道自己挂在哪张纸上（生产由 DraftFolioLine 经
     * `DraftPaperContext` 下发）——先摊纸、再挂行，与生产的挂载顺序一致。 */
    await act(async () => {
      paperId = useDraftSheetStore.getState().openSheet();
      useDraftSheetStore
        .getState()
        .setPicks(
          { presetId: null, providerName: 'deepseek', model: 'deepseek-flash', thinking: undefined, permission: null },
          paperId,
        );
    });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <PaperDockContext.Provider value={DOCK_CONTEXT}>
          <DraftPaperContext.Provider value={paperId}>
            <DraftFolioSurface />
          </DraftPaperContext.Provider>
        </PaperDockContext.Provider>,
      );
    });
  }

  it('拨模型：题签记这一卷，同时写新卷出生默认（下一张纸预填它）', async () => {
    await open();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    /* 一级菜单 → 模型面 → 选一个不同的模型 */
    await act(async () => {
      const cell = [...container.querySelectorAll<HTMLButtonElement>('.ms-cell')].find(
        (c) => c.querySelector('.ms-cell-label')?.textContent === '模型',
      );
      cell?.click();
    });
    const row = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (o) => !o.className.includes('selected'),
    );
    const before = picks()?.model;
    await act(async () => row?.click());
    const after = picks()?.model ?? '';
    expect(after, '点到了另一个模型（否则本测什么也证明不了）').not.toBe(before);
    expect(resolveNewSessionDefault().model, '新卷默认 = 同一笔（下次开纸预填）').toBe(after);
  });

  it('选「自动」思考档：这一卷 = 零覆盖，默认 = 显式自动（不是删掉记号）', async () => {
    await open();
    await act(async () => container.querySelector<HTMLButtonElement>('.ms-trigger')?.click());
    await act(async () => {
      const cell = [...container.querySelectorAll<HTMLButtonElement>('.ms-cell')].find(
        (c) => c.querySelector('.ms-cell-label')?.textContent === '思考',
      );
      cell?.click();
    });
    const auto = [...container.querySelectorAll<HTMLButtonElement>('.ms-think-item')].find((o) =>
      (o.textContent ?? '').includes('自动'),
    );
    await act(async () => auto?.click());
    expect(picks()?.thinking, '这一卷：自动 = 零覆盖').toBeUndefined();
    /* ⚡ 2026-11-21 思考档位收口：没有「默认档位」可落盘了——无主态/下一张纸的档位
     * 只记在本进程内存里（显式 '' = 自动）。 */
    expect(resolveNewSessionDefault().thinking, '默认侧记显式自动（内存）').toBe('');
  });
});
