// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话树「枝」的**画布承接**守护（P3，立项件 `docs/plans/session-tree-plan.md` §5/§7）：
//   ① 边 = 一丝朱砂引线：**枝卷卷首 → 父卷的那个节点**——复用出处引导那一支笔
//      （`tetherAnchorsAt` + `tetherPath`：屏幕坐标 / 恒定墨宽 / 定种子相位 /
//      起笔留白 + 收笔朱点），**不新造一种线**；
//   ② 点引线 = 溯源：飞到父卷那个节点；
//   ③ 父节点不在视口内时线仍出屏（出处引导同款判据：锚点在世界里定、投到屏上落墨）。
//
// 挂真实 PaperPanel 穿全层（与 paper-viewport-ux ⑪ 同 harness）。`core.branchEdge` 是
// 零 I/O 的读面（血缘在卷日志头行里，attach 时已带入内存）——本文件把它钉在**几何与
// 交互**上；`branchEdge` 自身的行为（真卷头行 → 父卷节点）由 tests/session-branch.test.ts
// 用真卷 + 真日志钉住。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutMock, richStatsMock } = vi.hoisted(() => ({
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
  richStatsMock: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _mock: true })),
  walkLineRanges: vi.fn((_prepared: unknown, _width: number, cb: (l: unknown) => void) => {
    cb({ start: 0, end: 1, width: 100 });
  }),
  materializeLineRange: vi.fn(() => ({ width: 100, text: '行文缩微' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: richStatsMock,
}));

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

// jsdom 无 Canvas 2D → 假 ctx（InkLayer rAF 循环要跑，不数墨）
class Fake2dCtx {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textBaseline = '';
  textAlign = '';
  globalAlpha = 1;
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

// jsdom 无 ResizeObserver（PaperPanel 挂载即炸）——no-op 桩（尺寸由测试直写 store）
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

import { agentSessionState } from '../src/agent/agent-session-state';
import { createExecState } from '../src/agent/execution-state';
import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { worldToScreen } from '../src/paper/canvas-math';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}
function asstMsg(id: string, text: string, respondingTo: string): AssistantMessage {
  return {
    role: 'assistant',
    _id: id,
    parts: [{ type: 'text', text, finalised: true }],
    status: 'done',
    respondingTo,
  };
}
/** 两轮对话的最小卷（枝卷的前缀就是父卷的前缀——与真枝卷同形）。 */
function volume(sid: number, tag: string): ChatMessage[] {
  return [
    userMsg(`u${sid}-0`, `${tag}轮来文——足够长的一段，贴真实对话长度。`),
    asstMsg(`a${sid}-0`, `${tag}轮回复正文。`, `u${sid}-0`),
    userMsg(`u${sid}-1`, `第二轮来文。`),
    asstMsg(`a${sid}-1`, `第二轮回复。`, `u${sid}-1`),
  ];
}

describe('会话树「枝」的画布承接（P3：枝边引线 + 点线溯源）', () => {
  let panel: ChatCore;
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let branchEdgeSpy: ReturnType<typeof vi.spyOn> | null = null;
  let branchOriginSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/branch-canvas-ws' });
    useDockStore.getState().closePanel('paper');
    useCanvasViewStore.setState({
      view: { panX: 0, panY: 0, zoom: 1 },
      canvasSize: { w: 800, h: 600 },
      restoredView: null,
      pendingFocusId: null,
    });
  });

  afterEach(() => {
    if (root) {
      void act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    branchEdgeSpy?.mockRestore();
    branchEdgeSpy = null;
    branchOriginSpy?.mockRestore();
    branchOriginSpy = null;
  });

  /** 挂两卷（父卷 1 在 x=0、枝卷 2 在 x=2000——远隔，引线必然横跨）。
   *  `edgeNode` 非空 = 桩上「卷 2 是卷 1 的枝，分叉节点 = 该消息」这条边
   *  （**挂载前**桩——`branchEdges` 是 memo，挂载后改桩不会重算）。 */
  async function mountTwoVolumes(edgeNode: string | null): Promise<HTMLDivElement> {
    panel = new ChatCore();
    if (edgeNode) {
      branchEdgeSpy = vi
        .spyOn(panel, 'branchEdge')
        .mockImplementation((sid: number) => (sid === 2 ? { parentSid: 1, nodeMessageId: edgeNode } : null));
      branchOriginSpy = vi
        .spyOn(panel, 'branchOrigin')
        .mockImplementation((sid: number) => (sid === 2 ? { id: 1, atSeq: 2 } : null));
    }
    useCoreStore.setState({ core: panel });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({
      sessions: [
        { id: 1, label: '父卷' },
        { id: 2, label: '枝卷' },
      ],
      activeIdx: 1,
      nextSessionId: 3,
    });
    msgStoreFor(panel.panelId, 1).getState().setMessages(volume(1, '父'));
    msgStoreFor(panel.panelId, 2).getState().setMessages(volume(2, '父'));
    const canvas = getCanvasStore(panel.panelId).getState();
    canvas.setRegion('1', { anchorX: 0, anchorY: 0, width: 720 });
    canvas.setRegion('2', { anchorX: 2000, anchorY: 0, width: 720 });

    const view = useCanvasViewStore;
    view.getState().setCanvasSize(1200, 800);
    // 视口偏向**枝卷**一侧：枝卷的卷首（眉行的「枝」标）在渲染面，父卷整卷在屏外但仍在
    // 卸载余量之内（几何照旧在场——引线仍画得出，正是「父节点不在视口内」那条判据）。
    view.getState().restoreView({ zoom: 1, panX: -1000, panY: 600 });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
    await act(async () => {
      view.getState().setCanvasSize(1200, 800);
    });
    await act(async () => {
      view.getState().setView((v) => ({ ...v, zoom: 1, panX: -1000, panY: 600 }));
    });
    const el = container.querySelector<HTMLDivElement>('.pp-canvas');
    if (!el) throw new Error('pp-canvas 未挂载');
    el.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 1200,
        bottom: 800,
        width: 1200,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    return el;
  }

  /** 父卷那个节点块的**世界几何**（渲染面真值：流块的 transform = 布局位 + 宽度）。 */
  function parentNodeGeom(nodeMessageId: string): { x: number; y: number; w: number } {
    const el = container?.querySelector<HTMLElement>(
      `.pp-block[data-session-id="1"][data-message-id="${nodeMessageId}"]`,
    );
    if (!el) throw new Error('父卷节点块不在场');
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform);
    if (!m) throw new Error('块位读不出来');
    return { x: Number(m[1]), y: Number(m[2]), w: Number.parseFloat(el.style.width) };
  }

  /** 枝卷流区左缘（世界 x——卷首中线所在的那条竖线的横位；真源 = 画布落位）。 */
  function childRegionLeft(): number {
    const region = getCanvasStore(panel.panelId).getState().spread['2'];
    if (!region) throw new Error('枝卷未落位');
    return region.anchorX - region.width / 2;
  }

  it('无枝边不落笔：不是枝卷就没有引线（不误画一条凭空的线）', async () => {
    await mountTwoVolumes(null);
    // 2026-09-22 版口引线批：屏上从此恒有一条**常显**的版口引线（坞 → 活卷），
    // 故本档判据按**腿**收窄（.pp-branch-layer）——「无枝边不落笔」说的是枝这条腿。
    expect(container?.querySelector('.pp-branch-tether')).toBeNull();
    expect(container?.querySelector('.pp-branch-layer')).toBeNull();
    // 卷首眉行也不缀「枝」（根卷）
    const eyebrow = container?.querySelector('.pp-folio-eyebrow')?.textContent ?? '';
    expect(eyebrow).not.toContain('枝');
  }, 30_000);

  it('卷首标「枝」：有父卷的卷眉行缀「枝」（与侧栏/书脊同一枚标，血缘读面零 I/O）', async () => {
    await mountTwoVolumes('a1-1');
    const eyebrows = [...(container?.querySelectorAll('.pp-folio-eyebrow') ?? [])].map((e) => e.textContent);
    // 枝卷 2 的卷首在案头（父卷 1 在视口外 ⇒ 只有它在渲染面），眉行缀「枝」
    expect(eyebrows.some((t) => (t ?? '').includes('枝'))).toBe(true);
  }, 30_000);

  it('枝边引线常显：起笔在枝卷卷首左缘、收笔朱点落在**父卷那个节点**的缘上', async () => {
    // 分叉节点取父卷**末条回复**（贴锚点 ⇒ 在视口内的流窗里，几何可从渲染面读回）
    await mountTwoVolumes('a1-1');
    const path = container?.querySelector('.pp-branch-tether');
    expect(path).not.toBeNull();
    const v = useCanvasViewStore.getState().view;
    const node = parentNodeGeom('a1-1');
    const left = childRegionLeft();

    // 笔道是手绘 path（不是 <line>）：起笔落在**枝卷卷首左缘**的投影上
    // （净空优先：父卷在枝卷左侧 ⇒ 取枝卷左缘；起笔再沿弦内缩 TETHER_GAP 6px
    //  ⇒ 略偏向父节点一侧，故取 [edge-12, edge] 这一档）
    const m = /^M (-?[\d.]+) (-?[\d.]+)/.exec(path?.getAttribute('d') ?? '');
    expect(m).not.toBeNull();
    const edgeX = worldToScreen(v, left, 0).x;
    expect(Number(m?.[1])).toBeLessThanOrEqual(edgeX);
    expect(Number(m?.[1])).toBeGreaterThan(edgeX - 12);

    // 收笔朱点 = 父卷那个节点的**右缘中线**（节点在枝卷左侧 ⇒ 取节点右缘）——
    // 指「那个节点」，不是「父卷」这个整体
    const bead = container?.querySelector('.pp-branch-layer .pp-tether-bead');
    expect(bead).not.toBeNull();
    expect(Number(bead?.getAttribute('cx'))).toBeCloseTo(worldToScreen(v, node.x + node.w, 0).x, 6);
  }, 30_000);

  it('点引线 = 溯源：飞到父卷那个节点（视口对准父卷中轴）', async () => {
    await mountTwoVolumes('a1-1');
    const hit = container?.querySelector('.pp-tether-hit');
    expect(hit).not.toBeNull();
    const before = useCanvasViewStore.getState().view;
    await act(async () => {
      (hit as Element).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400)); // 飞行 240ms
    });
    const after = useCanvasViewStore.getState().view;
    // 父卷在 x=0（流区中轴）⇒ 视口宽 1200 的中心对到它
    expect(after.panX).toBeCloseTo(600, 3);
    // 纵向确实飞了（父节点在父卷流内，不在当前视野）
    expect(Math.abs(after.panY - before.panY)).toBeGreaterThan(1);
  }, 30_000);

  it('父节点不在视口内：线照样出屏（锚点在世界里定、投到屏上落墨）', async () => {
    await mountTwoVolumes('a1-1');
    // 把视口挪到枝卷一侧：父卷整个在屏外，但仍在**卸载余量**（STUB_MX 900）之内
    // ⇒ 几何照旧在场，线出屏（方向即来路）
    await act(async () => {
      useCanvasViewStore.getState().setView((v) => ({ ...v, panX: -1100 }));
    });
    expect(container?.querySelector('.pp-branch-tether')).not.toBeNull();
    const bead = container?.querySelector('.pp-branch-layer .pp-tether-bead');
    expect(Number(bead?.getAttribute('cx'))).toBeLessThan(0); // 朱点在屏外——线出屏，方向即来路
  }, 30_000);

  it('句柄迟到（冷启动后台水合）⇒ 引线随之出现（枝边读面订阅 agentSessionState）', async () => {
    // 真机机理：冷启动批量恢复不造句柄，参与枝边的卷由后台水合补上 ⇒ `branchEdge`
    // 一开始返回 null（无句柄），句柄落定后才有值。枝边 memo 必须吃这个信号重算，
    // 否则重启后引线永远不出现（2026-09-19 真机报）。
    await mountTwoVolumes(null);
    expect(container?.querySelector('.pp-branch-tether')).toBeNull();

    // 句柄到位：桩上边 + 一次 agentSessionState 变更（= setAgent 的 bump，冷启动水合的等价物）
    branchEdgeSpy = vi
      .spyOn(panel, 'branchEdge')
      .mockImplementation((sid: number) => (sid === 2 ? { parentSid: 1, nodeMessageId: 'a1-1' } : null));
    branchOriginSpy = vi
      .spyOn(panel, 'branchOrigin')
      .mockImplementation((sid: number) => (sid === 2 ? { id: 1, atSeq: 2 } : null));
    await act(async () => {
      agentSessionState.setExec(panel.panelId, 2, createExecState());
    });
    await act(async () => {});
    expect(container?.querySelector('.pp-branch-tether')).not.toBeNull();
  }, 30_000);
});
