// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞 v2（2026-08-31）组件测试：翰（命令面板入口）/ 律（快捷键总览）/
// 墨量线（token 占窗口比）/ 引（文件模糊引用纯函数 + 面板开合）。
// 拖放入卷走 Tauri 原生通道——jsdom mock 模式 no-op，此处只守护不炸不挂类。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import type { CommandContribution } from '../src/composition/services';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock, flattenDirEntries, fuzzyMatchFiles } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { getComposeStore, resetComposeStoresForTests } from '../src/state/compose-store';
import { getChatStore } from '../src/ui/chat-store';

function fakeCore(panelId: string, commands: readonly CommandContribution[] = []): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    registerComposer: vi.fn(),
    executeCommand: vi.fn(),
    // 命令清单真源（2026-09-19 command-surface-rework）：旧 CommandRegistry
    // 单例退役——测试经会话内建命令位注入，断言面零改动。
    builtinCommands: () => [...commands],
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  flyToPoint: vi.fn(),
};

async function mountDock(
  panelId: string,
  container: HTMLDivElement,
  opts: { tokens?: Record<number, number> } = {},
  onRoot: (r: Root) => void,
  commands: readonly CommandContribution[] = [],
): Promise<ChatCore> {
  const core = fakeCore(panelId, commands);
  useCoreStore.getState().setChatCore(core);
  getChatStore(panelId).sess.setState({
    sessions: [{ id: 1, label: '案卷一' }],
    activeIdx: 0,
    sessionTokens: opts.tokens ?? {},
    nextSessionId: 2,
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

describe('创作坞 v2 纯函数：引 模糊匹配', () => {
  const FILES = [
    { path: 'D:/ws/docs/plans/roadmap.md', name: 'roadmap.md' },
    { path: 'D:/ws/readme.md', name: 'readme.md' },
    { path: 'D:/ws/src/ui/app.tsx', name: 'app.tsx' },
    { path: 'D:/ws/src/ui/app.test.tsx', name: 'app.test.tsx' },
  ];

  it('子序列命中：roadap 命中 roadmap.md', () => {
    const hits = fuzzyMatchFiles(FILES, 'roadap');
    expect(hits.some((f) => f.name === 'roadmap.md')).toBe(true);
  });

  it('basename 命中加权：read 命中 readme.md 靠前，路径命中殿后', () => {
    const hits = fuzzyMatchFiles(FILES, 'read');
    expect(hits[0]?.name).toBe('readme.md');
  });

  it('空查询 = 清单原序截前 limit', () => {
    const hits = fuzzyMatchFiles(FILES, '', 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.path).toBe(FILES[0].path);
  });

  it('不命中 = 空清单', () => {
    expect(fuzzyMatchFiles(FILES, 'zzzz')).toHaveLength(0);
  });
});

describe('创作坞 v2 纯函数：目录树摊平', () => {
  it('递归摊平文件、跳过目录项', () => {
    const tree = [
      {
        name: 'ws',
        path: 'D:/ws',
        is_dir: true,
        children: [
          { name: 'readme.md', path: 'D:/ws/readme.md', is_dir: false },
          {
            name: 'src',
            path: 'D:/ws/src',
            is_dir: true,
            children: [{ name: 'app.tsx', path: 'D:/ws/src/app.tsx', is_dir: false }],
          },
        ],
      },
    ];
    const flat = flattenDirEntries(tree);
    expect(flat.map((f) => f.name)).toEqual(['readme.md', 'app.tsx']);
  });
});

describe('创作坞 v2：翰（命令面板入口）', () => {
  const CMDS: CommandContribution[] = [
    {
      id: 'gamma',
      label: 'Gamma 命令',
      description: '测试 gamma',
      group: '案卷',
      slash: '/gamma',
      action: { type: 'fill', text: '/gamma ' },
    },
  ];
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    useShellStore.setState({ paletteOpen: false });
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    useShellStore.setState({ paletteOpen: false });
  });

  it('点翰 = 打开全局命令面板（Ctrl+K 同源），不再生内联斜杠清单', async () => {
    await mountDock(
      'han-open',
      container,
      {},
      (r) => {
        root = r;
      },
      CMDS,
    );
    expect(useShellStore.getState().paletteOpen).toBe(false);
    // 2026-11-09：翰/律 撤出书眉——入口在「案」抽屉「另起」段
    act(() => {
      (container.querySelector('.pp-scheme-btn') as HTMLButtonElement).click();
    });
    await act(async () => {});
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('.pp-scheme-row')]
        .find((b) => b.textContent?.includes('翰'))
        ?.click();
    });
    await act(async () => {});
    expect(useShellStore.getState().paletteOpen).toBe(true);
    expect(container.querySelector('.pp-slash')).toBeNull();
  });

  it('/ 触发词仍走内联斜杠面板（翰解耦不伤 / 路径）', async () => {
    const core = await mountDock(
      'han-slash',
      container,
      {},
      (r) => {
        root = r;
      },
      CMDS,
    );
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(ta, '/gam');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
    const items = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
    expect(items.length).toBeGreaterThan(0);
    act(() => {
      items[0]?.click();
    });
    await act(async () => {});
    expect(core.executeCommand).toHaveBeenCalled();
  });
});

describe('创作坞 v2：律（快捷键总览）', () => {
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

  it('点律在抽屉里就地展开：Enter 发送/换行/输入历史等键位在册；再点收起（2026-11-09）', async () => {
    await mountDock('lv-open', container, {}, (r) => {
      root = r;
    });
    act(() => {
      (container.querySelector('.pp-scheme-btn') as HTMLButtonElement).click();
    });
    await act(async () => {});
    const lvRow = () =>
      [...container.querySelectorAll<HTMLButtonElement>('.pp-scheme-row')].find((b) => b.textContent?.includes('律'))!;
    act(() => lvRow().click());
    await act(async () => {});
    const sheet = container.querySelector('.pp-help-inline');
    expect(sheet).not.toBeNull();
    expect(sheet?.textContent).toContain('发送');
    expect(sheet?.textContent).toContain('换行');
    expect(sheet?.textContent).toContain('输入历史');
    // 2026-10-22 P2：13 行等权平铺 → 四组（输入/附卷/画布/纸面）
    expect([...sheet!.querySelectorAll('.pp-help-group-title')].map((el) => el.textContent)).toEqual([
      '输入',
      '附卷',
      '画布',
      '纸面',
    ]);
    act(() => lvRow().click());
    await act(async () => {});
    expect(container.querySelector('.pp-help-inline')).toBeNull();
  });
});

describe('创作坞 v2：墨量读数（2026-11-08 墨线退役后的口径）', () => {
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

  /* 2026-11-08 丙案尾项：坞底那条 .pp-inkline **整个删除**——它与书眉「墨 NN%」读数
   * 同源同判据（同一 stats / 同一 >80% 门槛），是同一件事画两遍。本组测试随之改写：
   * 钉的不再是"线宽"，而是「读数在书眉、口径仍是一把尺子」这件事本身。
   * 近满态的信号没有丢——它抬到了触发器本体（.pp-ink-trigger.full → 朱字 + 呼吸），
   * 那条由 tests/ink-ledger.test.tsx「近满」例钉住。 */
  it('坞底不再有墨线：.pp-inkline 整条退役，坞高不再含那 2px', async () => {
    await mountDock('ink-ratio', container, { tokens: { 1: 500000 } }, (r) => {
      root = r;
    });
    getComposeStore('ink-ratio').getState().setModel('1', 'deepseek', 'deepseek-v4-pro');
    await act(async () => {});
    expect(container.querySelector('.pp-inkline')).toBeNull();
  });

  it('读数仍在书眉：墨量册触发器报百分比（占用口径交回它自己）', async () => {
    await mountDock('ink-ratio-2', container, { tokens: { 1: 500000 } }, (r) => {
      root = r;
    });
    getComposeStore('ink-ratio-2').getState().setModel('1', 'deepseek', 'deepseek-v4-pro');
    await act(async () => {});
    const header = container.querySelector('.pp-composer-header')!;
    const trigger = header.querySelector('.pp-ink-trigger');
    expect(trigger).not.toBeNull();
    // 无 token-meter 回报时触发器只报「墨 —」（不编造百分比）
    expect(trigger?.textContent).toContain('墨');
  });
});

describe('创作坞 v2：引（文件引用面板）', () => {
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

  it('点引开面板（输入框现身）；Esc 散面板', async () => {
    await mountDock('yin-open', container, {}, (r) => {
      root = r;
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('.pp-yin-btn')?.click();
    });
    await act(async () => {});
    const panel = container.querySelector('.pp-yin-panel');
    expect(panel).not.toBeNull();
    const input = panel?.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    expect(container.ownerDocument.activeElement).toBe(input); // 开面板即聚焦
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(container.querySelector('.pp-yin-panel')).toBeNull();
  });

  it('mock 环境（vitest）拖放通道 no-op：不炸、无界栏类', async () => {
    await mountDock('drag-mock', container, {}, (r) => {
      root = r;
    });
    await act(async () => {});
    expect(container.querySelector('.pp-composer')?.classList.contains('pp-droptarget')).toBe(false);
  });
});
