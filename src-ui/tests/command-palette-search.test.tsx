// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 全局搜索（Ctrl+K，2026-11-28 由命令面板升级）——**取数纪律与四组行为**的行为面钉子。
//
// 钉的是「用户看得见 / 感觉得到」的那几条（设计依据 = docs/plans/global-search-plan.md）：
//   ① 空查询零成本：不读卷表、不扫文件（打开面板不许卡）；
//   ② 卷表在首次**非空**查询读一次，读出来按名字/卷号命中；
//   ③ 文件扫描要查询 ≥2 字；**没有活跃卷时文件行不可用并写明原因**（不是悄悄消失）；
//   ④ 每组有上限（卷 5）——面板不许滚成瀑布；
//   ⑤ 卷行动作：已摊开 = 切过去（switchSession）；未摊开 = 走空间命令（此处 activeSpace
//      缺席，只钉「不炸」——摊开手势本身由 space-service 自己的测试负责）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

/** 文件扫描面（与坞内「引」同一个 kernel 调用）——本测只关心「什么时候被调、调几次」。 */
const listDirMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock('../src/rpc-contract', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/rpc-contract')>();
  return { ...mod, kernelListDirectory: listDirMock };
});

import { CommandPalette } from '../src/app/CommandPalette';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useShellStore } from '../src/app/shell-store';
import { shellRefs } from '../src/shell/runtime';
import { getChatStore } from '../src/ui/chat-store';

const PANEL_ID = 'pal-search-test';

const listSavedSessions = vi.fn();
const attachIntakePaths = vi.fn(async () => {});
const switchSession = vi.fn();

function fakePanel(): ChatCore {
  return {
    panelId: PANEL_ID,
    builtinCommands: () => [
      { id: 'goal', label: '自主目标', group: '案卷', slash: '/goal', action: { type: 'local', handler: () => {} } },
    ],
    executeCommand: vi.fn(),
    prepareCommand: vi.fn(),
    listSavedSessions,
    attachIntakePaths,
    switchSession,
  } as unknown as ChatCore;
}

function rowLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.pal-row')].map((el) => el.querySelector('.pal-label')?.textContent ?? '');
}

function groupTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.pal-group')].map((el) => el.textContent ?? '');
}

async function type(container: HTMLElement, text: string): Promise<void> {
  const input = container.querySelector('input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {});
  await act(async () => {});
}

describe('全局搜索（Ctrl+K）：四组取数与成本纪律', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(async () => {
    localStorage.clear();
    listSavedSessions.mockReset();
    attachIntakePaths.mockClear();
    switchSession.mockClear();
    listDirMock.mockClear();
    shellRefs.chatPanel = fakePanel();
    getChatStore(PANEL_ID).sess.setState({ sessions: [], activeIdx: -1, nextSessionId: 1 });
    useShellStore.setState({ paletteOpen: false, projectPath: 'D:/search-ws' });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      useShellStore.setState({ paletteOpen: true });
      root?.render(createElement(CommandPalette));
    });
    await act(async () => {});
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    shellRefs.chatPanel = null;
    useShellStore.setState({ paletteOpen: false, settingsTab: null });
  });

  it('空查询：只列命令——不读卷表、不扫文件（打开即用，零成本）', () => {
    expect(container).not.toBeNull();
    expect(rowLabels(container as HTMLElement)).toContain('自主目标');
    expect(listSavedSessions, '空查询不该读卷表').not.toHaveBeenCalled();
    expect(listDirMock, '空查询不该扫文件').not.toHaveBeenCalled();
    // 卷 / 文件两组都不该出现（没有数据就没有组标题）
    const titles = groupTitles(container as HTMLElement);
    expect(titles).not.toContain('卷');
    expect(titles).not.toContain('文件');
  });

  it('输入卷名：卷组出现（读一次卷表），文件组仍不扫（未满 2 字）', async () => {
    listSavedSessions.mockResolvedValue([
      { id: 3, label: '旧卷三', msgCount: 2, savedAt: '2026-11-02T00:00:00Z' },
      { id: 4, label: '别的卷', msgCount: 1, savedAt: '2026-11-01T00:00:00Z' },
    ]);

    await type(container as HTMLElement, '旧');

    expect(listSavedSessions).toHaveBeenCalledTimes(1);
    expect(listDirMock).not.toHaveBeenCalled();
    expect(groupTitles(container as HTMLElement)).toContain('卷');
    expect(rowLabels(container as HTMLElement)).toContain('旧卷三');
    expect(rowLabels(container as HTMLElement)).not.toContain('别的卷');
  });

  it('输入 ≥2 字：扫一次文件；无活跃卷 ⇒ 文件行不可用并写明原因', async () => {
    listSavedSessions.mockResolvedValue([]);
    listDirMock.mockResolvedValue([
      { name: 'main.ts', path: 'D:/search-ws/src/main.ts', is_dir: false, children: null },
    ]);

    await type(container as HTMLElement, 'main');

    expect(listDirMock).toHaveBeenCalledTimes(1);
    const fileRow = [...(container as HTMLElement).querySelectorAll<HTMLButtonElement>('.pal-row')].find((b) =>
      b.textContent?.includes('main.ts'),
    );
    expect(fileRow, '文件行应出现').toBeDefined();
    expect(fileRow?.disabled, '没有活跃卷 ⇒ 文件行不可点').toBe(true);
    expect(fileRow?.getAttribute('data-tip')).toContain('先开一张卷');

    // 再打字不重复扫盘（每次打开最多一次）
    await type(container as HTMLElement, 'main-t');
    expect(listDirMock).toHaveBeenCalledTimes(1);
  });

  it('卷组上限 5：命中再多也只列 5 行', async () => {
    listSavedSessions.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => ({
        id: i + 1,
        label: `旧卷${i + 1}`,
        msgCount: 1,
        savedAt: `2026-11-0${(i % 9) + 1}T00:00:00Z`,
      })),
    );

    await type(container as HTMLElement, '旧卷');
    const vols = [...(container as HTMLElement).querySelectorAll('.pal-row')].filter((b) =>
      b.textContent?.includes('旧卷'),
    );
    expect(vols.length).toBe(5);
  });

  it('已摊开的卷：选中即切过去（switchSession 带下标）', async () => {
    listSavedSessions.mockResolvedValue([{ id: 7, label: '在办的卷', msgCount: 3, savedAt: '2026-11-03T00:00:00Z' }]);
    getChatStore(PANEL_ID).sess.setState({
      sessions: [{ id: 7, label: '在办的卷' }],
      activeIdx: 0,
      nextSessionId: 8,
    });

    await type(container as HTMLElement, '在办');
    const row = [...(container as HTMLElement).querySelectorAll<HTMLButtonElement>('.pal-row')].find((b) =>
      b.textContent?.includes('在办的卷'),
    );
    expect(row?.textContent).toContain('已摊开');
    await act(async () => {
      row?.click();
    });
    expect(switchSession).toHaveBeenCalledWith(0);
  });
});
