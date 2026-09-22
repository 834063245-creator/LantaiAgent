// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞附图预览（大图浮层）—— 2026-09-22 用户报病的回归钉。
//
// 原话：「我贴了张图片进去之后，鼠标点击图片预览，然后我创作坞整个被图片覆盖，
//         图片预览也没办法收回，太离谱了」。
//
// 病灶（根因不在浮层本身，在**宿主盒子**）：坞槽 `.pp-composer-slot` 带
// `transform: translateX(-50%)`（版心居中）——transform 使该元素成为其
// `position: fixed` 后代的**包含块**，于是浮层的 `inset: 0` 量的是坞的盒子而不是
// 视口（预览被关进坞里：图 `max-width: min(86vw,1200px)` 远大于坞，几乎盖满整个
// 遮罩 ⇒ 点哪儿都落在图上，而判据是 `e.target === e.currentTarget`）；坞槽同时是
// `z-index: 6` 的层叠上下文，坞内 `z-index: 95` 只在坞里排序；Escape 又挂在**不可
// 聚焦**的 div 上（焦点在缩略图按钮上，事件不经过它）⇒ 鼠标键盘都关不掉 = 死锁。
// 且坞被拖动后浮动化会写内联 `transform: none`，故旧写法只在**默认坞位**上炸。
//
// 修法：归位成它本来的身份——**全局模态**（CONVENTIONS 浮层政策「全局模态用
// portal=true」），portal 到 body（同 media 渲染器的大图预览 `.pp-media-preview-overlay`），
// Escape 交给 `useDialogEscape`（document capture 监听，与焦点无关）；因产物域装不下
// `app/overlay` 的 Overlay 原语（插件目录外的 JSX 解析不到 `./host/jsx-runtime`），
// 这里用裸 `createPortal` + 宿主桥既有 hook，理由详见 ComposerDock 导入处注。
// 本文件按用户操作序列钉三件事：
//   ① 预览挂在 document.body（坞子树外）——包含块与层叠上下文都逃出去了；
//   ② 收得回：焦点在缩略图上按 Esc 关（旧实现的死法）、点遮罩关；
//   ③ 关掉之后零残留。
// 层级换轨的静态钉（portal 之后 z-index 必须盖过 `.pp-root`）在
// tests/paper-visual-decisions.test.ts 的 B4 附图节。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import type { ChatImageRef } from '../src/provider/types';
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

/** 贴进坞的那张图（尺寸取自实机报病那张：2560×1400 —— 远大于坞体，正是「糊住」的由来）。 */
const IMAGE: ChatImageRef = {
  id: 'a'.repeat(64),
  mediaType: 'image/png',
  bytes: 6_456_848,
  width: 2560,
  height: 1400,
  name: 'shot.png',
};

describe('创作坞附图预览 · 全局模态（2026-09-22 病灶回归钉）', () => {
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

  /** 装配 core + 播一卷 + **贴一张图**（= 用户操作序列的前半步），渲染 ComposerDock。 */
  async function mountWithImage(panelId: string, onRoot: (r: Root) => void) {
    useCoreStore.getState().setChatCore(fakeCore(panelId));
    getChatStore(panelId).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    const input = getChatStore(panelId).input.getState();
    input.setInputText('');
    input.setAttachedImages([IMAGE]);
    act(() => {
      root = createRoot(container);
      onRoot(root);
      root.render(createElement(PaperDockContext.Provider, { value: DOCK_CONTEXT }, createElement(ComposerDock)));
    });
    await act(async () => {});
  }

  it('点缩略图 → 浮层挂在 document.body（坞子树外）；Esc 与点遮罩都能收回', async () => {
    await mountWithImage('preview-recover', (r) => {
      root = r;
    });
    // 未开图时零渲染
    expect(document.querySelector('.pp-image-lightbox')).toBeNull();
    const thumb = container.querySelector<HTMLButtonElement>('.pp-image-thumb');
    expect(thumb, '附图 rail 缩略图应在坞内（贴图后可见）').not.toBeNull();

    act(() => thumb?.click());
    await act(async () => {});

    const veil = document.querySelector('.pp-image-lightbox');
    expect(veil, '点缩略图应开出预览浮层').not.toBeNull();
    // ① 逃出坞的包含块与层叠上下文——**在坞子树里就是原病**（浮层被关进坞的盒子）
    expect(container.querySelector('.pp-image-lightbox'), '浮层仍留在坞子树内（包含块陷阱未除）').toBeNull();
    // 对话框语义仍在遮罩本体上（portal 不改 DOM 形态，只换挂载点）
    expect(veil?.getAttribute('role')).toBe('dialog');
    expect(veil?.getAttribute('aria-modal')).toBe('true');
    expect(veil?.getAttribute('aria-label')).toBe('附图预览');
    expect(veil?.querySelector('img')?.getAttribute('alt')).toBe('shot.png');

    // ② 焦点在缩略图按钮上按 Esc —— 旧实现的死法（事件不经过浮层，键盘关不掉）
    await act(async () => {
      thumb?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.pp-image-lightbox'), 'Esc 未能收回预览').toBeNull();

    // ③ 再开一次 → 点遮罩空白处收回
    act(() => thumb?.click());
    await act(async () => {});
    const veil2 = document.querySelector('.pp-image-lightbox');
    expect(veil2).not.toBeNull();
    await act(async () => {
      veil2?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('.pp-image-lightbox'), '点遮罩未能收回预览').toBeNull();
  });
});
