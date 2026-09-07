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
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock, flattenDirEntries, fuzzyMatchFiles } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { getComposeStore, resetComposeStoresForTests } from '../src/state/compose-store';
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

async function mountDock(
  panelId: string,
  container: HTMLDivElement,
  opts: { tokens?: Record<number, number> } = {},
  onRoot: (r: Root) => void,
): Promise<ChatCore> {
  const core = fakeCore(panelId);
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
  const CMDS: CommandDef[] = [
    {
      id: 'gamma',
      label: 'Gamma 命令',
      description: '测试 gamma',
      group: '案卷',
      shortcut: '/gamma',
      action: { type: 'fill', text: '/gamma ' },
    },
  ];
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    CommandRegistry.instance.registerAll(CMDS);
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

  it('点翰开面板（空查询 = 全量命令）；再点散；执行命令即散面板', async () => {
    const core = await mountDock('han-open', container, {}, (r) => {
      root = r;
    });
    // 点翰 → 面板现身（无 / 触发词）
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('.pp-tool-btn')].find((b) => b.textContent === '翰')?.click();
    });
    await act(async () => {});
    const items = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
    expect(items.length).toBeGreaterThan(0);

    // 点命令项 → executeCommand 调用 + 面板散
    act(() => {
      items[0]?.click();
    });
    await act(async () => {});
    expect(core.executeCommand).toHaveBeenCalled();
    expect(container.querySelector('.pp-slash')).toBeNull();
  });

  it('手输即散翰面板（打字接管，/ 触发词自然接管过滤）', async () => {
    await mountDock('han-type', container, {}, (r) => {
      root = r;
    });
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('.pp-tool-btn')].find((b) => b.textContent === '翰')?.click();
    });
    await act(async () => {});
    expect(container.querySelector('.pp-slash')).not.toBeNull();

    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(ta!, '落笔');
      ta!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
    expect(container.querySelector('.pp-slash')).toBeNull();
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

  it('点律开总览浮层：Enter 发送/换行/输入历史等键位在册；再点散', async () => {
    await mountDock('lv-open', container, {}, (r) => {
      root = r;
    });
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('.pp-tool-btn')].find((b) => b.textContent === '律')?.click();
    });
    await act(async () => {});
    const sheet = container.querySelector('.pp-help-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet?.textContent).toContain('发送');
    expect(sheet?.textContent).toContain('换行');
    expect(sheet?.textContent).toContain('输入历史');
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('.pp-tool-btn')].find((b) => b.textContent === '律')?.click();
    });
    await act(async () => {});
    expect(container.querySelector('.pp-help-sheet')).toBeNull();
  });
});

describe('创作坞 v2：墨量线', () => {
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

  it('有用量 + 目录窗口：线宽 = 占比，title 报数', async () => {
    await mountDock('ink-ratio', container, { tokens: { 1: 500000 } }, (r) => {
      root = r;
    });
    // 默认出生模型须有目录窗口——种 deepseek-v4-pro（contextWindow 1M）
    getComposeStore('ink-ratio').getState().setModel('1', 'deepseek', 'deepseek-v4-pro');
    await act(async () => {});
    const line = container.querySelector<HTMLElement>('.pp-inkline');
    expect(line).not.toBeNull();
    expect(line?.style.opacity).toBe('1');
    const bar = line?.querySelector<HTMLElement>('span');
    expect(bar?.style.width).toBe('50%');
    expect(line?.title).toContain('墨量 500000 / 1000000 tok（50%）');
    expect(line?.title).toContain('50%');
  });

  it('零用量：线隐（opacity 0）——[0] 徽标时代的噪音不再', async () => {
    await mountDock('ink-zero', container, {}, (r) => {
      root = r;
    });
    getComposeStore('ink-zero').getState().setModel('1', 'deepseek', 'deepseek-v4-pro');
    await act(async () => {});
    const line = container.querySelector<HTMLElement>('.pp-inkline');
    expect(line).not.toBeNull();
    expect(line?.style.opacity).toBe('0');
  });

  it('目录外模型（网关命名空间 id）无覆盖：不编造窗口，线隐', async () => {
    // 2026-09-07 分母接线：网关 /models 常返回命名空间 id（deepseek/deepseek-
    // v4-flash），目录按裸 id 收录不中——无 per-model 覆盖时不得编造窗口。
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'commandcodegoat',
        providers: [
          {
            kind: 'openai',
            name: 'commandcodegoat',
            apiKey: '',
            baseUrl: 'https://api.commandcode.ai/provider/v1',
            model: 'deepseek/deepseek-v4-flash',
          },
        ],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );
    try {
      await mountDock('ink-gateway', container, { tokens: { 1: 500000 } }, (r) => {
        root = r;
      });
      getComposeStore('ink-gateway').getState().setModel('1', 'commandcodegoat', 'deepseek/deepseek-v4-flash');
      await act(async () => {});
      const line = container.querySelector<HTMLElement>('.pp-inkline');
      expect(line).not.toBeNull();
      expect(line?.style.opacity).toBe('0');
    } finally {
      localStorage.removeItem('hologram_settings');
    }
  });

  it('目录外模型 + per-model 窗口覆盖：覆盖即分母，线显', async () => {
    // 同上网关，但行上带 modelOverrides——设置页声明的窗口经
    // modelContextWindow（与运行时压缩阈值同链）对墨条生效。
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'commandcodegoat',
        providers: [
          {
            kind: 'openai',
            name: 'commandcodegoat',
            apiKey: '',
            baseUrl: 'https://api.commandcode.ai/provider/v1',
            model: 'deepseek/deepseek-v4-flash',
            modelOverrides: { 'deepseek/deepseek-v4-flash': { contextWindow: 1000000 } },
          },
        ],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );
    try {
      await mountDock('ink-override', container, { tokens: { 1: 500000 } }, (r) => {
        root = r;
      });
      getComposeStore('ink-override').getState().setModel('1', 'commandcodegoat', 'deepseek/deepseek-v4-flash');
      await act(async () => {});
      const line = container.querySelector<HTMLElement>('.pp-inkline');
      expect(line).not.toBeNull();
      expect(line?.style.opacity).toBe('1');
      const bar = line?.querySelector<HTMLElement>('span');
      expect(bar?.style.width).toBe('50%');
      expect(line?.title).toContain('墨量 500000 / 1000000 tok（50%）');
    } finally {
      localStorage.removeItem('hologram_settings');
    }
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
