// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 新建卷的两面（2026-09-10 用户两问）——用户操作序列：案卷侧边栏「新建」
// （createNewSession → requestFocus）→ 新卷摊在画布上 → 视角带到它眼前。
//
// ① 视角导航：落位 effect（useRegionPlacement）与 pendingFocus effect
//   （usePaperFocus）在**同一提交**内先后跑——守卫读 canvas-store（落位已写入
//   spread），飞行目标读 regionsRef（本提交渲染期快照，新卷还没有 spread →
//   defaultRegionFor(i) 网格占位）→ 视角飞向网格占位而非真落位。
// ② 空卷流区几何：零块卷的 regionTop 取 Math.min 的 0 初值 = 世界原点——纸面
//   钉在原点（不是锚点），首句落墨后 regionTop 变首块顶才「归位」。
//
// 两条都在同一序列里可观测：断言「视角中心 = spread 真锚点」与「空卷纸面底缘
// = 锚点 + 72（STREAM_REGION 底距）」。挂真实 PaperPanel（paper-regionsref-wiring
// 同款 harness），jsdom 真实定时器 + rAF（飞行动画 240ms）。

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
  materializeLineRange: vi.fn(() => ({ width: 100, text: 'mock' })),
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

// jsdom 无 Canvas 2D → no-op 假 ctx（本测只读几何，不数墨迹）。
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

// jsdom 无 ResizeObserver（PaperPanel 挂载即炸）——no-op 桩（尺寸由测试直写 store）
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

// ⚠ jsdom 的 rAF 时间戳与 performance.now() **不同源**（实测：rAF 回调拿到
// 137.7ms，同期 performance.now() = 1885.2ms）——飞行动画 tick 的
// t = (now - t0)/240 恒为负 → ease 为负 → 视口逐帧反向外推、动画永不完
//（pending 永不清）。这是 jsdom 时钟缺陷不是产品行为（Chromium 两者同源），
// 但会让本测读到假症状——故替换成同源确定性 rAF（时间戳 = performance.now()）。
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
import { viewFocusRegion } from '../src/paper/canvas-math';
import { measureFolioHeadHeight } from '../src/paper/measure';
import { EMPTY_REGION_CONTENT_H } from '../src/paper/space';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

const W = 1200;
const H = 800;
/** 视口：世界中心 (4000, -1200)——与 defaultRegionFor(2) 网格占位 (3120, 0) 明确不同。 */
const VIEW = { zoom: 1, panX: W / 2 - 4000, panY: H / 2 - -1200 };
/** 已摊开两卷的真位置（y 同锚，x 相邻）。 */
const PLACED = { anchorY: -1200, width: 1440 };

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}
function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}
function turnMessages(sid: number, turns = 2): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = 0; t < turns; t++) {
    out.push(
      userMsg(`u${sid}-${t}`, `第 ${t} 轮提问——量一段足够长的来文文本以贴近真实对话的长度。`),
      asstMsg(`a${sid}-${t}`, [
        { type: 'reasoning', text: `思考第 ${t} 轮：先定位再动手。`, finalised: true },
        { type: 'text', text: `结论第 ${t} 轮：改了三处。`, finalised: true },
      ]),
    );
  }
  return out;
}

describe('新建卷：落位几何 + 视角导航', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/newvol-ws' });
    useDockStore.getState().closePanel('paper');
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
  });

  it('新建卷：视角带到真落位（spread 锚点）；空卷纸面底缘 = 锚点 + 72', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const canvas = getCanvasStore(panel.panelId);
    canvas.getState().setRegion('1', { anchorX: 0, ...PLACED });
    canvas.getState().setRegion('2', { anchorX: 1560, ...PLACED });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({
      sessions: [
        { id: 1, label: '卷一' },
        { id: 2, label: '卷二' },
      ],
      activeIdx: 1,
      nextSessionId: 3,
    });
    msgStoreFor(panel.panelId, 1).getState().setMessages(turnMessages(1));

    const view = useCanvasViewStore;
    view.getState().setCanvasSize(W, H);
    view.getState().restoreView({ ...VIEW }); // 掐掉挂载期冷启动兜底聚焦与默认落锚

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
    // 挂载期 RO 直写 setCanvasSize(0,0)（jsdom clientWidth=0）——补真尺寸与目标视口
    await act(async () => {
      view.getState().setCanvasSize(W, H);
    });
    await act(async () => {
      view.getState().setView({ ...VIEW });
    });
    expect(view.getState().view).toEqual(VIEW);

    // ── 新建卷（SessionSidebar.onNew 序列：createNewSession → 读 sid → requestFocus）──
    await act(async () => {
      sess.setState((s) => ({ sessions: [...s.sessions, { id: 3, label: '案卷 3' }], activeIdx: 2 }));
      view.getState().requestFocus('3');
    });
    // 飞行动画 240ms 走完 + 落位 effect 续帧
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    // 落位：视口中心最近空位（两卷占 [-840, 2400]，中心 x=4000 即空）
    const placed = canvas.getState().spread['3'];
    expect(placed).toMatchObject({ anchorX: 4000, anchorY: -1200, width: 1440 });

    // ① 视角中心 = 真落位（不是 defaultRegionFor(2) 的网格占位 (3120, 0)）
    const v = view.getState().view;
    const target = viewFocusRegion(VIEW, W, H, { x: placed!.anchorX, y: placed!.anchorY });
    expect({ panX: v.panX, panY: v.panY }).toEqual({ panX: target.panX, panY: target.panY });
    expect(view.getState().pendingFocusId).toBeNull(); // 动画收尾清 pending（不吊着）

    // ② 纸面几何：空卷 = 一张贴在锚点上的纸——底缘 = 锚点 + 72（STREAM_REGION
    //    底距）、内容顶 = 锚点 − EMPTY_REGION_CONTENT_H、卷首在内容顶之上
    //    （旧 regionTop=0 → 纸钉在世界原点，底缘恒 72，与锚点无关：首句落墨
    //    才跳回锚点，量级 = 锚点距原点）
    const el = container.querySelector('.pp-region[data-session-id="3"]') as HTMLElement | null;
    expect(el).not.toBeNull();
    const folioH = measureFolioHeadHeight('案卷 3', placed!.width - 32);
    const top = Number.parseFloat(el!.style.top);
    const height = Number.parseFloat(el!.style.height);
    expect(top).toBeCloseTo(placed!.anchorY - EMPTY_REGION_CONTENT_H - folioH, 0);
    expect(height).toBeCloseTo(EMPTY_REGION_CONTENT_H + 72 + folioH, 0);
  });
});
