// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 画布长按的两条**实机病灶**（2026-11-20 用户报「画面跳变」「收回也失效了」）：
//
// ① 收回失效：useDragGesture.begin 会立刻对 currentTarget setPointerCapture，
//    块根一拍就捕获 ⇒ 块内按钮（收回 / 抄录 / 立枝…）的 click 被重定向到块根，
//    永远不触发。判据 = 事件源不在交互件里（button / a / input / role=button /
//    .pp-kind / .pp-drag-handle）。
//
// ② 画面跳变：holding 是单个布尔、早先挂在**每一块**上；且 CSS 用了 scale——
//    块定位靠内联 transform: translate(x,y)，而 scale 先于 transform 生效，
//    远处块会被自己的坐标缩掉（x=2000 挪 10px）。现在只标被按住的那一块，
//    CSS 不碰任何参与几何的属性。
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlock } from '../src/paper/block-model';
import { useQuoteHoldCanvas } from '../src/plugins/builtin/paper-shell/use-quote-hold-canvas';

type HookOpts = Parameters<typeof useQuoteHoldCanvas>[0];
type HookApi = {
  begin?: (e: React.PointerEvent, block: ReturnType<typeof assetBlock>, sessionNum: number) => void;
  holdingBlockId?: string | null;
  state?: ReturnType<typeof useQuoteHoldCanvas>['state'];
};

function Probe(p: { opts: HookOpts; api: HookApi }) {
  const h = useQuoteHoldCanvas(p.opts);
  p.api.begin = h.begin;
  p.api.holdingBlockId = h.holdingBlockId;
  p.api.state = h.state;
  return null;
}

function mount(opts: HookOpts) {
  const api: HookApi = {};
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe, { opts, api })));
  return { api, root };
}

function assetBlock(id = 'pb:1') {
  return {
    ...createBlock(
      'html',
      { code: '<b>x</b>' } as never,
      { messageId: '', part: null },
      { asset: { assetId: 'as_a', presentation: 'html', title: '示例', finalised: true } },
    ),
    id,
  };
}

/** 造一次「块根 + 里面有什么」的按下事件。 */
function downOn(el: Element) {
  return {
    button: 0,
    clientX: 10,
    clientY: 10,
    pointerId: 0,
    currentTarget: document.body,
    target: el,
  } as unknown as React.PointerEvent;
}

function blockRoot(inner?: { cls?: string; tag?: 'button' | 'div' }) {
  const root = document.createElement('div');
  root.className = 'pp-block';
  if (inner) {
    const child = document.createElement(inner.tag ?? 'div');
    if (inner.cls) child.className = inner.cls;
    root.appendChild(child);
  }
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  document.documentElement.className = '';
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.documentElement.className = '';
});

describe('画布长按：两条实机病灶', () => {
  it('① 落在块内按钮上不起手（否则 setPointerCapture 掐断 click —— 收回失效）', () => {
    const root = blockRoot({ tag: 'button' });
    root.firstElementChild!.textContent = '收回';
    const { api } = mount({ panelId: 'p', moveCardToSlot: () => 'moved' });
    act(() => api.begin?.(downOn(root.firstElementChild!), assetBlock(), 1));
    expect(api.holdingBlockId).toBeNull();
    expect(api.state?.holding).toBe(false);
  });

  it('① 拖拽把手（.pp-kind）同样不归长按管', () => {
    const root = blockRoot({ cls: 'pp-kind pp-drag-handle' });
    const { api } = mount({ panelId: 'p', moveCardToSlot: () => 'moved' });
    act(() => api.begin?.(downOn(root.firstElementChild!), assetBlock(), 1));
    expect(api.state?.holding).toBe(false);
  });

  it('① 落在块体本身（非交互件）照常起手', () => {
    const root = blockRoot({ cls: 'pp-body' });
    const { api } = mount({ panelId: 'p', moveCardToSlot: () => 'moved' });
    act(() => api.begin?.(downOn(root.firstElementChild!), assetBlock(), 1));
    expect(api.state?.holding).toBe(true);
  });

  it('② 回执只标被按住的那一块', () => {
    const root = blockRoot();
    const { api } = mount({ panelId: 'p', moveCardToSlot: () => 'moved' });
    act(() => api.begin?.(downOn(root), assetBlock('pb:7'), 1));
    expect(api.holdingBlockId).toBe('pb:7');
  });

  it('没有资产身份的块不起手（正文段/工具卡没有卡的「本体」）', () => {
    const root = blockRoot();
    const plain = createBlock('markdown', { text: '正文' } as never, { messageId: '', part: null });
    const { api } = mount({ panelId: 'p', moveCardToSlot: () => 'moved' });
    act(() => api.begin?.(downOn(root), plain as never, 1));
    expect(api.state?.holding).toBe(false);
  });
});
