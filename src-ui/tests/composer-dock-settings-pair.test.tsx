// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞设置行行内排布钉（2026-09-06 续批二；2026-11-06 合并 A 改钉）。
//
// 现行契约（2026-11-06 用户拍板 A）：思考档位并进**模型 pill**（收起态后缀 +
// 弹层顶部档位条），设置行不再有独立的思考控件——「谁的脑子 · 想到多深」是
// 同一个决定，档位表本就由当前模型派生。原先的「权限+思考」成对契约随之退役
// （权限=工作区级 mode-store、模型/档位=每会话 compose-store，仍是两个真相源，
// 只是档位归位到它真正的归属面：模型）。新子序 =
//   模型（带档位后缀）→ 组合 → ✎造模式 → spacer → 权限 → 役 → 墨
// 本文件钉这条 DOM 序防回退。
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
//
// 2026-09-22 规格变更（役册落位）：行尾由「单枚仪表」扩为**两枚读数件**
// 「役 | 墨」——役 = 已经派了多少活出去（后台命令 + 子 Agent 的在役清单，点开是
// 役册），墨 = 还能喂多少上下文（点开是墨量册）。两者同属「落笔前该看的读数」，
// 故同居行尾、**役在墨内、墨仍收最右**（§9.1 对墨「读数件居行最右 = 拟文印正下方
// 的读点」的判据逐字保留，零漂移）。成对契约与「读数不插进策略对」两条**不变**。

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

  it('子序 = 模型（带档位后缀）→ 组合 → ✎造模式 → spacer → 权限 → 役 → 墨；档位不再独立成件', async () => {
    await mountDock('settings-pair');
    const settings = container.querySelector('.pp-composer-settings')!;
    const classes = [...settings.children].map((el) => el.className);
    expect(classes[0]).toContain('ms-container'); // 模型独居左端
    const msIdx = classes.findIndex((c) => c.includes('ms-container'));
    // S6 P1e（2026-09-15）：左端成对——模型（谁的脑子）+ 组合（哪些工具与提示面）
    const compIdx = classes.findIndex((c) => c.includes('pp-comp-sel'));
    // 2026-10-30：造模式入口（✎）紧跟组合芯片——「选现成的」与「造一个新的」同居左端簇
    const creatorIdx = classes.findIndex((c) => c.includes('pp-comp-creator'));
    const spacerIdx = classes.indexOf('pp-composer-settings-spacer');
    const permIdx = classes.findIndex((c) => c.includes('pp-mode-seg'));
    const workIdx = classes.findIndex((c) => c.includes('pp-work-sel'));
    const inkIdx = classes.findIndex((c) => c.includes('pp-ink-sel'));
    expect(msIdx).toBe(0);
    // 2026-11-06 合并 A：档位住在模型 pill 里，设置行不再有独立的思考控件
    expect(settings.querySelector('.pp-thinking-sel')).toBeNull();
    expect(settings.querySelector('.pp-thinking-pill')).toBeNull();
    expect(settings.querySelector('.ms-trigger-thinking')).not.toBeNull();
    expect(compIdx).toBe(msIdx + 1); // 组合紧跟模型（同居「本卷拿什么跑」左端）
    expect(creatorIdx).toBe(compIdx + 1); // ✎ 造模式紧邻组合芯片（选现成的 / 造一个新的）
    expect(spacerIdx).toBe(creatorIdx + 1); // 左端簇与右端控件之间隔 spacer
    expect(permIdx).toBe(spacerIdx + 1);
    // 2026-09-22：役册紧邻墨量册（两枚读数件成对居行尾），役在内、墨仍收最右
    expect(workIdx).toBe(permIdx + 1);
    expect(inkIdx).toBe(workIdx + 1);
    expect(inkIdx).toBe(classes.length - 1);
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
