// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 零卷（案上无卷）：**创作坞整只不渲染**——出生面唯一 = 空态块 / 待题纸。
//
// 2026-11-28 用户拍板（A 案）：旧「案头态」（pp-at-desk：退匣直书 + 坞下挂签条架）是
// 待题纸（2026-11-14 立卷 UX）之前的出生面。坞里打字直接建卷 = **第二条出生路径**，
// 绕过题签 / 落点 / 化卷那一拍，且与「＋ 另起一卷」落纸重复；而坞的身份是「这一卷的
// 输入面」（视图不是容器），零卷时它没有指向对象 ⇒ 不渲染。
// 「续写旧卷」签条架搬进空态块（.pp-empty 内），入口不丢。
//
// 本测钉住三条用户可见行为：
//   ① 零卷 + 无纸 ⇒ 坞槽 null、空态块在、签条架**在空态块里**；
//   ② 零卷 + 纸摊开 ⇒ 空态块退场、坞槽仍 null（纸上那张输入面是唯一输入面）；
//   ③ 有卷 ⇒ 坞槽在、空态块不在（坞回来看护活跃卷）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const layoutMock = vi.hoisted(() => vi.fn(() => ({ height: 36, lineCount: 2 })));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _mock: true })),
  walkLineRanges: vi.fn(),
  materializeLineRange: vi.fn(() => ({ width: 100, text: 'mock' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

class Fake2dCtx {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textBaseline = '';
  setTransform(): void {}
  clearRect(): void {}
  fillRect(): void {}
  fillText(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
  strokeRect(): void {}
  closePath(): void {}
}
HTMLCanvasElement.prototype.getContext = function fakeGetContext() {
  return new Fake2dCtx();
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

let rafSeq = 0;
const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = ((cb: (t: number) => void) => {
  const id = ++rafSeq;
  rafTimers.set(
    id,
    setTimeout(() => {
      rafTimers.delete(id);
      cb(performance.now());
    }, 16),
  );
  return id;
}) as unknown as typeof requestAnimationFrame;
(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = ((id: number) => {
  const t = rafTimers.get(id);
  if (t) clearTimeout(t);
  rafTimers.delete(id);
}) as unknown as typeof cancelAnimationFrame;

import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { getChatStore } from '../src/ui/chat-store';

const W = 1200;
const H = 800;

/** 挂一块画布（会话态由调用方先写进 useCoreStore / sess store）。 */
async function mountEmptyWorkspace(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    (root as Root).render(<PaperPanel />);
  });
  await act(async () => {
    useCanvasViewStore.getState().setCanvasSize(W, H);
  });
  return container;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe('零卷：坞槽整只不渲染，出生面 = 空态块 / 待题纸', () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    useShellStore.setState({ projectPath: 'D:/empty-dock-ws' });
    useDraftSheetStore.getState().dismissAll();
    useDockStore.getState().closePanel('paper');
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useDraftSheetStore.getState().dismissAll();
  });

  it('零卷无纸：坞槽不渲染，空态块在场，续写签条架长在空态块里', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    getChatStore(panel.panelId).sess.setState({ sessions: [], activeIdx: -1, nextSessionId: 1 });
    // 续写签条的数据面：一旧卷（savedAt 倒序取三的输入）
    vi.spyOn(panel, 'listSavedSessions').mockResolvedValue([
      { id: 7, label: '旧卷', msgCount: 3, savedAt: '2026-11-01T00:00:00.000Z' },
    ]);
    useCanvasViewStore.getState().restoreView({ zoom: 1, panX: 0, panY: 0 });

    container = await mountEmptyWorkspace();
    await act(async () => {});

    // 空态块在，坞槽**不在**（旧案头形态退役）
    const empty = container.querySelector('.pp-empty');
    expect(empty, '零卷应有空态块').not.toBeNull();
    expect(container.querySelector('.pp-composer-slot'), '零卷不该有创作坞（出生面只有纸）').toBeNull();
    expect(container.querySelector('.pp-composer'), '零卷不该有坞本体').toBeNull();

    // 续写签条架搬进空态块：架在空态块**里**，条目在
    const shelf = empty?.querySelector('.pp-desk-shelf');
    expect(shelf, '续写签条架应在空态块内').not.toBeNull();
    expect(shelf?.querySelectorAll('.pp-desk-tag').length, '三条续写签（一条旧卷）').toBe(1);
  });

  it('零卷 + 纸摊开：空态块退场，坞槽仍不渲染（纸上那张是唯一输入面）', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    getChatStore(panel.panelId).sess.setState({ sessions: [], activeIdx: -1, nextSessionId: 1 });
    useCanvasViewStore.getState().restoreView({ zoom: 1, panX: 0, panY: 0 });

    container = await mountEmptyWorkspace();

    const cta = container.querySelector('.pp-empty-cta') as HTMLButtonElement | null;
    expect(cta, '空态块应有出生入口').not.toBeNull();
    await act(async () => {
      cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-draft-sheet]'), '待题纸应在场').not.toBeNull();
    expect(container.querySelector('.pp-empty'), '纸在场时空态块退场').toBeNull();
    expect(container.querySelector('.pp-composer-slot'), '纸期也不该冒出坞（输入面在纸上）').toBeNull();
  });

  it('有卷：坞槽回来，空态块退场', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    getChatStore(panel.panelId).sess.setState({
      sessions: [{ id: 1, label: '卷一' }],
      activeIdx: 0,
      nextSessionId: 2,
    });
    useCanvasViewStore.getState().restoreView({ zoom: 1, panX: 0, panY: 0 });

    container = await mountEmptyWorkspace();

    expect(container.querySelector('.pp-composer-slot'), '有卷时坞槽应在').not.toBeNull();
    expect(container.querySelector('.pp-empty'), '有卷时不该有空态块').toBeNull();
  });
});
