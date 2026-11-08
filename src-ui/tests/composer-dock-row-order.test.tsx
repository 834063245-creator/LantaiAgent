// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞行序收口（2026-09-06）：模型/权限/思考强度不再占坞顶行——设置行
// （pp-composer-settings）下沉到输入行（pp-composer-row）之下的「下方一行」
// 2026-11-08 规格变更（丙案两行制）：设置行**整行退役**——模型（含档位后缀）回书眉行，
// 权限/组合/造模式/图版/律 收进「案」抽屉。本文件钉的是新的归属面。
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

  it('两行制：书眉行在下沉项之前、设置行整行不存在（2026-11-08 丙案）', async () => {
    await mountDock('row-order');
    const dock = container.querySelector('.pp-composer')!;
    expect(dock).not.toBeNull();
    const classes = [...dock.children].map((el) => el.className);
    const headerIdx = classes.indexOf('pp-composer-header');
    const rowIdx = classes.indexOf('pp-composer-row');
    expect(headerIdx).toBe(0); // 书眉恒居顶
    expect(rowIdx).toBe(1); // 输入行紧跟其后 —— 两行，没有第三行
    expect(classes).not.toContain('pp-composer-settings'); // 设置行整行退役
  });

  it('控件归属（丙案）：模型+档位后缀回书眉行；权限三档进「案」抽屉，不常驻', async () => {
    await mountDock('row-order-controls');
    const header = container.querySelector('.pp-composer-header')!;
    // 模型（含档位后缀）现在是书眉级身份件——「本卷拿什么跑」与卷名同级
    expect(header.querySelector('.ms-trigger')).not.toBeNull();
    expect(header.querySelector('.ms-trigger-thinking')).not.toBeNull();
    expect(header.querySelector('.pp-thinking-pill')).toBeNull();
    expect(header.querySelector('.pp-thinking-sel')).toBeNull();
    // 权限三档不再常驻坞面：抽屉关着时整枚不存在
    expect(container.querySelector('.pp-mode-seg')).toBeNull();
    // 打开「案」→ 权限三档在抽屉里
    const schemeBtn = container.querySelector('.pp-scheme-btn') as HTMLButtonElement;
    expect(schemeBtn).not.toBeNull();
    act(() => schemeBtn.click());
    await act(async () => {});
    expect(container.querySelector('.pp-scheme-panel .pp-mode-seg')).not.toBeNull();
    // 输入行内不藏书眉件（「案」抽屉挂在输入行里，故排除抽屉子树）
    const row = container.querySelector('.pp-composer-row')!;
    expect(row.querySelector('.ms-trigger')).toBeNull();
    expect(row.querySelector(':scope > .pp-mode-seg')).toBeNull();
  });

  it('行序交换后发送钮仍在输入行内（拟文不随设置行搬动）', async () => {
    await mountDock('row-order-send');
    const row = container.querySelector('.pp-composer-row')!;
    expect(row.querySelector('.pp-send')).not.toBeNull();
  });

  it('P1 左轴：textarea 是输入行第一个布局件，引/夹在它右侧、拟文最右', async () => {
    await mountDock('row-order-axis');
    const row = container.querySelector('.pp-composer-row')!;
    const kids = [...row.children];
    const taIdx = kids.indexOf(row.querySelector('textarea')!);
    const yinIdx = kids.indexOf(row.querySelector('.pp-yin-btn')!);
    const sendIdx = kids.indexOf(row.querySelector('.pp-send')!);
    expect(taIdx).toBe(0); // 正文与书眉卷名/设置行同一条左缘
    expect(yinIdx).toBeGreaterThan(taIdx);
    expect(sendIdx).toBeGreaterThan(yinIdx);
  });
});
