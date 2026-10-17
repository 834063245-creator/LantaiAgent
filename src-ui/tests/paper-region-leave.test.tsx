// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷开合动效（2026-10-18 卷开合动效批 · 用户拍板「甲 · 入场 + 退场对称」）——
// **挂真实 PaperPanel 穿全层**的行为考官。考三件事：
//   ① 合卷 = **起纸**：区域与块**不当帧卸载**（`data-leaving` / `pp-leaving`），
//      窗满（`REGION_MOTION_MS` = `--m-sheet`）才真走；且离场卷**不进读数面**
//      （`regions` 保持活跃卷语义——小地图/目次带/引线不许被一个正在消失的卷撑一下）；
//   ② 窗内重开 = **撤销退场**（DOM 节点身份不变 = 不是拆了重挂，同 `dock-panel-leave`
//      的判据形态）；
//   ③ 重开卷**重播**落纸 + 墨律（`pp-spread` / `pp-enter`），且是一次性的
//      （虚拟化平移重挂不重放——故刻意不走 `@starting-style`）。
//
// harness 取自 paper-new-volume.test.tsx（真挂 PaperPanel + 直写 store 的既有范式）。

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

// jsdom 无 Canvas 2D → no-op 假 ctx（本测只读 DOM 结构，不数墨迹）。
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

// jsdom 无 ResizeObserver（PaperPanel 挂载即炸）——no-op 桩（尺寸由测试直写 store）。
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

// jsdom 的 rAF 时间戳与 performance.now() 不同源（paper-new-volume 有实测记录）——
// 换成同源确定性 rAF，免得飞行类 effect 读到负进度空转。
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
import { overlayServicePlugin } from '../src/composition/overlay-service';
import { Context } from '../src/cordis';
import { usePaperRegion } from '../src/paper/overlay-context';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { REGION_MOTION_MS } from '../src/plugins/builtin/paper-shell/region-motion';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

const W = 1200;
const H = 800;
/** 两卷都在视口内（离场窗要考「虚拟化不得半路裁掉」，故必须真可见）。 */
const VIEW = { zoom: 1, panX: 600, panY: 1600 };
const ANCHOR_Y = -1200;

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}
function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}
function turnMessages(sid: number): ChatMessage[] {
  return [
    userMsg(`u${sid}`, `第 ${sid} 卷提问——量一段足够长的来文文本。`),
    asstMsg(`a${sid}`, [
      { type: 'reasoning', text: `第 ${sid} 卷思考：先定位再动手。`, finalised: true },
      { type: 'text', text: `第 ${sid} 卷结论：改了三处。`, finalised: true },
    ]),
  ];
}

/** 假读数件（right-edge 覆盖层贡献）：把 `regionContext.regions` 落到 DOM——
 *  「离场卷只进渲染面、不进测量/读数面」的端到端证据。 */
function FakeRegionsReadout() {
  const { regions } = usePaperRegion();
  return <div className="probe-regions" data-sids={regions.map((r) => r.sessionId).join(',')} />;
}

describe('卷开合动效（落纸入场 + 起纸退场）', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let overlays: ReturnType<Context['plugin']> | null = null;
  let panel: ChatCore;

  beforeEach(async () => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    useShellStore.setState({ projectPath: 'D:/region-leave-ws' });
    useDockStore.getState().closePanel('paper');

    panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const canvas = getCanvasStore(panel.panelId);
    canvas.getState().setRegion('1', { anchorX: 0, anchorY: ANCHOR_Y, width: 1440 });
    canvas.getState().setRegion('2', { anchorX: 1000, anchorY: ANCHOR_Y, width: 1440 });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({
      sessions: [
        { id: 1, label: '卷一' },
        { id: 2, label: '卷二' },
      ],
      activeIdx: 0,
      nextSessionId: 3,
    });
    msgStoreFor(panel.panelId, 1).getState().setMessages(turnMessages(1));
    msgStoreFor(panel.panelId, 2).getState().setMessages(turnMessages(2));

    const view = useCanvasViewStore;
    view.getState().setCanvasSize(W, H);
    view.getState().restoreView({ ...VIEW });

    const ctx = new Context();
    const fiber = ctx.plugin(overlayServicePlugin);
    await fiber;
    ctx.overlays.register({ id: 'probe-regions', slot: 'right-edge', component: FakeRegionsReadout });
    overlays = fiber;
  });

  afterEach(async () => {
    if (root) {
      void act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    await overlays?.dispose();
    overlays = null;
  });

  async function mount(): Promise<HTMLElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
    const view = useCanvasViewStore;
    await act(async () => {
      view.getState().setCanvasSize(W, H);
    });
    await act(async () => {
      view.getState().setView({ ...VIEW });
    });
    return container;
  }

  /** 合卷（真写路径：`core.closeSession` 最终也只落 sess 表这一写）。 */
  async function collapse(id: number): Promise<void> {
    const sess = getChatStore(panel.panelId).sess;
    await act(async () => {
      sess.setState((s) => ({ sessions: s.sessions.filter((x) => x.id !== id), activeIdx: 0 }));
    });
  }
  /** 摊开（磁盘续开最终也只落 sess 表这一写）。 */
  async function spread(id: number): Promise<void> {
    const sess = getChatStore(panel.panelId).sess;
    await act(async () => {
      sess.setState((s) => ({
        sessions: [...s.sessions, { id, label: `卷${id}` }].sort((a, b) => a.id - b.id),
        activeIdx: 0,
        nextSessionId: Math.max(s.nextSessionId, id + 1),
      }));
    });
  }
  const region = (id: number): HTMLElement | null =>
    container?.querySelector(`.pp-region[data-session-id="${id}"]`) ?? null;

  it('合卷 = 起纸：当帧进离场窗（区域 + 块都还在），窗满才真卸载；离场卷不进读数面', async () => {
    await mount();
    expect(region(2)).not.toBeNull();

    await collapse(2);
    const ghost = region(2);
    expect(ghost, '合卷当帧就该进离场窗——不许当帧卸载').not.toBeNull();
    expect(ghost?.hasAttribute('data-leaving')).toBe(true);
    expect(ghost?.hasAttribute('inert'), '退场期不接点击/不进无障碍树').toBe(true);
    // 块是**兄弟层**（不在区域元素内）⇒ 起纸的墨由 pp-leaving 单独承载
    expect(container?.querySelectorAll('.pp-block.pp-leaving').length).toBeGreaterThan(0);
    // 读数面（regionContext.regions）当帧就看不见它了——离场卷只进渲染
    expect(container?.querySelector('.probe-regions')?.getAttribute('data-sids')).toBe('1');

    // 窗满 → 真卸载（等窗长 + 一帧余量）
    await act(async () => {
      await new Promise((r) => setTimeout(r, REGION_MOTION_MS + 150));
    });
    expect(region(2)).toBeNull();
    expect(container?.querySelectorAll('.pp-block.pp-leaving').length).toBe(0);
  }, 20_000);

  it('窗内重开 = 撤销退场（DOM 节点身份不变——不是拆了重挂）', async () => {
    await mount();
    await collapse(2);
    const ghost = region(2);
    expect(ghost?.hasAttribute('data-leaving')).toBe(true);

    await spread(2); // 窗内回场
    const back = region(2);
    expect(back).not.toBeNull();
    expect(back?.hasAttribute('data-leaving')).toBe(false);
    expect(back).toBe(ghost); // 同一节点：没有先拆后挂
  }, 20_000);

  it('重开卷重播落纸（pp-spread）+ 墨律（pp-enter）；落纸类是**窗**不是一帧，窗满即摘', async () => {
    await mount();
    // 先真走完退场窗
    await collapse(2);
    await act(async () => {
      await new Promise((r) => setTimeout(r, REGION_MOTION_MS + 150));
    });
    expect(region(2)).toBeNull();

    await spread(2);
    const back = region(2);
    expect(back, '重开卷该回到画布上').not.toBeNull();
    expect(back?.classList.contains('pp-spread'), '重开卷要重播落纸（纸淡入）').toBe(true);
    expect(
      container?.querySelectorAll('.pp-block.pp-enter[data-session-id="2"]').length,
      '重开卷要重播墨律（块 pp-enter）',
    ).toBeGreaterThan(0);

    /* 窗的判据（本批实测踩过的那一脚）：摊开卷之后同帧还会来好几趟重渲染（落位/焦点/
     * 测高回写），类**不许**被中途摘掉——按帧发放 = 浏览器根本没见到那个类。 */
    await act(async () => {
      useCanvasViewStore.getState().setView({ ...VIEW, panX: VIEW.panX + 1 });
    });
    expect(region(2)).not.toBeNull();
    expect(region(2)?.classList.contains('pp-spread'), '窗内的重渲染不得摘掉落纸类').toBe(true);

    // 窗满 → 摘类（动画已播完，摘类不可见）；且不二次落纸
    await act(async () => {
      await new Promise((r) => setTimeout(r, REGION_MOTION_MS + 150));
    });
    expect(region(2)).not.toBeNull();
    expect(region(2)?.classList.contains('pp-spread')).toBe(false);
  }, 20_000);
});
