// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待题纸 · **多纸与回卷**（2026-11-17 用户报：「有一张题签之后，既不能回头和已有会话
// 交互，也不能同时创建多个题签」）。
//
// 三个根因各钉一颗钉子：
//   ① 纸是单例（anchor/picks/notice/morph 各一份）⇒ 第二张只能是「重定位上一张」；
//   ② 纸窃取了面板级 live 输入槽 ⇒ 坞即便渲染出来，读到的也是纸上的字；
//   ③ 「纸在场 ⇒ 坞整只不渲染」⇒ 不能跟任何已有会话说话。
//
// 现行语义（docs/plans/canvas-space/multi-draft-sheets.md）：
//   · 多张纸并列存在，**每张各有自己的题签与草稿槽**（`draft:<id>`）；
//   · **焦点独占**：只有焦点那张展开输入面并持有 live 输入；其余只留天头 + 题签一行；
//   · 点卷 / 点画布空白 ⇒ 焦点交回卷，**坞立刻回来**（纸留在画布上不动）；
//   · 点某张纸 ⇒ 焦点与 live 输入一并回到它（草稿原样还在）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text })),
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

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;
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
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => new Fake2dCtx(),
});

const { ChatCore } = await import('../src/app/chat/chat-core');
const { useCoreStore } = await import('../src/app/chat/core-instance');
const { useShellStore } = await import('../src/app/shell-store');
const { STREAM_REGION } = await import('../src/paper/space');
const { DraftSheet } = await import('../src/plugins/builtin/paper-shell/DraftSheet');
const { PaperPanel } = await import('../src/plugins/builtin/paper-shell/PaperPanel');
const { getCanvasStore } = await import('../src/state/canvas-store');
const { useCanvasViewStore } = await import('../src/state/canvas-view-store');
const { useDockStore } = await import('../src/state/dock-store');
const { draftInputKey, useDraftSheetStore } = await import('../src/state/draft-sheet-store');
const { usePresetStore } = await import('../src/state/preset-store');
const { getChatStore } = await import('../src/ui/chat-store');

const PANEL = 'draft-multi';
const W = 1600;
const H = 900;

describe('待题纸 · 多纸（① store 面：并列、独立、各自草稿槽）', () => {
  beforeEach(() => {
    useDraftSheetStore.getState().dismissAll();
    usePresetStore.setState({ selected: 'standard', error: null });
    getCanvasStore(PANEL).getState().clearCanvas();
    useCanvasViewStore.setState({ view: { zoom: 1, panX: 0, panY: 0 }, canvasSize: { w: W, h: H } });
  });

  it('摊开两次 = 两张纸，各自一条记录，焦点在最新那张', () => {
    const a = useDraftSheetStore.getState().openSheet();
    const b = useDraftSheetStore.getState().openSheet();
    const st = useDraftSheetStore.getState();
    expect(st.papers.map((p) => p.id)).toEqual([a, b]);
    expect(a).not.toBe(b);
    expect(st.focusedId).toBe(b);
    // 两张纸的题签是各自的记录（不是共享一份）
    expect(st.papers[0]!.picks).toBeNull();
    expect(st.papers[1]!.picks).toBeNull();
  });

  it('题签 / 失败原因按纸写：写一张不动另一张', () => {
    const a = useDraftSheetStore.getState().openSheet({ presetId: 'standard' });
    const b = useDraftSheetStore.getState().openSheet({ presetId: 'creator' });
    const st = useDraftSheetStore.getState();
    st.setNotice('组合「x」不在册', a);
    st.setPicks({ presetId: 'creator', providerName: 'p', model: 'm', thinking: undefined }, b);

    const after = useDraftSheetStore.getState();
    expect(after.papers.find((p) => p.id === a)?.notice).toBe('组合「x」不在册');
    expect(after.papers.find((p) => p.id === a)?.picks).toBeNull();
    expect(after.papers.find((p) => p.id === b)?.notice).toBeNull();
    expect(after.papers.find((p) => p.id === b)?.picks).toMatchObject({ presetId: 'creator', model: 'm' });
  });

  it('弃一张只撤那一张，焦点落到 null（不误伤另一张）', () => {
    const a = useDraftSheetStore.getState().openSheet();
    const b = useDraftSheetStore.getState().openSheet();
    useDraftSheetStore.getState().dismissOne(b);
    const st = useDraftSheetStore.getState();
    expect(st.papers.map((p) => p.id)).toEqual([a]);
    expect(st.focusedId).toBeNull();
  });

  it('focusSheet 拿回焦点；未知 id 当作「焦点交回卷」', () => {
    const a = useDraftSheetStore.getState().openSheet();
    useDraftSheetStore.getState().openSheet();
    useDraftSheetStore.getState().focusSheet(a);
    expect(useDraftSheetStore.getState().focusedId).toBe(a);
    useDraftSheetStore.getState().focusSheet('dp-nope');
    expect(useDraftSheetStore.getState().focusedId).toBeNull();
  });
});

describe('待题纸 · 多纸（② 焦点与输入槽：纸不再窃取面板 live 槽）', () => {
  let panel: ChatCore | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    useShellStore.setState({ projectPath: 'D:/draft-multi-ws' });
    useDraftSheetStore.getState().dismissAll();
    getCanvasStore(PANEL).getState().clearCanvas();
    useCanvasViewStore.setState({ view: { zoom: 1, panX: 0, panY: 0 }, canvasSize: { w: W, h: H } });
  });

  afterEach(() => {
    useDraftSheetStore.getState().dismissAll();
  });

  it('focusDraft 把 live 输入交给那张纸；切回卷时纸上的字存回它自己的槽', async () => {
    panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const input = getChatStore(panel.panelId).input;
    const canvas = getCanvasStore(panel.panelId);
    canvas.getState().setRegion('1', { anchorX: 300, anchorY: 400, width: STREAM_REGION.width });
    getChatStore(panel.panelId).sess.setState({
      sessions: [{ id: 1, label: '卷一' }],
      activeIdx: 0,
      nextSessionId: 2,
    });
    // 先进卷：live 槽归 s:1
    input.getState().claimLive('s:1');
    input.getState().setInputText('给卷一的话');

    const paperId = useDraftSheetStore.getState().openSheet();
    await act(async () => {
      panel!.focusDraft(paperId);
    });
    expect(input.getState().liveOwner).toBe(draftInputKey(paperId));
    // 纸的输入框是空的（没继承刚才那句话）
    expect(input.getState().inputText).toBe('');
    input.getState().setInputText('给这张纸的话');

    // 点回卷一：纸上的字存回它自己的槽，live 换回卷一的字
    await act(async () => {
      panel!.switchSession(0);
    });
    useDraftSheetStore.getState().focusSheet(null);
    input.getState().claimLive('s:1');

    expect(input.getState().liveOwner).toBe('s:1');
    expect(input.getState().inputText).toBe('给卷一的话');
    expect(input.getState().sessionDrafts[draftInputKey(paperId)]?.inputText).toBe('给这张纸的话');
    expect(useDraftSheetStore.getState().focusedId).toBeNull();
  });

  it('dismissDraft：弃纸时把它的草稿槽一并清掉，不留给下次复活', async () => {
    panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const input = getChatStore(panel.panelId).input;
    getChatStore(panel.panelId).sess.setState({
      sessions: [{ id: 1, label: '卷一' }],
      activeIdx: 0,
      nextSessionId: 2,
    });
    const paperId = useDraftSheetStore.getState().openSheet();
    await act(async () => {
      panel!.focusDraft(paperId);
    });
    input.getState().setInputText('还没发出去的字');
    await act(async () => {
      panel!.dismissDraft(paperId);
    });
    expect(useDraftSheetStore.getState().papers).toHaveLength(0);
    expect(input.getState().sessionDrafts[draftInputKey(paperId)]).toBeUndefined();
    // 输入交回活跃卷（不是留在纸的空槽里）
    expect(input.getState().liveOwner).toBe('s:1');
  });
});

describe('待题纸 · 多纸（③ 组件面：坞回来 / 焦点可换）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    useDraftSheetStore.getState().dismissAll();
    usePresetStore.setState({ selected: 'standard', error: null });
    getCanvasStore(PANEL).getState().clearCanvas();
    useCanvasViewStore.setState({ view: { zoom: 1, panX: 0, panY: 0 }, canvasSize: { w: W, h: H } });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useDraftSheetStore.getState().dismissAll();
  });

  it('两张纸 = 两张 DOM；**只有焦点那张**展开输入面，另一张只留一行去处', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    container = el;
    await act(async () => {
      root = createRoot(el);
      root.render(<DraftSheet core={{ panelId: PANEL }} />);
    });
    let a = '';
    let b = '';
    await act(async () => {
      a = useDraftSheetStore.getState().openSheet();
      b = useDraftSheetStore.getState().openSheet();
    });
    await act(async () => {});

    const sheets = el.querySelectorAll('[data-draft-sheet]');
    expect(sheets).toHaveLength(2);
    const focusedEl = el.querySelector('[data-draft-sheet][data-focused="true"]') as HTMLElement | null;
    expect(focusedEl?.getAttribute('data-paper-id')).toBe(b);
    // 非焦点那张只有一行去处（可点回焦点），没有第二套输入面
    const idle = el.querySelector(`[data-paper-id="${a}"] .pp-draft-idle`);
    expect(idle).not.toBeNull();
    expect(el.querySelectorAll('textarea')).toHaveLength(0); // 无 overlays 注册 ⇒ 没有输入面
  });

  it('点非焦点那张纸 = 把焦点还给它（多纸之间随时换回来）', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    container = el;
    const focusDraft = vi.fn((id: string) => useDraftSheetStore.getState().focusSheet(id));
    await act(async () => {
      root = createRoot(el);
      root.render(<DraftSheet core={{ panelId: PANEL, focusDraft }} />);
    });
    let a = '';
    await act(async () => {
      a = useDraftSheetStore.getState().openSheet();
      useDraftSheetStore.getState().openSheet();
    });
    await act(async () => {});

    const idleBtn = el.querySelector(`[data-paper-id="${a}"] .pp-draft-idle`) as HTMLElement | null;
    expect(idleBtn).not.toBeNull();
    await act(async () => {
      idleBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(focusDraft).toHaveBeenCalledWith(a);
    expect(useDraftSheetStore.getState().focusedId).toBe(a);
  });
});

describe('待题纸 · 多纸（④ 端到端：纸在画布上时，坞照常可用）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/draft-multi-ws' });
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

  async function mountPanel(): Promise<HTMLDivElement> {
    const el = document.createElement('div');
    document.body.appendChild(el);
    await act(async () => {
      root = createRoot(el);
      root.render(<PaperPanel />);
    });
    return el;
  }

  it('坞的让位判据 = **焦点在纸上**：点卷把焦点交回去后，坞槽立刻回到画布', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const canvas = getCanvasStore(panel.panelId);
    canvas.getState().setRegion('1', { anchorX: 300, anchorY: 400, width: STREAM_REGION.width });
    getChatStore(panel.panelId).sess.setState({
      sessions: [{ id: 1, label: '卷一' }],
      activeIdx: 0,
      nextSessionId: 2,
    });
    const view = useCanvasViewStore;
    view.getState().setCanvasSize(W, H);
    view.getState().restoreView({ zoom: 1, panX: 0, panY: 0 });

    container = await mountPanel();
    await act(async () => {
      view.getState().setCanvasSize(W, H);
    });
    await act(async () => {
      view.getState().setView({ zoom: 1, panX: 0, panY: 0 });
    });

    // 焦点头落在卷上：坞槽在场
    expect(container.querySelector('.pp-composer-slot')).not.toBeNull();

    // 摊一张纸并拿焦点 ⇒ 坞让位（纸上那枚输入面接管输入）
    let paperId = '';
    await act(async () => {
      paperId = useDraftSheetStore.getState().openSheet();
      panel.focusDraft(paperId);
    });
    expect(container.querySelector('.pp-composer-slot')).toBeNull();

    // **用户报的那一步**：回头点已有会话（卷）⇒ 焦点交回，坞立刻回来
    await act(async () => {
      useDraftSheetStore.getState().focusSheet(null);
      getChatStore(panel.panelId).input.getState().claimLive('s:1');
    });
    expect(container.querySelector('.pp-composer-slot')).not.toBeNull();
    // 纸仍在画布上（没有被"交互卷"这件事顺手销毁）
    expect(useDraftSheetStore.getState().papers.map((p) => p.id)).toEqual([paperId]);
    expect(container.querySelector(`[data-paper-id="${paperId}"]`)).not.toBeNull();
  });
});

describe('待题纸 · ③b 点纸**里面**不许把焦点交回卷（2026-11-17 真机 bug）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/draft-multi-ws' });
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

  /* 真机病灶（用户："点题签的输入框之后直接跳到无法打字的状态"）：
   * mousedown 从纸里的输入件冒泡到 `.pp-canvas`（React 合成事件走根委托），画布那条
   * 「点空白 = 焦点离开纸」的判据**没看事件源** ⇒ 当帧清掉焦点 ⇒ `ComposerSheet` 卸载
   * ⇒ 用户刚点中的那个 textarea 消失。修法 = 判据排除 `[data-draft-sheet]` 子树。
   *
   * 本测挂真 PaperPanel，走同一条冒泡链：在纸内的一个真实节点上派发 mousedown。 */
  it('在纸内按下（冒泡到画布）⇒ 焦点不动；在纸外按下 ⇒ 焦点交回', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const canvas = getCanvasStore(panel.panelId);
    canvas.getState().setRegion('1', { anchorX: 300, anchorY: 400, width: STREAM_REGION.width });
    getChatStore(panel.panelId).sess.setState({
      sessions: [{ id: 1, label: '卷一' }],
      activeIdx: 0,
      nextSessionId: 2,
    });
    const view = useCanvasViewStore;
    view.getState().setCanvasSize(W, H);
    view.getState().restoreView({ zoom: 1, panX: 0, panY: 0 });

    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      (root as Root).render(<PaperPanel />);
    });
    await act(async () => {
      view.getState().setCanvasSize(W, H);
    });
    await act(async () => {
      view.getState().setView({ zoom: 1, panX: 0, panY: 0 });
    });

    // 摊一张纸并拿焦点
    let paperId = '';
    await act(async () => {
      paperId = useDraftSheetStore.getState().openSheet();
      panel.focusDraft(paperId);
    });
    expect(useDraftSheetStore.getState().focusedId).toBe(paperId);

    // ① 纸内的一个真实节点（天头版心）上按下 —— 事件冒泡到 .pp-canvas
    const inside = container.querySelector(`[data-paper-id="${paperId}"] .pp-folio-inner`) as HTMLElement | null;
    expect(inside).not.toBeNull();
    await act(async () => {
      inside!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    expect(useDraftSheetStore.getState().focusedId).toBe(paperId); // 焦点没被偷走

    // ② 在画布空白上按下 —— 焦点交回卷（坞随之回来）
    const canvasEl = container.querySelector('.pp-canvas') as HTMLElement | null;
    expect(canvasEl).not.toBeNull();
    await act(async () => {
      canvasEl!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    expect(useDraftSheetStore.getState().focusedId).toBeNull();
    // 纸仍在画布上（不是被销毁，只是让出焦点）
    expect(useDraftSheetStore.getState().papers.map((p) => p.id)).toEqual([paperId]);
  });
});
