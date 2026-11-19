// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 拟文印的**可点判据**（2026-11-19 用户真机报：只附截图、不写字 → 拟文是死的）。
//
// 旧判据 `inputText.trim()` 把「输入」窄化成了「正文」；附图道 / 路径附件里明明有东西，
// 按钮还是灰的。本环钉住三件：附图可发、附件可发、真空才不发（含 tooltip 的指向）。
// harness 镜像 composer-dock-image-paste.test.tsx（fakeCore + mountDock）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import type { ChatImageRef } from '../src/provider/types';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { getComposeStore, resetComposeStoresForTests } from '../src/state/compose-store';
import { useToastStore } from '../src/state/toast-store';
import { getChatStore } from '../src/ui/chat-store';

const IMG: ChatImageRef = {
  id: 'btn-img',
  mediaType: 'image/png',
  bytes: 2048,
  width: 16,
  height: 16,
  name: 'shot.png',
};

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    attachIntakePaths: vi.fn(),
    intakeImageFiles: vi.fn(),
    intakeImagePaths: vi.fn(),
    registerComposer: vi.fn(),
    executeCommand: vi.fn(),
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  flyToPoint: vi.fn(),
};

async function mountDock(container: HTMLDivElement): Promise<ChatCore> {
  const core = fakeCore(`send-img-test-${Date.now()}`);
  useCoreStore.getState().setChatCore(core);
  getChatStore(core.panelId).sess.setState({
    sessions: [{ id: 1, label: '案卷一' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
  });
  getComposeStore(core.panelId).setState({
    sessions: { '1': { providerName: 'p', model: 'vision-x', thinking: '' } },
  });
  act(() => {
    const root = createRoot(container);
    root.render(createElement(PaperDockContext.Provider, { value: DOCK_CONTEXT }, createElement(ComposerDock)));
  });
  await act(async () => {});
  return core;
}

const sendBtn = (container: HTMLElement) => container.querySelector('.pp-send') as HTMLButtonElement | null;

describe('拟文印可点判据：正文 / 附件 / 附图任一在场即可发', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    localStorage.removeItem('hologram_settings');
  });

  it('只有附图、正文为空：拟文可点，点了真的走 sendMessage', async () => {
    const core = await mountDock(container);
    const input = getChatStore(core.panelId).input;
    act(() => {
      input.getState().addAttachedImage(IMG);
    });
    const btn = sendBtn(container);
    expect(btn, '拟文印没渲染').not.toBeNull();
    expect(btn?.disabled, '只有附图时拟文仍是死键').toBe(false);
    act(() => {
      btn?.click();
    });
    expect(core.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('只有路径附件、正文为空：拟文可点', async () => {
    const core = await mountDock(container);
    const input = getChatStore(core.panelId).input;
    act(() => {
      input.getState().addAttachedFile({ path: 'D:/ws/a.txt', name: 'a.txt', size: 0 });
    });
    expect(sendBtn(container)?.disabled).toBe(false);
  });

  it('守门：什么都没有时拟文不可点，提示指向「先落笔」', async () => {
    await mountDock(container);
    const btn = sendBtn(container);
    expect(btn?.disabled).toBe(true);
    expect(btn?.getAttribute('data-tip')).toBe('先落笔');
  });
});
