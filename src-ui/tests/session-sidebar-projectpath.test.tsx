// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// rework P4-1：SessionSidebar 在 projectPath 变化（进工作区/切换）时必须重拉
// listSavedSessions——首拉若早于路径落定会拉到空集且无重试点。本测试钉住
// 「useShellStore 订阅 → 路径变化 → 重新拉取并更新行」。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { SessionSidebar } from '../src/plugins/builtin/canvas-nav/SessionSidebar';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { getChatStore } from '../src/ui/chat-store';

function fakeCore(panelId: string, saved: Array<{ id: number; label: string; msgCount: number; savedAt: string }>) {
  const listSavedSessions = vi.fn(async (_pp: string) => saved);
  const core = {
    panelId,
    listSavedSessions,
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    renameSavedSession: vi.fn(),
    closeSession: vi.fn(),
    deleteSessionFile: vi.fn(),
  } as unknown as ChatCore;
  return { core, listSavedSessions };
}

describe('SessionSidebar 返工 P4-1（projectPath 变化重拉）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let panelId: string;

  beforeEach(() => {
    panelId = `test-sidebar-${Math.random().toString(36).slice(2)}`;
    resetCanvasStoresForTests();
    useShellStore.getState().setProjectPath('');
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  it('projectPath 变化 → 用新路径重拉 listSavedSessions 并更新行', async () => {
    const { core, listSavedSessions } = fakeCore(panelId, [
      { id: 2, label: '盘卷甲', msgCount: 3, savedAt: '2026-08-26T00:00:00Z' },
    ]);
    useCoreStore.getState().setChatCore(core);
    getChatStore(panelId).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });

    act(() => {
      root = createRoot(container);
      root.render(createElement(SessionSidebar));
    });
    await act(async () => {});
    // 首拉用当前 projectPath（''）
    expect(listSavedSessions).toHaveBeenCalledWith('');
    // 初始行 = 摊开 1 + 未摊开盘卷 1
    expect(container.querySelectorAll('.ss-row').length).toBe(2);

    // 切换工作区路径 → 应重拉（P4-1 修复点）
    listSavedSessions.mockResolvedValueOnce([{ id: 5, label: '盘卷乙', msgCount: 9, savedAt: '2026-08-26T01:00:00Z' }]);
    act(() => {
      useShellStore.getState().setProjectPath('D:/proj/rework');
    });
    await act(async () => {});
    expect(listSavedSessions).toHaveBeenCalledWith('D:/proj/rework');
    const labels = [...container.querySelectorAll('.ss-label')].map((e) => e.textContent);
    expect(labels).toContain('盘卷乙');
  });
});
