// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞设置行行内排布钉（2026-09-06 续批二）：模型独居左端，权限+思考成对
// 靠右（组内权限在左、思考收尾）——两件同属「运行策略」成对归堆，不与模型混排。
// 直接合并成单控件暂缓（权限=工作区级 mode-store、思考=每会话 compose-store，
// 两真相源硬合会搅浑状态归属）。本文件钉行内 DOM 序防回退。
//
// 2026-09-13 规格变更（墨量册落位）：行尾追加**墨量仪表**（pp-ink-sel）——
// 读数件不是控件，不进「运行策略」对，独立居行最右（用户动作链末端 = 拟文印
// 正下方的读点；对齐 DSH 把上下文表放在输入条旁的判据）。成对契约不变：
// 权限+思考仍相邻成对，只是对尾多了仪表。
//
// 2026-09-15 规格变更（S6 P1e 组合芯片落位）：左端由「模型独居」变为**左端成对**
// 「模型 | 组合」（pp-comp-sel）——两者共同定义「本卷拿什么跑」（模型 = 谁的脑子，
// 组合 = 哪些工具与提示面），故同居左端；右端「运行策略」对与行尾墨量仪表的契约
// **不变**（组合是运行环境面，不是运行策略，不插进那一对）。

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

  it('模型+组合居左端、权限+思考成对靠右、墨量仪表收行尾：子序 = 模型 → 组合 → spacer → 权限 → 思考 → 墨量', async () => {
    await mountDock('settings-pair');
    const settings = container.querySelector('.pp-composer-settings')!;
    const classes = [...settings.children].map((el) => el.className);
    expect(classes[0]).toContain('ms-container'); // 模型独居左端
    const msIdx = classes.findIndex((c) => c.includes('ms-container'));
    // S6 P1e（2026-09-15）：左端成对——模型（谁的脑子）+ 组合（哪些工具与提示面）
    const compIdx = classes.findIndex((c) => c.includes('pp-comp-sel'));
    const spacerIdx = classes.indexOf('pp-composer-settings-spacer');
    const permIdx = classes.findIndex((c) => c.includes('pp-mode-seg'));
    const thinkIdx = classes.findIndex((c) => c.includes('pp-thinking-sel'));
    const inkIdx = classes.findIndex((c) => c.includes('pp-ink-sel'));
    expect(msIdx).toBe(0);
    expect(compIdx).toBe(msIdx + 1); // 组合紧跟模型（同居「本卷拿什么跑」左端）
    expect(spacerIdx).toBe(compIdx + 1); // 左端簇与策略对之间隔 spacer——成对被推右
    expect(permIdx).toBe(spacerIdx + 1);
    expect(thinkIdx).toBe(permIdx + 1); // 思考收尾「运行策略」对；权限在组内左侧
    expect(inkIdx).toBe(thinkIdx + 1); // 墨量仪表居行最右（读数不插进策略对）
    expect(inkIdx).toBe(classes.length - 1);
  });

  it('策略对成员相邻无模型/仪表插入：权限与思考之间不隔其它控件', async () => {
    await mountDock('settings-pair-adjacent');
    const settings = container.querySelector('.pp-composer-settings')!;
    const children = [...settings.children].map((el) => el.className);
    const permIdx = children.findIndex((c) => c.includes('pp-mode-seg'));
    const thinkIdx = children.findIndex((c) => c.includes('pp-thinking-sel'));
    expect(thinkIdx - permIdx).toBe(1); // 成对相邻
  });

  it('墨量仪表有活跃卷才出现（无主待命态不冒充读数）', async () => {
    await mountDock('settings-pair-no-active');
    expect(container.querySelector('.pp-ink-sel')).not.toBeNull();
    // 无活跃卷（activeSessionId 置空）→ 仪表不渲染
    act(() => root?.unmount());
    root = null;
    container.innerHTML = '';
    useCoreStore.getState().setChatCore(fakeCore('settings-pair-idle'));
    getChatStore('settings-pair-idle').sess.setState({
      sessions: [],
      activeIdx: -1,
      sessionTokens: {},
      nextSessionId: 1,
    });
    act(() => {
      root = createRoot(container);
      root.render(
        createElement(
          PaperDockContext.Provider,
          { value: { activeSessionId: null, flyToPoint: vi.fn() } },
          createElement(ComposerDock),
        ),
      );
    });
    await act(async () => {});
    expect(container.querySelector('.pp-ink-sel')).toBeNull();
  });
});
