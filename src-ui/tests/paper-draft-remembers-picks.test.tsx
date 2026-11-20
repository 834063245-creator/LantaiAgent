// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 题签三笔**要能记住**（2026-11-19 用户问：「每次新建会话都要手动设置一遍？」）。
//
// 语义分层（本文件钉的就是这条）：
//   · 题签拨的那一笔 = **这一卷**的选择（开卷时落卷级覆盖 / 卷级组合登记）；
//   · 同一笔同时落进「下一张纸的出厂值」——不落，用户每开一张新纸都要重设一遍；
//   · **权限那一格不进工作区默认**：在纸上拨只是给自己留记号，顺手改默认会让所有
//     未覆盖的卷一起变（那是另一个语义，用户没要求过）。
//
// 三笔各自的记忆位（不共用一个快照，故分开钉）：
//   组合 → preset-store.selected（selectPreset 落盘 settings.composition）
//   模型/思考 → 新卷出生默认（compose-store 的 setGlobalModel / setGlobalThinking）
//   权限 → 待题纸出厂权限（mode-store.sheetPermission）

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  clearCache: vi.fn(),
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

import './helpers/kernel-registry';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { DraftFolioSurface } from '../src/plugins/builtin/compose-dock/DraftFolioSurface';
import { loadSettings } from '../src/settings';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { useModeStore } from '../src/state/mode-store';
import { usePresetStore } from '../src/state/preset-store';
import { getChatStore } from '../src/ui/chat-store';

const PANEL = 'folio-remember';

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

describe('题签三笔：这一卷归题签，下一张纸归记忆', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let paperId = '';

  beforeEach(() => {
    localStorage.clear();
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
    getChatStore(PANEL).input.getState().setInputText('');
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    useDraftSheetStore.getState().dismissAll();
  });

  async function open() {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <PaperDockContext.Provider value={DOCK_CONTEXT}>
          <DraftFolioSurface />
        </PaperDockContext.Provider>,
      );
    });
    await act(async () => {
      paperId = useDraftSheetStore.getState().openSheet();
      useDraftSheetStore
        .getState()
        .setPicks({ presetId: null, providerName: '', model: 'm', thinking: undefined, permission: null }, paperId);
    });
  }

  const picks = () => useDraftSheetStore.getState().papers.find((p) => p.id === paperId)?.picks ?? null;

  it('组合：题签记这一卷，同时记成新卷默认（下一张纸预填它）', async () => {
    /* 组合解析要能寻址 plugin 行（minimal 禁用 browser-desktop-domain 的 tools）——
     * 贡献行在册才可寻址，故整段在**通道腰**里跑（同 composition-preset-assembly 的做法）。 */
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        await open();
        const signBtn = [...container.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-btn')].find((b) =>
          b.textContent?.includes('组合'),
        );
        await act(async () => signBtn?.click());
        const target = usePresetStore.getState().roster.find((p) => p.id === 'minimal' && p.patch !== null);
        expect(target, 'minimal 应在出厂名册里').toBeDefined();
        const opt = [...container.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-opt')].find(
          (o) => o.textContent === 'minimal',
        );
        await act(async () => opt?.click());

        expect(picks()?.presetId, '这一卷 = 题签记的值').toBe('minimal');
        expect(usePresetStore.getState().selected, '新卷默认 = 同一笔（下次开纸预填它）').toBe('minimal');
        expect(loadSettings().composition?.preset, '默认要落盘，重启后还在').toBe('minimal');
      }),
    );
  });

  it('权限：题签记这一卷，同时记成**待题纸出厂值**（工作区默认不动）', async () => {
    await open();
    const permBtn = [...container.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-btn')].find((b) =>
      b.textContent?.includes('权限'),
    );
    await act(async () => permBtn?.click());
    const modeOpt = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (o) => o.textContent === '半放',
    );
    await act(async () => modeOpt?.click());

    expect(picks()?.permission, '这一卷 = 题签那一格').toBe('auto');
    expect(useModeStore.getState().sheetPermission, '下一张纸的出厂值 = 同一笔').toBe('auto');
    expect(useModeStore.getState().permissionMode, '工作区默认**不许**被顺手改（那是另一个语义）').toBe('ask');
    expect(loadSettings().agent.sheetPermissionMode, '出厂值要落盘').toBe('auto');
    expect(loadSettings().agent.permissionMode ?? 'ask', '工作区默认没被写').toBe('ask');
  });

  it('「跟随工作区」也是一次显式选择：出厂值清回 null（下次开纸不再预填）', async () => {
    useModeStore.setState({ sheetPermission: 'auto' });
    await open();
    const permBtn = [...container.querySelectorAll<HTMLButtonElement>('.pp-folio-pick-btn')].find((b) =>
      b.textContent?.includes('权限'),
    );
    await act(async () => permBtn?.click());
    const inherit = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((o) =>
      o.textContent?.startsWith('跟随工作区'),
    );
    await act(async () => inherit?.click());
    expect(picks()?.permission).toBeNull();
    expect(useModeStore.getState().sheetPermission).toBeNull();
  });
});
