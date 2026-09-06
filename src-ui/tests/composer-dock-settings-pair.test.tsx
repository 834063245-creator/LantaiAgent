// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞设置行行内排布钉（2026-09-06 续批二）：模型独居左端，权限+思考成对
// 靠右（组内权限在左、思考收尾）——两件同属「运行策略」成对归堆，不与模型混排。
// 直接合并成单控件暂缓（权限=工作区级 mode-store、思考=每会话 compose-store，
// 两真相源硬合会搅浑状态归属）。本文件钉行内 DOM 序防回退。

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

describe('创作坞设置行行内排布（2026-09-06 续批二：模型居左，权限+思考成对靠右）', () => {
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

  it('模型居左端、权限+思考成对靠右：子序 = 模型 → spacer → 权限 → 思考', async () => {
    await mountDock('settings-pair');
    const settings = container.querySelector('.pp-composer-settings')!;
    const classes = [...settings.children].map((el) => el.className);
    expect(classes[0]).toContain('ms-container'); // 模型独居左端
    const msIdx = classes.findIndex((c) => c.includes('ms-container'));
    const spacerIdx = classes.indexOf('pp-composer-settings-spacer');
    const permIdx = classes.findIndex((c) => c.includes('pp-mode-seg'));
    const thinkIdx = classes.findIndex((c) => c.includes('pp-thinking-sel'));
    expect(msIdx).toBe(0);
    expect(spacerIdx).toBe(msIdx + 1); // 模型与策略对之间隔 spacer——成对被推右
    expect(permIdx).toBe(spacerIdx + 1);
    expect(thinkIdx).toBe(permIdx + 1); // 思考收尾；权限在组内左侧
    expect(thinkIdx).toBe(classes.length - 1); // 权限+思考靠行尾
  });

  it('策略对成员相邻无模型插入：权限与思考之间不隔其它控件', async () => {
    await mountDock('settings-pair-adjacent');
    const settings = container.querySelector('.pp-composer-settings')!;
    const children = [...settings.children].map((el) => el.className);
    const permIdx = children.findIndex((c) => c.includes('pp-mode-seg'));
    const thinkIdx = children.findIndex((c) => c.includes('pp-thinking-sel'));
    expect(thinkIdx - permIdx).toBe(1); // 成对相邻
  });
});
