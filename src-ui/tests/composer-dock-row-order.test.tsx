// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞行序收口（2026-09-06）：模型/权限/思考强度不再占坞顶行——设置行
// （pp-composer-settings）下沉到输入行（pp-composer-row）之下的「下方一行」
// （DSH InputBar 同款排布：输入面在上、控件行在下）。本文件钉 DOM 行序与
// 三控件归属面，防后续回退到顶行形态。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { getChatStore } from '../src/ui/chat-store';

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    registerComposer: vi.fn(),
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  inputLocked: false,
  setInputLocked: vi.fn(),
  flyToPoint: vi.fn(),
};

describe('创作坞行序（2026-09-06 收口：设置行下沉到输入行之下）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  const mountDock = async (panelId: string) => {
    useCoreStore.getState().setChatCore(fakeCore(panelId));
    getChatStore(panelId).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    getChatStore(panelId).input.getState().setInputText('');
    act(() => {
      root = createRoot(container);
      root.render(createElement(PaperDockContext.Provider, { value: DOCK_CONTEXT }, createElement(ComposerDock)));
    });
    await act(async () => {});
  };

  it('输入行在设置行之前——模型/权限/思考落位「下方一行」，不占坞顶行', async () => {
    await mountDock('row-order');
    const dock = container.querySelector('.pp-composer')!;
    expect(dock).not.toBeNull();
    const classes = [...dock.children].map((el) => el.className);
    const rowIdx = classes.indexOf('pp-composer-row');
    const settingsIdx = classes.indexOf('pp-composer-settings');
    expect(rowIdx).toBeGreaterThanOrEqual(0);
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    expect(rowIdx).toBeLessThan(settingsIdx); // 输入行在上，设置行在下
  });

  it('三控件归属设置行：模型触发器 / 权限三档 / 思考 pill 都在 .pp-composer-settings 内', async () => {
    await mountDock('row-order-controls');
    const settings = container.querySelector('.pp-composer-settings')!;
    expect(settings.querySelector('.ms-trigger')).not.toBeNull(); // 模型
    expect(settings.querySelector('.pp-mode-seg')).not.toBeNull(); // 权限
    expect(settings.querySelector('.pp-thinking-pill')).not.toBeNull(); // 思考强度
    // 输入行内不得再藏设置件
    const row = container.querySelector('.pp-composer-row')!;
    expect(row.querySelector('.ms-trigger')).toBeNull();
    expect(row.querySelector('.pp-mode-seg')).toBeNull();
    expect(row.querySelector('.pp-thinking-pill')).toBeNull();
  });

  it('行序交换后发送钮仍在输入行内（拟文不随设置行搬动）', async () => {
    await mountDock('row-order-send');
    const row = container.querySelector('.pp-composer-row')!;
    expect(row.querySelector('.pp-send')).not.toBeNull();
  });
});
