// @vitest-environment jsdom

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
import type { CommandContribution } from '../src/composition/services';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { resetComposeStoresForTests } from '../src/state/compose-store';
import { getChatStore } from '../src/ui/chat-store';

function fakeCore(panelId: string, commands: readonly CommandContribution[] = []): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    registerComposer: vi.fn(),
    executeCommand: vi.fn(),
    prepareCommand: vi.fn(),
    // 命令清单真源（2026-09-19 command-surface-rework）：旧 CommandRegistry
    // 单例退役——测试经会话内建命令位注入，断言面零改动。
    builtinCommands: () => [...commands],
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  flyToPoint: vi.fn(),
};

interface InputSeed {
  inputText?: string;
  inputHistory?: string[];
  inputHistoryIdx?: number;
  draftText?: string;
}

/** 装配 core + 播种会话/输入 store，并把 ComposerDock 渲染进 container。返回 fake core。
 *  commands = 注入的命令清单（命令真源 = app/commands/command-catalog 合流点，
 *  测试经会话内建命令位提供——旧 CommandRegistry 单例已退役）。 */
async function mountDock(
  panelId: string,
  container: HTMLDivElement,
  seed: InputSeed,
  onRoot: (r: Root) => void,
  commands: readonly CommandContribution[] = [],
): Promise<ChatCore> {
  const core = fakeCore(panelId, commands);
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
  const SLASH_CMDS: CommandContribution[] = [
    {
      id: 'alpha',
      label: 'Alpha 命令',
      description: '测试 alpha',
      group: '案卷',
      slash: '/alpha',
      action: { type: 'fill', text: '/alpha ' },
    },
    {
      id: 'beta',
      label: 'Beta 命令',
      description: '测试 beta',
      group: '案卷',
      slash: '/beta',
      action: { type: 'fill', text: '/beta ' },
    },
  ];
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
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
    const core = await mountDock(
      'slash-nav',
      container,
      { inputText: '/' },
      (r) => {
        root = r;
      },
      SLASH_CMDS,
    );
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
    const core = await mountDock(
      'slash-shift',
      container,
      { inputText: '/' },
      (r) => {
        root = r;
      },
      SLASH_CMDS,
    );
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
    await mountDock(
      'slash-esc',
      container,
      { inputText: '/al' },
      (r) => {
        root = r;
      },
      SLASH_CMDS,
    );
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
    expect(container.querySelector('.pp-slash')).not.toBeNull();
    keyOn(ta!, 'Escape');
    await act(async () => {});
    expect(container.querySelector('.pp-slash')).toBeNull();
    // 面板散 = 保留已输入查询词，去掉行首斜杠触发词
    expect(getChatStore('slash-esc').input.getState().inputText).toBe('al');
  });

  describe('ComposerDock 斜杠面板 v3（分组双行 · 空态 · 命中标朱 · 高亮可滚）', () => {
    const PANEL_CMDS: CommandContribution[] = [
      {
        id: 'new',
        label: '重置当前案卷',
        description: '清空对话历史，保留项目上下文',
        group: '案卷',
        slash: '/new',
        action: { type: 'fill', text: '/new ' },
      },
      {
        id: 'goal',
        label: '自主目标',
        description: '发 /goal 目标描述 开始',
        group: '案卷',
        slash: '/goal',
        action: { type: 'fill', text: '/goal ' },
      },
      {
        id: 'memory',
        label: '查看记忆',
        description: '列出所有已保存的记忆',
        group: '记忆',
        slash: '/memory',
        action: { type: 'fill', text: '/memory ' },
      },
      {
        id: 'bare',
        label: '无描述命令',
        group: '记忆',
        slash: '/bare',
        action: { type: 'fill', text: '/bare ' },
      },
    ];
    let container: HTMLDivElement;
    let root: Root | null = null;

    beforeEach(() => {
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

    it('按 group 分节：节头 = 组名、节序 = 首现序，条目沿用过滤后的扁平序', async () => {
      await mountDock(
        'slash-group',
        container,
        { inputText: '/' },
        (r) => {
          root = r;
        },
        PANEL_CMDS,
      );
      const heads = [...container.querySelectorAll('.pp-slash-group-head')].map((h) => h.textContent);
      expect(heads).toEqual(['案卷', '记忆']);
      const items = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
      expect(items.map((b) => b.querySelector('.pp-slash-shortcut')?.textContent)).toEqual([
        '/new',
        '/goal',
        '/memory',
        '/bare',
      ]);

      // 高亮序仍按扁平下标走：↓ 两下 = 第三条（跨节不重排）
      const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
      keyOn(ta!, 'ArrowDown');
      keyOn(ta!, 'ArrowDown');
      await act(async () => {});
      const after = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
      expect(after[2].classList.contains('active')).toBe(true);
    });

    it('每条带描述行（description 现成却从没显示过），无描述的条目不渲染描述行', async () => {
      await mountDock(
        'slash-desc',
        container,
        { inputText: '/' },
        (r) => {
          root = r;
        },
        PANEL_CMDS,
      );
      const items = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
      expect(items[0].querySelector('.pp-slash-desc')?.textContent).toBe('清空对话历史，保留项目上下文');
      expect(items[3].querySelector('.pp-slash-desc')).toBeNull();
    });

    it('查询词命中处在斜杠词/描述里标朱（大小写不敏感）', async () => {
      await mountDock(
        'slash-mark',
        container,
        { inputText: '/MEM' },
        (r) => {
          root = r;
        },
        PANEL_CMDS,
      );
      const items = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
      expect(items.length).toBe(1);
      const marks = [...items[0].querySelectorAll('mark')].map((m) => m.textContent);
      // 斜杠词 /memory 里的 mem 被标出（查询词大小写不参与匹配）
      expect(marks).toContain('mem');
    });

    it('零命中不消失：面板留着并给「无匹配命令」空态（旧实现整块 unmount）', async () => {
      await mountDock(
        'slash-empty',
        container,
        { inputText: '/zzz' },
        (r) => {
          root = r;
        },
        PANEL_CMDS,
      );
      expect(container.querySelector('.pp-slash')).not.toBeNull();
      expect(container.querySelectorAll('.pp-slash-item').length).toBe(0);
      expect(container.querySelector('.pp-slash-empty')?.textContent).toBe('无匹配命令');
    });

    it('↑↓ 把高亮行滚进可视区（旧实现只改 class，第 8 条起高亮落在滚动区外）', async () => {
      await mountDock(
        'slash-scroll',
        container,
        { inputText: '/' },
        (r) => {
          root = r;
        },
        PANEL_CMDS,
      );
      const panel = container.querySelector<HTMLElement>('.pp-slash')!;
      const items = [...container.querySelectorAll<HTMLElement>('.pp-slash-item')];
      // jsdom 不排版：显式给面板一个 200px 高的视口，并把第 2 条放在可视区下方 100px 处
      panel.getBoundingClientRect = () =>
        ({ top: 0, bottom: 200, left: 0, right: 420, width: 420, height: 200, x: 0, y: 0 }) as DOMRect;
      items[1].getBoundingClientRect = () =>
        ({ top: 240, bottom: 290, left: 0, right: 420, width: 420, height: 50, x: 0, y: 240 }) as DOMRect;
      panel.scrollTop = 0;

      const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
      keyOn(ta!, 'ArrowDown');
      await act(async () => {});
      expect(panel.scrollTop).toBe(90); // 290 - 200 = 溢出量

      // 回头往上：第 1 条在可视区上方 40px → 面板回滚 40px
      panel.scrollTop = 90;
      items[0].getBoundingClientRect = () =>
        ({ top: -40, bottom: 0, left: 0, right: 420, width: 420, height: 40, x: 0, y: -40 }) as DOMRect;
      keyOn(ta!, 'ArrowUp');
      await act(async () => {});
      expect(panel.scrollTop).toBe(50);
    });
  });
});
describe('ComposerDock 斜杠面板 · 带参命令（2026-11-07）', () => {
  const ARG_CMDS: CommandContribution[] = [
    {
      id: 'goal',
      label: '自主目标',
      description: '发 /goal 目标描述 开始；裸 /goal 查看状态',
      group: '案卷',
      slash: '/goal',
      takesArg: true,
      action: { type: 'local', handler: () => {} },
    },
    {
      id: 'new',
      label: '重置当前案卷',
      description: '清空对话历史，保留项目上下文',
      group: '案卷',
      slash: '/new',
      action: { type: 'local', handler: () => {} },
    },
  ];
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
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

  /** fake core 的 prepareCommand 补上与真实现同语义（写 store）——面板可见性是
   *  输入框派生的，这才能顺带钉住「填完就进入参数模式、面板让位」。 */
  async function mountArg(inputText: string, panelId: string) {
    const core = await mountDock(
      panelId,
      container,
      { inputText },
      (r) => {
        root = r;
      },
      ARG_CMDS,
    );
    vi.mocked(core.prepareCommand).mockImplementation((cmd: CommandContribution) => {
      getChatStore(panelId).input.getState().setInputText(`${cmd.slash} `);
    });
    return core;
  }

  it('点选带参命令 = 填入「/goal 」待编辑（不空参执行），面板随之让位', async () => {
    const core = await mountArg('/', 'slash-arg-click');
    const items = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
    await act(async () => {
      items[0].click();
    });
    expect(core.prepareCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'goal' }));
    expect(core.executeCommand).not.toHaveBeenCalled();
    expect(getChatStore('slash-arg-click').input.getState().inputText).toBe('/goal ');
    expect(container.querySelector('.pp-slash')).toBeNull();
  });

  it('回车同理：带参命令填入待编辑，不执行', async () => {
    const core = await mountArg('/', 'slash-arg-enter');
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea');
    keyOn(ta!, 'Enter');
    await act(async () => {});
    expect(core.prepareCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'goal' }));
    expect(core.executeCommand).not.toHaveBeenCalled();
  });

  it('无参命令仍是点选即执行', async () => {
    const core = await mountArg('/', 'slash-arg-plain');
    const items = [...container.querySelectorAll<HTMLButtonElement>('.pp-slash-item')];
    await act(async () => {
      items[1].click();
    });
    expect(core.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' }));
    expect(core.prepareCommand).not.toHaveBeenCalled();
  });

  it('命令词后打空格 = 参数模式，面板让位（/goal p）', async () => {
    await mountArg('/', 'slash-arg-mode');
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-composer-row textarea')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(ta, '/goal p');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
    expect(container.querySelector('.pp-slash')).toBeNull();
    // 退回命令词本身（删掉空格后的参数）→ 面板回来
    act(() => {
      setter.call(ta, '/goal');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
    expect(container.querySelector('.pp-slash')).not.toBeNull();
  });
});
