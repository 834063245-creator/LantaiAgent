// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞三行制书眉行钉（2026-09-06 续批）：卷名 + 翰/律（+ 后台卷指示）恒居
// 坞顶书眉行（pp-composer-header）——用户打回「整组一起下沉」的旧两行制：三控件
// （模型/权限/思考）下沉设置行，但卷名/翰/律是坞的书眉，不随迁。本文件钉顶行
// 归属面防回退。

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
  flyToPoint: vi.fn(),
};

describe('创作坞书眉行（2026-09-06 续批：卷名/翰/律恒居顶行）', () => {
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

  it('书眉行是坞的第一行：pp-composer-header 在输入行/设置行之前', async () => {
    await mountDock('header-order');
    const dock = container.querySelector('.pp-composer')!;
    const classes = [...dock.children].map((el) => el.className);
    expect(classes[0]).toBe('pp-composer-header'); // 书眉恒居顶
    const headerIdx = classes.indexOf('pp-composer-header');
    const rowIdx = classes.indexOf('pp-composer-row');
    const settingsIdx = classes.indexOf('pp-composer-settings');
    expect(rowIdx).toBeGreaterThan(headerIdx);
    expect(settingsIdx).toBeGreaterThan(rowIdx); // 三行制：书眉 → 输入 → 设置
  });

  it('卷名 + 翰/律归属书眉行；设置行/输入行不得再藏这些', async () => {
    await mountDock('header-membership');
    const header = container.querySelector('.pp-composer-header')!;
    expect(header.querySelector('.pp-composer-target')).not.toBeNull(); // 卷名回顶
    const toolBtns = header.querySelectorAll('.pp-tool-btn');
    expect(toolBtns.length).toBe(2); // 翰 + 律
    expect([...toolBtns].map((b) => b.textContent)).toEqual(['翰', '律']);
    // 两行下不得重复出现书眉件
    const settings = container.querySelector('.pp-composer-settings')!;
    const row = container.querySelector('.pp-composer-row')!;
    expect(settings.querySelector('.pp-composer-target')).toBeNull();
    expect(settings.querySelector('.pp-dock-tools')).toBeNull();
    expect(row.querySelector('.pp-composer-target')).toBeNull();
    expect(row.querySelector('.pp-dock-tools')).toBeNull();
  });

  it('律册浮层随翰律长在书眉行：从顶行打开（不随设置行搬动）', async () => {
    await mountDock('header-help-sheet');
    const header = container.querySelector('.pp-composer-header')!;
    const lüBtn = [...header.querySelectorAll<HTMLButtonElement>('.pp-tool-btn')].find((b) => b.textContent === '律')!;
    act(() => {
      lüBtn.click();
    });
    await act(async () => {});
    const sheet = header.querySelector('.pp-help-sheet');
    expect(sheet).not.toBeNull(); // 律册锚在书眉行内的工具对上
  });
});
