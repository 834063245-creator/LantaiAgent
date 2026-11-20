// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 长按把夹签递给另一卷（docs/plans/card-quote-plan.md §2.2 态二 / §6.2 / §8）：
//   · 320ms 才起手；不到就松手 = 轻点，交回快路（本 hook 什么都不提交）；
//   · 位移超 8px 就作废长按（用户在滚动，不是要拖）；
//   · 落在**别的卷** = 递给它；落在空白 / 本卷 = 无操作；
//   · Esc 取消（§8）；可投放态与目标卷要靠 DOM 打标，收尾必须摘干净。

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS, regionAtPoint, useQuoteHold } from '../src/plugins/builtin/paper-shell/quote-drop';

/** 造一卷的 DOM（长按手势靠 elementFromPoint 命中）。 */
function seedRegion(sessionId: string, rect: { x: number; y: number; w: number; h: number }) {
  const el = document.createElement('div');
  el.className = 'pp-region';
  el.dataset.sessionId = sessionId;
  el.getBoundingClientRect = () =>
    ({
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
      right: rect.x + rect.w,
      bottom: rect.y + rect.h,
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

/** 把 elementFromPoint 指到某块 DOM（jsdom 没有命中测试，自己给）。 */
function pointAt(el: Element | null) {
  document.elementFromPoint = () => (el as Element & { closest: Element['closest'] }) ?? null;
}

type HoldOpts = Parameters<typeof useQuoteHold>[0];
type HoldApi = { begin?: (e: React.PointerEvent) => void; state?: ReturnType<typeof useQuoteHold>['state'] };

/** 渲染一个只暴露 hook 的探针组件（模块级定义——组件不许建在函数里）。 */
function Probe(p: { opts: HoldOpts; api: HoldApi }) {
  const h = useQuoteHold(p.opts);
  p.api.begin = h.begin;
  p.api.state = h.state;
  return null;
}

function mountHold(opts: HoldOpts) {
  const api: HoldApi = {};
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe, { opts, api })));
  return { api, root };
}

/** 一次按住（pointerdown）——只要 begin 收到的那点坐标与 currentTarget。 */
function press(api: { begin?: (e: React.PointerEvent) => void }, x = 10, y = 10) {
  act(() =>
    api.begin?.({
      button: 0,
      clientX: x,
      clientY: y,
      pointerId: 0, // 手势核心按 pointerId 过滤事件——与下面 dispatch 的 PointerEvent 同号
      currentTarget: document.body,
    } as unknown as React.PointerEvent),
  );
}

const up = (x: number, y: number) =>
  act(() => window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y })));
const move = (x: number, y: number) =>
  act(() => window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y })));

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

describe('regionAtPoint（卷命中）', () => {
  it('命中卷 → 卷号；点在空白 → null', () => {
    const a = seedRegion('1', { x: 0, y: 0, w: 100, h: 100 });
    pointAt(a);
    expect(regionAtPoint(5, 5)).toBe('1');
    pointAt(null);
    expect(regionAtPoint(5, 5)).toBeNull();
  });
});

describe('长按递给别的卷', () => {
  it('按住 320ms 起手 → 移到 B 卷松手 = 递给 B', () => {
    const a = seedRegion('1', { x: 0, y: 0, w: 100, h: 100 });
    const b = seedRegion('2', { x: 200, y: 0, w: 100, h: 100 });
    pointAt(a);
    const onDrop = vi.fn();
    const { api } = mountHold({ ownSession: '1', onDrop });

    press(api);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(document.documentElement.classList.contains('pp-quote-dropping'), '起手后卷没进入可投放态').toBe(true);

    pointAt(b);
    move(220, 50);
    expect(b.getAttribute('data-quote-drop'), '目标卷没打标（描线加粗靠它）').toBe('1');
    up(220, 50);

    expect(onDrop).toHaveBeenCalledWith('2');
    // 收尾摘干净：可投放态与目标标记都不许留
    expect(document.documentElement.classList.contains('pp-quote-dropping')).toBe(false);
    expect(b.hasAttribute('data-quote-drop')).toBe(false);
  });

  it('没到 320ms 就松手 = 轻点，什么都不提交（交回快路）', () => {
    pointAt(seedRegion('1', { x: 0, y: 0, w: 100, h: 100 }));
    const onDrop = vi.fn();
    const onAbandon = vi.fn();
    const { api } = mountHold({ ownSession: '1', onDrop, onAbandon });

    press(api);
    act(() => vi.advanceTimersByTime(200));
    up(10, 10);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onAbandon).not.toHaveBeenCalled(); // 轻点不是「放弃」，是「没发生」
    expect(document.documentElement.classList.contains('pp-quote-dropping')).toBe(false);
  });

  it('位移超 8px 取消长按（用户在滚动，不是要拖）', () => {
    pointAt(seedRegion('1', { x: 0, y: 0, w: 100, h: 100 }));
    const onDrop = vi.fn();
    const { api } = mountHold({ ownSession: '1', onDrop });

    press(api);
    move(10 + 9, 10); // 超容差
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS)); // 计时器已被取消，不会再起手
    expect(document.documentElement.classList.contains('pp-quote-dropping')).toBe(false);
    up(20, 10);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('落在空白 / 落在**本卷** = 无操作（onAbandon，而不是递给自己）', () => {
    const a = seedRegion('1', { x: 0, y: 0, w: 100, h: 100 });
    pointAt(a);
    const onDrop = vi.fn();
    const onAbandon = vi.fn();
    const { api } = mountHold({ ownSession: '1', onDrop, onAbandon });

    press(api);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    up(10, 10); // 还在本卷上
    expect(onDrop).not.toHaveBeenCalled();
    expect(onAbandon).toHaveBeenCalledTimes(1);

    // 空白
    pointAt(null);
    press(api);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    up(999, 999);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onAbandon).toHaveBeenCalledTimes(2);
  });

  it('Esc 取消（§8 长按拖拽中途 Esc → 取消）', () => {
    pointAt(seedRegion('1', { x: 0, y: 0, w: 100, h: 100 }));
    const onDrop = vi.fn();
    const onAbandon = vi.fn();
    const { api } = mountHold({ ownSession: '1', onDrop, onAbandon });

    press(api);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(document.documentElement.classList.contains('pp-quote-dropping')).toBe(true);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('pp-quote-dropping')).toBe(false);
  });

  it('起手后再移动仍会更新目标卷（描线跟着指针走）', () => {
    const a = seedRegion('1', { x: 0, y: 0, w: 100, h: 100 });
    const b = seedRegion('2', { x: 200, y: 0, w: 100, h: 100 });
    pointAt(a);
    const { api } = mountHold({ ownSession: '1', onDrop: vi.fn() });
    press(api);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    pointAt(b);
    move(220, 50);
    expect(b.getAttribute('data-quote-drop')).toBe('1');
    pointAt(a);
    move(20, 50);
    expect(b.hasAttribute('data-quote-drop'), '离开后旧目标标记没摘').toBe(false);
    expect(a.getAttribute('data-quote-drop')).toBe('1');
  });
});
