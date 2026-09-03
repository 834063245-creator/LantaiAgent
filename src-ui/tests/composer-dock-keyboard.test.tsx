// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞键盘行为组件测试（D5 2026-08-27 补欠——此前只有 navigateHistory 纯函数
// 7 用例，ComposerDock 的 ↑↓ 事件处理与斜杠键盘导航没有组件级覆盖）：
// - ↑↓ 输入历史浏览：进入存草稿 / ↑ 回退 / ↓ 前进 / 越过最新恢复草稿 / 手输退出浏览；
// - 斜杠命令面板键盘导航：↑↓ 选（active 高亮）/ Enter 执行 / Esc 关（去触发词）。

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
import { type CommandDef, CommandRegistry } from '../src/ui/command-registry';

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    registerComposer: vi.fn(),
    executeCommand: vi.fn(),
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  inputLocked: false,
  setInputLocked: vi.fn(),
  flyToPoint: vi.fn(),
};

interface InputSeed {
  inputText?: string;
  inputHistory?: string[];
  inputHistoryIdx?: number;
  draftText?: string;
}

/** 装配 core + 播种会话/输入 store，并把 ComposerDock 渲染进 container。返回 fake core。 */
async function mountDock(
  panelId: string,
  container: HTMLDivElement,
  seed: InputSeed,
  onRoot: (r: Root) => void,
): Promise<ChatCore> {
  const core = fakeCore(panelId);
  useCoreStore.getState().setChatCore(core);
  getChatStore(panelId).sess.setState({
    sessions: [{ id: 1, label: '案卷一' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
  });
  getChatStore(panelId).input.setState({
    inputText: seed.inputText ?? '',
    inputHistory: seed.inputHistory ?? [],
    inputHistoryIdx: seed.inputHistoryIdx ?? -1,
    draftText: seed.draftText ?? '',
  });
  let root: Root;
  act(() => {
    root = createRoot(container);
    onRoot(root);
    root.render(createElement(PaperDockContext.Provider, { value: DOCK_CONTEXT }, createElement(ComposerDock)));
  });
  await act(async () => {});
  return core;
}

/** 在 textarea 上触发 keydown（React 合成事件；isComposing 默认 false = 非 IME）。 */
function keyOn(ta: HTMLTextAreaElement, key: string, shiftKey = false): void {
  act(() => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  });
}

describe('ComposerDock 输入历史键盘导航（↑↓）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    // jsdom rAF 时序不稳——同步执行 selection 回调，保证 act 内完成
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    vi.unstubAllGlobals();
  });

  it('↑ 回退 / ↓ 前进 / 越过最新恢复草稿', async () => {
    await mountDock(
      'hist-nav',
      container,
      { inputText: 'draft', inputHistory: ['first', 'second'], inputHistoryIdx: -1 },
      (r) => {
        root = r;
      },
    );
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
    expect(ta).not.toBeNull();

    // 进入历史：↑ 一次 → 最近一条 + 把当前草稿存进 draftText 槽
    keyOn(ta!, 'ArrowUp');
    await act(async () => {});
    expect(ta!.value).toBe('second');
    expect(getChatStore('hist-nav').input.getState().inputHistoryIdx).toBe(1);
    expect(getChatStore('hist-nav').input.getState().draftText).toBe('draft');

    // ↑ 再按 → 更早一条
    keyOn(ta!, 'ArrowUp');
    await act(async () => {});
    expect(ta!.value).toBe('first');
    expect(getChatStore('hist-nav').input.getState().inputHistoryIdx).toBe(0);

    // ↓ → 前进
    keyOn(ta!, 'ArrowDown');
    await act(async () => {});
    expect(ta!.value).toBe('second');

    // ↓ 越过最新一条 → 恢复进入时的草稿 + 退出浏览
    keyOn(ta!, 'ArrowDown');
    await act(async () => {});
    expect(ta!.value).toBe('draft');
    expect(getChatStore('hist-nav').input.getState().inputHistoryIdx).toBe(-1);
  });

  it('手输 = 退出历史浏览（inputHistoryIdx 复位 -1）', async () => {
    await mountDock(
      'hist-type',
      container,
      { inputText: 'draft', inputHistory: ['first', 'second'], inputHistoryIdx: -1 },
      (r) => {
        root = r;
      },
    );
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
    keyOn(ta!, 'ArrowUp');
    await act(async () => {});
    expect(getChatStore('hist-type').input.getState().inputHistoryIdx).toBe(1);

    // 手输：原生 value setter（绕 React 值追踪）+ input 事件触发 React onChange
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(ta!, 'typed');
      ta!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
    expect(getChatStore('hist-type').input.getState().inputHistoryIdx).toBe(-1);
  });

  it('空历史：↑ 不越界（输入内容不动）', async () => {
    await mountDock('hist-empty', container, { inputText: 'draft', inputHistory: [], inputHistoryIdx: -1 }, (r) => {
      root = r;
    });
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
    keyOn(ta!, 'ArrowUp');
    await act(async () => {});
    expect(ta!.value).toBe('draft');
    expect(getChatStore('hist-empty').input.getState().inputHistoryIdx).toBe(-1);
  });
});

describe('ComposerDock 斜杠命令键盘导航', () => {
  const SLASH_CMDS: CommandDef[] = [
    {
      id: 'alpha',
      label: 'Alpha 命令',
      description: '测试 alpha',
      group: '案卷',
      shortcut: '/alpha',
      action: { type: 'fill', text: '/alpha ' },
    },
    {
      id: 'beta',
      label: 'Beta 命令',
      description: '测试 beta',
      group: '案卷',
      shortcut: '/beta',
      action: { type: 'fill', text: '/beta ' },
    },
  ];
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    CommandRegistry.instance.registerAll(SLASH_CMDS); // registerAll 按 id 去重，可重复调用
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    vi.unstubAllGlobals();
  });

  it('输入 / 弹出面板：↑↓ 移动高亮，Enter 执行当前命令（非发送）', async () => {
    const core = await mountDock('slash-nav', container, { inputText: '/' }, (r) => {
      root = r;
    });
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
    expect(container.querySelector('.pp-slash')).not.toBeNull();
    let items = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
    expect(items.length).toBe(2);
    expect(items[0].classList.contains('active')).toBe(true);

    // ↓ → 高亮第二个
    keyOn(ta!, 'ArrowDown');
    await act(async () => {});
    items = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
    expect(items[1].classList.contains('active')).toBe(true);

    // ↑ → 高亮回第一个
    keyOn(ta!, 'ArrowUp');
    await act(async () => {});
    items = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
    expect(items[0].classList.contains('active')).toBe(true);

    // Enter → 执行当前（第一个 = alpha），不触发发送
    keyOn(ta!, 'Enter');
    expect(core.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'alpha' }));
    expect(core.sendMessage).not.toHaveBeenCalled();
  });

  it('斜杠面板激活时 Shift+Enter 不执行命令也不发送（换行留给 textarea，2026-09-03）', async () => {
    const core = await mountDock('slash-shift', container, { inputText: '/' }, (r) => {
      root = r;
    });
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
    expect(container.querySelector('.pp-slash')).not.toBeNull();

    // Shift+Enter → 不执行命令、不发送、面板保持
    keyOn(ta!, 'Enter', true);
    await act(async () => {});
    expect(core.executeCommand).not.toHaveBeenCalled();
    expect(core.sendMessage).not.toHaveBeenCalled();
    expect(container.querySelector('.pp-slash')).not.toBeNull();
  });

  it('Esc 关闭斜杠面板并去掉触发词', async () => {
    await mountDock('slash-esc', container, { inputText: '/al' }, (r) => {
      root = r;
    });
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
    expect(container.querySelector('.pp-slash')).not.toBeNull();
    keyOn(ta!, 'Escape');
    await act(async () => {});
    expect(container.querySelector('.pp-slash')).toBeNull();
    // 面板散 = 保留已输入查询词，去掉行首斜杠触发词
    expect(getChatStore('slash-esc').input.getState().inputText).toBe('al');
  });
});
