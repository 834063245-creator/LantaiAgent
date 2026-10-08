// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 版心 = 纸半（2026-10-08「墨占纸半」重定）**行为测**——用户操作序列：
//   把流区拉宽/缩窄 → 流内块宽同比缩放；钉住块不随（钉在桌面上的纸片定格）。
//
// 规格（显式声明，2026-10-08）：流内块宽 = columnWidthFor(流区宽) ×（块基准宽 ÷ 720）
// ——真源 = measure.ts 的 COLUMN_RATIO / columnWidthFor。旧行为「宽流区不放宽（版心
// 封顶 720）」随本批退役（用户实机反馈「手动拉宽流区时内容宽度上限太低」）。
// 与 paper-folio-height.test.ts（卷首题字可用宽）互补：同一把尺子（版心宽）的正文侧。
// 钉值对映（源文本层）见 paper-visual-decisions 的「测量镜像」用例。
//
// harness 同 paper-regionsref-wiring（真实 PaperPanel 全层 + pretext 桩）。

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
  walkLineRanges: vi.fn((_p: unknown, _w: number, cb: (l: unknown) => void) => {
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
/** 一轮：来文 + 回复正文（两族块各带基准宽：来文 560 / 正文 720）。 */
function volume(tag: string): ChatMessage[] {
  const a: AssistantMessage = {
    role: 'assistant',
    _id: `a-${tag}`,
    parts: [{ type: 'text', text: `${tag} 的正文回复。`, finalised: true }],
    status: 'done',
    respondingTo: `u-${tag}`,
  };
  return [userMsg(`u-${tag}`, `${tag} 来文——足够长的一段，贴真实对话长度。`), a];
}

describe('版心 = 纸半（拉宽流区 → 流内块宽同比）', () => {
  let panel: ChatCore;
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd: string, payload: { method?: string }) => {
      if (payload?.method === 'list_directory') return Promise.resolve('[]');
      return Promise.resolve(null);
    });
    useShellStore.setState({ projectPath: 'D:/column-width-ws' });
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

  /** 挂载一卷（纸宽 regionW，文字档 zoom 0.5——DOM 块在场）。 */
  async function mount(regionW: number): Promise<void> {
    panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({ sessions: [{ id: 1, label: '卷一' }], activeIdx: 0, nextSessionId: 2 });
    msgStoreFor(panel.panelId, 1).getState().setMessages(volume('一'));
    getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: 0, anchorY: 0, width: regionW });

    const view = useCanvasViewStore;
    view.getState().setCanvasSize(1200, 800);
    view.getState().restoreView({ zoom: 0.5, panX: 600, panY: 400 });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
    // 挂载期 RO 直写 setCanvasSize(0,0)（jsdom clientWidth=0）——测试直写覆盖
    await act(async () => {
      view.getState().setCanvasSize(1200, 800);
    });
    await act(async () => {
      view.getState().setView((v) => ({ ...v, zoom: 0.5, panX: 600, panY: 400 }));
    });
  }

  /** 流区宽改档（用户拉手柄的等效操作：store 直写，与拖拽落盘同一真源）。 */
  async function setRegionWidth(width: number): Promise<void> {
    await act(async () => {
      getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: 0, anchorY: 0, width });
    });
  }

  /** 渲染面某选择器首个块的宽（px）。 */
  function widthOf(sel: string): number {
    const el = container?.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`${sel} 不在渲染面`);
    return Number.parseFloat(el.style.width);
  }

  it('默认纸 1440：正文 720 / 来文 560（与既有值逐字节一致——封顶拆除只在异宽处显形）', async () => {
    await mount(1440);
    expect(widthOf('.pp-block.pp-markdown')).toBeCloseTo(720, 5);
    expect(widthOf('.pp-block.pp-user')).toBeCloseTo(560, 5);
  });

  it('拉宽到 2160（手柄拉到上限）：两族同比 1.5×——正文 1080 / 来文 840', async () => {
    await mount(2160);
    expect(widthOf('.pp-block.pp-markdown')).toBeCloseTo(1080, 5);
    expect(widthOf('.pp-block.pp-user')).toBeCloseTo(840, 5);
  });

  it('缩窄到 720（手柄收到下限）：两族同比 0.5×——正文 360 / 来文 280', async () => {
    await mount(720);
    expect(widthOf('.pp-block.pp-markdown')).toBeCloseTo(360, 5);
    expect(widthOf('.pp-block.pp-user')).toBeCloseTo(280, 5);
  });

  it('挂载后拉手柄：块宽当场跟随（无需重挂）', async () => {
    await mount(1440);
    expect(widthOf('.pp-block.pp-markdown')).toBeCloseTo(720, 5);
    await setRegionWidth(2160);
    expect(widthOf('.pp-block.pp-markdown')).toBeCloseTo(1080, 5);
    expect(widthOf('.pp-block.pp-user')).toBeCloseTo(840, 5);
    await setRegionWidth(720);
    expect(widthOf('.pp-block.pp-markdown')).toBeCloseTo(360, 5);
  });

  it('钉住块不随流区宽缩放（钉在桌面上的纸片定格——含手调宽 pin.w）', async () => {
    await mount(1440);
    await act(async () => {
      getCanvasStore(panel.panelId)
        .getState()
        .setPin('pb:a-一:0', {
          x: 520,
          y: -200,
          w: 500,
          snapshot: { kind: 'markdown', text: '钉出时的快照' },
        });
    });
    expect(widthOf('.pp-pinned')).toBeCloseTo(500, 5);
    await setRegionWidth(2160);
    expect(widthOf('.pp-pinned')).toBeCloseTo(500, 5);
  });
});
