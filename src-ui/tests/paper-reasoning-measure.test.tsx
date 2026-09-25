// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 夹注块高：实测回写族 + 渲染态签名（2026-09-19 夹注叠字批）。
//
// 真机病灶：用户报「夹注块展开时常与脚注块叠字」。真浏览器复算（936 条真会话
// 夹注 + 真 CSS + 真 measure）：canvas 折行与 DOM 折行在「半角标点 + 拉丁/汉字」
// 处每行差 0.1~1.2px（逐字对拍：`,C` 一步 DOM 比 canvas 宽 0.518px、`,X` 窄
// 0.115px——text-autospace 已钉 no-autospace，残余无 CSS 开关可关），长夹注
// （真会话 1000~1700 行）逐行累积成 ±1~6 行：27% 的块高有差，正方向最大
// +49px > 单元内间距 32px ⇒ 末行压到下一块脚注上。唯一出路 = 挂载后实测回写。
//
// jsdom 无排版（量不出真高），故本文件考的是**接线契约**——三段连起来的链：
//   ① 判据：夹注进实测族（needsObservedHeight('reasoning') === true）；
//   ② 键：壳层 data-block-observed = observedKeyOf（块 id + 渲染态），折叠翻转
//      换键（展开态不吃折叠态的读数）；
//   ③ 消费：按同一个键回写 → measureBlockHeightCached 采用（两端键同源）。
// 真排版下的数值证据在真 Chrome 复算台架（prototype/ 为本地证据区，不入库）：
// 936 条真会话夹注，补丁前 4 块叠入下一块脚注 17.94px → 补丁后 0 块。

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

// jsdom 无 ResizeObserver（PaperPanel 挂载即炸）——no-op 桩（尺寸由测试直写 store；
// 本测考的是「谁被登记观察」，观测回调本身不在 jsdom 里发生）。
const observedTargets: Element[] = [];
class FakeResizeObserver {
  observe(el: Element): void {
    observedTargets.push(el);
  }
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import {
  clearObservedBlockHeights,
  measureBlockHeightCached,
  observedBlockHeightOf,
  observedKeyOf,
} from '../src/plugins/builtin/paper-shell/measure';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

const W = 1200;
const H = 800;

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}
function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}
/** 真机形状：一轮 = 来文 → 夹注（thinking）→ 脚注（工具卡）。夹注后继非正文，
 *  故走独立 reasoning 块（translate 的回退路径——正是用户报的那种相邻关系）。 */
function turnMessages(): ChatMessage[] {
  return [
    userMsg('u1', '查一下这个重叠问题——来文写长一点贴近真实对话。'),
    asstMsg('a1', [
      { type: 'reasoning', text: '先量 DOM 再看测高：折行点分歧会累积成块高差。', finalised: true },
      {
        type: 'tool',
        toolId: 't1',
        name: 'read_file',
        label: '读文件',
        args: JSON.stringify({ file_path: 'D:/ws/a.ts' }),
        output: 'const a = 1;',
        status: 'done',
      },
    ]),
  ];
}

describe('夹注实测回写接线（2026-09-19 叠字批）', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    observedTargets.length = 0;
    clearObservedBlockHeights();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/jiazhu-ws' });
    useCanvasViewStore.getState().setCanvasSize(W, H);
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

  /** 挂真 PaperPanel 穿全层（paper-new-volume 同款 harness）。 */
  async function mount(): Promise<HTMLElement> {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({ sessions: [{ id: 1, label: '卷一' }], activeIdx: 0, nextSessionId: 2 });
    msgStoreFor(panel.panelId, 1).getState().setMessages(turnMessages());
    getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: 0, anchorY: 0, width: 1440 });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
    // 视口尺寸由测试直写（jsdom 无 RO；挂载期 RO 直写 setCanvasSize(0,0)）——
    // 渲染后再钉一次真尺寸与目标视口（paper-new-volume 同款）。
    await act(async () => {
      useCanvasViewStore.getState().setCanvasSize(W, H);
    });
    await act(async () => {
      useCanvasViewStore.getState().setView({ zoom: 1, panX: W / 2, panY: H / 2 });
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container;
  }

  it('夹注块带 data-block-observed（进实测族）；脚注块不带（工具卡载荷封顶，静态镜像够用）', async () => {
    const el = await mount();
    const blocks = [...el.querySelectorAll<HTMLElement>('.pp-block')];
    const reasoning = blocks.find((b) => b.classList.contains('pp-reasoning'));
    const tool = blocks.find((b) => b.classList.contains('pp-tool'));
    expect(reasoning, '夹注块未渲染').toBeTruthy();
    expect(tool, '脚注块未渲染').toBeTruthy();
    // 键 = 块 id + 渲染态（夹注缺省折叠 → flow|f1s1o0）
    const key = reasoning?.dataset.blockObserved ?? '';
    expect(key).toContain('|flow|f1');
    expect(observedTargets).toContain(reasoning);
    expect(tool?.dataset.blockObserved).toBeUndefined();
  });

  it('展开夹注：观测键的渲染态位翻转（展开态不吃折叠态读数）+ 同键回写被采用', async () => {
    const el = await mount();
    const reasoning = el.querySelector<HTMLElement>('.pp-block.pp-reasoning');
    if (!reasoning) throw new Error('夹注块未渲染');
    const collapsedKey = reasoning.dataset.blockObserved ?? '';
    expect(collapsedKey.endsWith('|flow|f1s1o0'), `缺省应折叠，实得 ${collapsedKey}`).toBe(true);

    // 用户点折叠行 → 展开
    const foldBtn = reasoning.querySelector<HTMLButtonElement>('.pp-fold');
    if (!foldBtn) throw new Error('折叠行未渲染');
    await act(async () => {
      foldBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const expandedKey = reasoning.dataset.blockObserved ?? '';
    expect(expandedKey.endsWith('|flow|f0s1o0'), `展开后应为 f0，实得 ${expandedKey}`).toBe(true);
    expect(expandedKey).not.toBe(collapsedKey);

    // 折叠态实测高不许被展开态消费（键不同）
    const block = { id: collapsedKey.split('|')[0], w: 619, kind: 'reasoning' as const };
    expect(observedBlockHeightOf(collapsedKey, block.w)).toBeUndefined();
    // 壳层按展开态键回写 → 测高按同一键取用（两端同源）
    const { reportObservedBlockHeight } = await import('../src/plugins/builtin/paper-shell/measure');
    reportObservedBlockHeight(expandedKey, block.w, 1234);
    expect(observedBlockHeightOf(expandedKey, block.w)).toBe(1234);
    expect(observedBlockHeightOf(collapsedKey, block.w)).toBeUndefined();
  });

  it('observedKeyOf 与壳层数据集同源（键格式不在两处手写）', async () => {
    const el = await mount();
    const reasoning = el.querySelector<HTMLElement>('.pp-block.pp-reasoning');
    if (!reasoning) throw new Error('夹注块未渲染');
    const datasetKey = reasoning.dataset.blockObserved ?? '';
    const [blockId, state] = datasetKey.split('|');
    expect(blockId).toMatch(/^pb:/);
    expect(state).toBe('flow');
    expect(datasetKey.endsWith('|flow|f1s1o0')).toBe(true);
    // 键只由 块 id + 渲染态 决定（折行点/宽度无关）
    expect(observedKeyOf({ id: blockId, state: 'flow' } as never, true, true, false)).toBe(datasetKey);
    // 展开态与折叠态是两条记录，互不冲刷
    const cache = { byId: new Map(), mdParse: new Map() };
    const b = {
      id: blockId,
      kind: 'reasoning' as const,
      payload: { text: '思考' },
      state: 'flow' as const,
      x: 0,
      y: 0,
      w: 619,
      source: { messageId: 'm', part: null },
    };
    const { reportObservedBlockHeight } = await import('../src/plugins/builtin/paper-shell/measure');
    reportObservedBlockHeight(observedKeyOf(b, false, true, false), b.w, 900);
    expect(measureBlockHeightCached(b, cache, false, true, false)).toBe(900);
    // 折叠态无记录 → 回落静态镜像（折叠行 + 一行预览），不是 900
    const collapsed = measureBlockHeightCached(b, cache, true, true, false);
    expect(collapsed).toBeLessThan(100);
  });
});
