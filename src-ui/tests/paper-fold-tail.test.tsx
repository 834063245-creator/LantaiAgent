// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 块底收起把手（2026-11-25「收起操作两个位置」批）——用户拍板：
//   ① 原位置不变：展开态的**块顶**折叠行（「▾ 收起 名字」）照旧是收起面；
//   ② 新位置：展开态卡片的**内容底部**再加一枚同款折叠行（短签「▾ 收起」）。
// 两处是**同一个动作**：同一个 onToggleFold（同一张用户覆盖表）、同一枚样式
// （.pp-fold + --tail 只把上下距对调）、同一处判据（paper/fold.hasFoldTail）——
// 测高侧 measure 的 foldTailH 读的就是这个函数，所以本文件同时钉两侧。
//
// 判据的例外与边界（都在这条判据里，不在渲染端各写一套）：
//   · 收起态不出：块顶那行本身就是展开面，块底再来一枚「收起」是自相矛盾的两态；
//   · 工具组不出：它的展开态子卡是**独立块**（translate 的 collapseToolGroups），
//     「内容底部」落在组头盒子之外；组头盒内塞一枚只会紧贴块顶那行；
//   · 不可折叠族（来文/正文/抄录/贴黄/拟策）不出。
//
// 高度账：把手 = 行 14px + 上距 6px = 20px（FOLD_TAIL_H，与块顶折叠行上下对称）。
// 测高与渲染必须同增同减——差 20px 就是「压字」或「幻影空档」两种老病灶之一。

// @vitest-environment jsdom

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
  walkLineRanges: vi.fn((_p: unknown, _w: number, cb: (l: { start: number; end: number; width: number }) => void) => {
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

// jsdom 无 Canvas 2D / ResizeObserver —— 与 paper-reasoning-measure 同款桩。
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

import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { createBlock, resetBlockIdCounterForTests, type SourcedBlock } from '../src/paper/block-model';
import { FOLD_TAIL_LABEL, hasFoldTail } from '../src/paper/fold';
import {
  FOLD_ROW_H,
  FOLD_TAIL_H,
  measureBlockHeight,
  measureSignature,
} from '../src/plugins/builtin/paper-shell/measure';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

function block(kind: Parameters<typeof createBlock>[0], payload: object, asset?: SourcedBlock['asset']): SourcedBlock {
  return createBlock(kind, payload as never, { messageId: 'm', part: null }, asset ? { asset } : undefined);
}

function assetBlock(kind = 'table'): SourcedBlock {
  return block(
    kind,
    { columns: ['a'], rows: [['x']] },
    {
      assetId: 'as-1',
      presentation: 'grid',
      title: '图版 1',
      finalised: true,
    },
  );
}

describe('块底收起把手 · 判据（渲染与测高共用 paper/fold.hasFoldTail）', () => {
  it('可折叠族的展开态出把手；收起态不出（块顶那行即展开面）', () => {
    const reasoning = block('reasoning', { text: '想' });
    const tool = block('tool', { toolId: 't', name: 'n', label: 'l', args: 'a', status: 'done' });
    const code = block('code', { toolId: 't', description: 'd', code: 'c', status: 'done' });
    const post = block('subagent', { agentId: 'a', description: '调研', status: 'done', childIds: [], items: [] });
    for (const b of [reasoning, tool, code, post]) {
      expect(hasFoldTail(b.kind, b, false), `${b.kind} 展开态应出把手`).toBe(true);
      expect(hasFoldTail(b.kind, b, true), `${b.kind} 收起态不应出把手`).toBe(false);
    }
  });

  it('图版卡（资产身份）同族：默认张开 ⇒ 默认就有把手；手动收起后不出', () => {
    const asset = assetBlock();
    expect(hasFoldTail(asset.kind, asset, false)).toBe(true);
    expect(hasFoldTail(asset.kind, asset, true)).toBe(false);
  });

  it('工具组不出：展开态子卡是独立块，「内容底部」不在组头盒子里', () => {
    const group = block('toolgroup', { childIds: ['pb:1', 'pb:2'], items: [] });
    expect(hasFoldTail(group.kind, group, false)).toBe(false);
  });

  it('不可折叠族不出（来文/正文/抄录/贴黄/拟策）', () => {
    for (const kind of ['user', 'markdown', 'diff', 'notice', 'turn-error', 'plan'] as const) {
      expect(hasFoldTail(kind, block(kind, { text: 'x' }), false), kind).toBe(false);
    }
  });

  it('把手文案是一枚短签（不复制块顶那行读数）', () => {
    expect(FOLD_TAIL_LABEL).toBe('▾ 收起');
  });
});

describe('块底收起把手 · 测高镜像（差 20px = 压字或幻影空档）', () => {
  beforeEach(() => {
    layoutMock.mockClear();
    resetBlockIdCounterForTests();
  });

  it('展开态 = 收起态 + 把手高（夹注 / 脚注 / 程文 三族各一）', () => {
    const reasoning = block('reasoning', { text: '思考全文' });
    const tool = block('tool', { toolId: 't', name: 'n', label: 'l', args: 'a', status: 'done', output: 'o' });
    const code = block('code', { toolId: 't', description: 'd', code: 'c', status: 'done', output: 'o' });
    for (const b of [reasoning, tool, code]) {
      const folded = measureBlockHeight(b, true);
      const expanded = measureBlockHeight(b, false);
      // 收起态折叠行 20 + 各族的折叠态内容（夹注一行预览 / 脚注零载荷 / 程文留输出）
      expect(expanded, b.kind).toBeGreaterThan(folded);
    }
    // 钉一个逐字算式（夹注：折叠行 + 正文 + 把手）
    expect(measureBlockHeight(reasoning, false)).toBe(FOLD_ROW_H + 36 + FOLD_TAIL_H);
  });

  it('图版卡展开态同样带把手（默认张开 = 默认就多这一档）', () => {
    const asset = assetBlock();
    const expanded = measureBlockHeight(asset, false);
    const folded = measureBlockHeight(asset, true);
    expect(folded).toBe(FOLD_ROW_H);
    expect(expanded).toBeGreaterThan(folded);
    // 资产折叠态 = 折叠行本身（无把手）；展开态 = 体 + 把手
    expect(hasFoldTail(asset.kind, asset, false)).toBe(true);
  });

  it('折叠位入签名：切换态必重测（把手的出现/消失是高度信号）', () => {
    const reasoning = block('reasoning', { text: '想' });
    expect(measureSignature(reasoning, false)).not.toBe(measureSignature(reasoning, true));
  });
});

/* ── 渲染面（真 PaperPanel 穿全层，harness 同 paper-reasoning-measure）── */

const W = 1200;
const H = 800;

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}
function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}
function turnMessages(): ChatMessage[] {
  return [
    userMsg('u1', '看看这个改动。'),
    asstMsg('a1', [
      { type: 'reasoning', text: '先看折叠面：块顶那行展开后应该还有一块底把手。', finalised: true },
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
    // 出错脚注单独一轮：同一轮里两个工具会成组（组默认收起，子卡不进布局栈）
    asstMsg('a2', [
      {
        type: 'tool',
        toolId: 't2',
        name: 'write_file',
        label: '写文件',
        args: JSON.stringify({ file_path: 'D:/ws/b.ts', content: 'x' }),
        output: '',
        err: 'ENOENT',
        status: 'error',
      },
    ]),
  ];
}

/** 同族连续两次调用 → 成一个工具组（组头 + 子卡；子卡是独立块）。 */
function groupMessages(): ChatMessage[] {
  return [
    userMsg('u1', '两个文件都读一下。'),
    asstMsg('a1', [
      {
        type: 'tool',
        toolId: 'g1',
        name: 'read_file',
        label: '读文件',
        args: JSON.stringify({ file_path: 'D:/ws/a.ts' }),
        output: 'const a = 1;',
        status: 'done',
      },
      {
        type: 'tool',
        toolId: 'g2',
        name: 'read_file',
        label: '读文件',
        args: JSON.stringify({ file_path: 'D:/ws/b.ts' }),
        output: 'const b = 2;',
        status: 'done',
      },
    ]),
  ];
}

describe('块底收起把手 · 渲染（两处收起面，同一个覆盖表）', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    localStorage.clear();
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

  async function mount(messages: ChatMessage[]): Promise<HTMLElement> {
    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({ sessions: [{ id: 1, label: '卷一' }], activeIdx: 0, nextSessionId: 2 });
    msgStoreFor(panel.panelId, 1).getState().setMessages(messages);
    getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: 0, anchorY: 0, width: 1440 });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
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

  const tails = (el: Element) => [...el.querySelectorAll<HTMLButtonElement>('.pp-fold--tail')];
  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('夹注：收起态只有块顶一枚；展开后块底多一枚（短签）——点它即收起', async () => {
    const el = await mount(turnMessages());
    const reasoning = el.querySelector<HTMLElement>('.pp-block.pp-reasoning');
    if (!reasoning) throw new Error('夹注块未渲染');

    // 收起态（夹注恒折）：块顶那行是**展开面**，块底不出把手
    expect(tails(reasoning)).toHaveLength(0);
    const top = reasoning.querySelector<HTMLButtonElement>('.pp-fold');
    if (!top) throw new Error('折叠行未渲染');
    expect(top.textContent?.startsWith('▸')).toBe(true);

    // 展开：块顶那行改口「▾ 收起 …」，块底同时长出一枚短签把手（两处同框）
    await click(top);
    const afterExpand = el.querySelector<HTMLElement>('.pp-block.pp-reasoning');
    if (!afterExpand) throw new Error('夹注块未渲染（展开后）');
    expect([...afterExpand.querySelectorAll('.pp-fold')]).toHaveLength(2);
    expect(afterExpand.querySelector('.pp-fold')?.textContent?.startsWith('▾ 收起')).toBe(true);
    const tail = tails(afterExpand);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.textContent).toBe(FOLD_TAIL_LABEL);
    // 文档序：块顶那行在前、把手在后（把手长在**内容底部**，不是块顶）
    expect([...afterExpand.querySelectorAll('.pp-fold')][1]).toBe(tail[0]);

    // 点块底把手 = 收起（同一个覆盖表：块顶那行随之改回「▸ …」，把手退场）
    await click(tail[0] as HTMLButtonElement);
    const afterCollapse = el.querySelector<HTMLElement>('.pp-block.pp-reasoning');
    if (!afterCollapse) throw new Error('夹注块未渲染（收起后）');
    expect(afterCollapse.querySelector('.pp-fold')?.textContent?.startsWith('▸')).toBe(true);
    expect(tails(afterCollapse)).toHaveLength(0);
  });

  it('服务端默认张开的卡（出错脚注）天生两处收起面', async () => {
    const el = await mount(turnMessages());
    const errTool = [...el.querySelectorAll<HTMLElement>('.pp-block.pp-tool')].find((b) =>
      b.querySelector('.pp-status.pp-error'),
    );
    if (!errTool) throw new Error('出错脚注未渲染');
    // error 恒展开（错误留面）⇒ 块顶 + 块底各一枚
    expect(tails(errTool)).toHaveLength(1);
    expect(errTool.querySelector('.pp-fold')?.textContent?.startsWith('▾ 收起')).toBe(true);
  });

  it('工具组：展开后仍只有块顶那一枚（组头的展开内容是独立块，盒内不出把手）', async () => {
    const el = await mount(groupMessages());
    const group = el.querySelector<HTMLElement>('.pp-block.pp-toolgroup');
    if (!group) throw new Error('工具组未渲染');
    // 组头默认收起：先展开
    const top = group.querySelector<HTMLButtonElement>('.pp-fold');
    if (!top) throw new Error('组头折叠行未渲染');
    await click(top);
    const afterExpand = el.querySelector<HTMLElement>('.pp-block.pp-toolgroup');
    if (!afterExpand) throw new Error('工具组未渲染（展开后）');
    expect(tails(afterExpand)).toHaveLength(0);
    expect([...afterExpand.querySelectorAll('.pp-fold')]).toHaveLength(1);
  });
});
