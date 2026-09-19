// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸壳共享 ref 穿线回归（paper-panel-split 接线事故，2026-09-06）——
//
// 事故：拆解首版 use-paper-regions 自建了第二个 regionsRef，装配根手里的
// （喂给 InkLayer/拖块/飞行/键盘走卷的晚绑定读方）恒空——真机症状：LOD
// 缩远无墨 / 拖块找不到来源带心。
// 根治：regionsRef 单一 owner（装配根持有）经穿参进 use-paper-regions。
//
// 本测试钉的就是「晚绑定读方拿到的必须是真卷数据」：
//   ① InkLayer（LOD 墨迹）：rAF 直读 regionsRef 画墨——空 ref 零绘制。
//（原用例② 自动选中 settle 随 2026-09-10 拍板「浏览跟随退役」一并拆除。）
// 挂真实 PaperPanel 穿全层（perf-paper-pan 同款 harness），jsdom 真实定时器。

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

// jsdom 无 Canvas 2D → 可数假 ctx。fillRect 计数 = InkLayer 墨迹绘制信号
//（折叠块画桩条走 fillRect；fillText 也要 stub——正文真文字缩微走它）。
const inkStats = { fillRect: 0 };
class Fake2dCtx {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textBaseline = '';
  setTransform(): void {}
  clearRect(): void {}
  /** 基线半行距探针（InkLayer halfLeading 用 measureText 读字体正常行高）。 */
  measureText(): { width: number; fontBoundingBoxAscent: number; fontBoundingBoxDescent: number } {
    return { width: 100, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 5 };
  }
  fillRect(): void {
    inkStats.fillRect++;
  }
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

import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}
function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}
/** 一轮 4 块（user/reasoning/markdown/tool）——reasoning 恒折、tool done 折
 *  → 折叠块画桩条走 fillRect（本测试的可数墨迹信号）。 */
function turnMessages(sid: number, turns = 2): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = 0; t < turns; t++) {
    out.push(
      userMsg(`u${sid}-${t}`, `第 ${t} 轮提问——量一段足够长的来文文本以贴近真实对话的长度。`),
      asstMsg(`a${sid}-${t}`, [
        { type: 'reasoning', text: `思考第 ${t} 轮：先定位再动手。`, finalised: true },
        { type: 'text', text: `结论第 ${t} 轮：改了三处。`, finalised: true },
        {
          type: 'tool',
          toolId: `t${sid}-${t}`,
          name: 'read_file_content',
          label: '读文件',
          args: '{}',
          readOnly: true,
          status: 'done',
          output: 'abc',
        },
      ]),
    );
  }
  return out;
}

describe('纸壳共享 ref 穿线（paper-panel-split 接线事故回归）', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/regionsref-ws' });
    useDockStore.getState().closePanel('paper');
    inkStats.fillRect = 0;
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

  it('InkLayer（LOD 缩远墨迹）：rAF 直读的 regionsRef 必须有真卷——桩条绘制 > 0', async () => {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({ sessions: [{ id: 1, label: '卷一' }], activeIdx: 0, nextSessionId: 2 });
    msgStoreFor(panel.panelId, 1).getState().setMessages(turnMessages(1));
    getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: 0, anchorY: 0, width: 720 });

    const view = useCanvasViewStore;
    /* 模拟「已恢复视口的工作区」（restoreView 置位）：① 守恒首测不落默认锚；
     * ② 重挂清除 effect 不发 requestFocus——掐掉挂载期 240ms 视角飞行动画
     * 对测试视口的覆写（restoreView 随首个 setView 清除，语义合法）。
     * zoom 0.3：2026-09-20 接管阈下移到 0.36 后，0.5 已属 DOM 区（墨迹层不在场）
     * ——本用例考的是「regionsRef 穿线」，须落在墨迹真在画的档位。 */
    view.getState().setCanvasSize(1200, 800);
    view.getState().restoreView({ zoom: 0.3, panX: 600, panY: 450 });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });

    /* 挂载期 RO 直写 setCanvasSize(0,0)（jsdom clientWidth=0——perf-paper-pan
     * 同款坑）：测试直写 store 覆盖；守恒随之按新尺寸调整 pan——最后再摆
     * 一次目标视口（最终真源）。 */
    await act(async () => {
      view.getState().setCanvasSize(1200, 800);
    });
    await act(async () => {
      view.getState().setView((v) => ({ ...v, zoom: 0.3, panX: 600, panY: 450 }));
    });

    // rAF 帧跑起来（jsdom pretendToBeVisual ~16ms/帧）——空 regionsRef 时
    // InkLayer 零绘制（事故形态），真卷在册时折叠块桩条逐帧 fillRect。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(inkStats.fillRect).toBeGreaterThan(0);
  }, 30_000);
});
