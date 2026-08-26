// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞返工（P2-2/P2-3）组件测试：
// - P2-2 思考档位收起态显示「思考 · 当前档」；展开为纯中文分段控件；
// - P2-3 权限三档分段控件；点全放弹出居中模态，确定后切到 yolo。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { ComposerDock } from '../src/app/panels/ComposerDock';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { getComposeStore, resetComposeStoresForTests } from '../src/state/compose-store';
import { useModeStore } from '../src/state/mode-store';
import { resetPaperStoresForTests } from '../src/state/paper-store';
import { getChatStore } from '../src/ui/chat-store';

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  inputLocked: false,
  setInputLocked: vi.fn(),
  flyToPoint: vi.fn(),
};

/** 装配 core + 播种会话/创作坞偏好，并把 ComposerDock 渲染进 container。 */
async function mountDock(panelId: string, container: HTMLDivElement, onRoot: (r: Root) => void) {
  useCoreStore.getState().setChatCore(fakeCore(panelId));
  getChatStore(panelId).sess.setState({
    sessions: [{ id: 1, label: '案卷一' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
  });
  // 播种每会话偏好：deepseek-v4-pro + thinking=high
  getComposeStore(panelId).getState().ensurePrefs('1');
  getComposeStore(panelId).getState().setThinking('1', 'high');

  let root: Root;
  act(() => {
    root = createRoot(container);
    onRoot(root);
    root.render(createElement(PaperDockContext.Provider, { value: DOCK_CONTEXT }, createElement(ComposerDock)));
  });
  await act(async () => {});
}

describe('ComposerDock 返工 P2-2（思考档位）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetPaperStoresForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  it('收起态按钮显示「思考 · 高」（当前档可见，非恒「思考」）', async () => {
    await mountDock('p22-collapsed', container, (r) => {
      root = r;
    });
    const toggle = container.querySelector<HTMLButtonElement>('.pp-thinking-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain('思考 · 高');
  });

  it('展开为纯中文分段控件：选中「高」，无英文括号混排', async () => {
    await mountDock('p22-expanded', container, (r) => {
      root = r;
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('.pp-thinking-toggle')?.click();
    });
    await act(async () => {});
    const seg = container.querySelector('.pp-thinking-seg');
    expect(seg).not.toBeNull();
    const opts = [...container.querySelectorAll<HTMLButtonElement>('.pp-thinking-opt')];
    expect(opts.length).toBeGreaterThan(0);
    const selected = opts.find((b) => b.classList.contains('selected'));
    expect(selected?.textContent?.trim()).toBe('高');
    expect(seg?.textContent).not.toMatch(/\(|\)/); // 无中英混排
  });
});

describe('ComposerDock 返工 P2-3（权限分段 + 全放模态）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetPaperStoresForTests();
    useModeStore.setState({ permissionMode: 'ask', pendingYolo: false });
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  it('权限三档分段控件：常询/半放/全放，当前档选中高亮', async () => {
    await mountDock('p23-seg', container, (r) => {
      root = r;
    });
    const seg = container.querySelector('.pp-mode-seg');
    expect(seg).not.toBeNull();
    const opts = [...container.querySelectorAll<HTMLButtonElement>('.pp-mode-opt')];
    expect(opts.map((b) => b.textContent?.trim())).toEqual(['常询', '半放', '全放']);
    expect(opts[0]?.classList.contains('selected')).toBe(true);
  });

  it('点全放 → 居中模态出现；点确定 → mode-store 切到 yolo 且模态消失', async () => {
    await mountDock('p23-yolo', container, (r) => {
      root = r;
    });
    act(() => {
      const yoloBtn = [...container.querySelectorAll<HTMLButtonElement>('.pp-mode-opt')].find(
        (b) => b.textContent?.trim() === '全放',
      );
      yoloBtn?.click();
    });
    await act(async () => {});
    expect(container.querySelector('.pp-mode-dialog')).not.toBeNull();
    act(() => {
      container.querySelector<HTMLButtonElement>('.pp-mode-dialog-actions .primary')?.click();
    });
    await act(async () => {});
    expect(useModeStore.getState().permissionMode).toBe('yolo');
    expect(container.querySelector('.pp-mode-dialog')).toBeNull();
  });
});
