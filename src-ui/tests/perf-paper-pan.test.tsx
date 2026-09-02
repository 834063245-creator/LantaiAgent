// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 画布拖动卡顿（2026-09-02 用户实机：1-3 卷 × 几十块仍卡）——每帧成本测量台。
// 挂真实 PaperPanel（穿全层：ChatMessage[] → translate → SourcedBlock[] →
// 注疏渲染），以 setView 模拟平移每帧（生产路径 = mousemove 累积 → rAF 合帧
// 一次 setView，本台直驱 setView 等价于合帧后的一帧）。
//
// 断言 = 确定性计数，不做时间断言：jsdom 装**可数假 2d ctx**，数平移期的
// fillRect 次数——小地图墨迹层（MinimapView）的每帧全量重画是「卡卡的」的
// 结构性根因之一（P2-3 修复前：activeRegion 引用每帧换 → 活跃卷全部块逐
// bar 重画），修复后平移帧 0 次（内容/几何变化仍即时重画——由挂载期重画
// 与平移期归零的对比保证）。时间数字随行报告（本机有并行负载，时间噪音
// 大——曾测得原始码 5-10.8ms 随机漂移，不构成可靠红绿信号）。

import { act, Profiler } from 'react';
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
  // ink.ts 消费面（假 2d ctx 让墨迹循环真实跑起来，fillRect 才可数）——
  // walkLineRanges 产一行、materializeLineRange 给定宽，保证 bars 非空
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _mock: true })),
  walkLineRanges: vi.fn((_prepared: unknown, _width: number, cb: (l: unknown) => void) => {
    cb({ start: 0, end: 1, width: 100 });
  }),
  materializeLineRange: vi.fn(() => ({ width: 100, text: 'mock' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: richStatsMock,
}));

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

// jsdom 无 Canvas 2D → 可数假 ctx（fillRect 计数 = 墨迹重画的确定性红绿信号）。
const inkStats = { fillRect: 0 };
class Fake2dCtx {
  fillStyle = '';
  setTransform(): void {}
  clearRect(): void {}
  fillRect(): void {
    inkStats.fillRect++;
  }
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
import { panBy } from '../src/paper/canvas-math';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

/* ── 真实 message-model 形状（paper-core.test 同款构造）── */
function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}
function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}
/** 一卷 ≈ 30 轮 × 4 块（user/reasoning/markdown/tool）≈ 120 块——长卷实机形态。
 *  块数放大计数信号：修复前每帧全量重画 ≈ 每块 1 次 fillRect，60 帧 × 3 卷
 *  × 120 块 ≈ 2.2 万次；修复后 0——判别差距五个数量级。 */
function volumeMessages(sid: number, turns = 30): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = 0; t < turns; t++) {
    out.push(
      userMsg(`u${sid}-${t}`, `第 ${t} 轮提问——量一段足够长的来文文本以贴近真实对话的长度与密度。`),
      asstMsg(`a${sid}-${t}`, [
        { type: 'reasoning', text: `思考第 ${t} 轮：先定位再动手，检查相关路径与既有约定。`, finalised: true },
        { type: 'text', text: `结论第 ${t} 轮：改了三处，分别对应边界、缓存与回落。`, finalised: true },
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

describe('画布平移零重画（perf 台）', () => {
  let panel: ChatCore;
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    // list_directory 必须返回 JSON 数组形状（返回 null 会触发契约告警噪音）
    mockInvoke.mockImplementation((_cmd: string, payload: any) => {
      const { method } = payload ?? {};
      if (method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/perf-ws' });
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

  it('3 卷 × 120 块：60 帧纯平移，小地图墨迹零重画（fillRect = 0）', async () => {
    panel = new ChatCore();
    useCoreStore.setState({ core: panel });

    // 3 卷会话 + 消息（user/assistant 交替，parts 顺序映射为块）
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({
      sessions: [
        { id: 1, label: '卷一' },
        { id: 2, label: '卷二' },
        { id: 3, label: '卷三' },
      ],
      activeIdx: 0,
      nextSessionId: 4,
    });
    for (const sid of [1, 2, 3]) {
      msgStoreFor(panel.panelId, sid).getState().setMessages(volumeMessages(sid));
    }
    const canvas = getCanvasStore(panel.panelId).getState();
    canvas.setRegion('1', { anchorX: 0, anchorY: 0, width: 720 });
    canvas.setRegion('2', { anchorX: 1000, anchorY: 0, width: 720 });
    canvas.setRegion('3', { anchorX: 2000, anchorY: 0, width: 720 });

    const view = useCanvasViewStore;
    view.getState().setCanvasSize(1200, 800);

    const frames: number[] = [];
    const onRender = (_id: string, _phase: string, actualDuration: number) => {
      frames.push(actualDuration);
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <Profiler id="paper-pan" onRender={onRender}>
          <PaperPanel />
        </Profiler>,
      );
    });

    // 挂载后的同步 effect 已 flush；RO 初始 0 尺寸写由直写 store 覆盖
    view.getState().setCanvasSize(1200, 800);

    const WARMUP = 5;
    const N = 60;
    for (let i = 0; i < WARMUP; i++) {
      await act(async () => {
        view.getState().setView((v) => panBy(v, 6, 4));
      });
    }
    // 预热期重画不算账（挂载期布局核心构建/首帧内容重画是合法的）——
    // 归零后只统计纯平移段：此段内容/几何零变化 = 墨迹层零重画。
    inkStats.fillRect = 0;
    for (let i = 0; i < N; i++) {
      await act(async () => {
        view.getState().setView((v) => panBy(v, 6, 4));
      });
    }

    const measured = frames.slice(-N);
    const avg = measured.reduce((a, b) => a + b, 0) / Math.max(1, measured.length);
    const sorted = [...measured].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    console.log(
      `[PAN-PERF] commits=${measured.length} avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms fillRect=${inkStats.fillRect}`,
    );

    // 确定性断言：纯平移段墨迹层零重画（每帧全量重画源回潮即红）
    expect(inkStats.fillRect).toBe(0);
  }, 60_000);
});
