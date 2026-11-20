// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 画布上那张卡的长按引用（2026-11-20 用户要：摊开状态的卡也能长按）。
//
// 与坞里那枚夹签的长按是**同一份手势核心**（quote-drop 的 useQuoteHold），差别：
//   · allowOwn: true —— 画布卡不属于任何槽，落在**哪一卷**就引用进哪一卷（含它自己的来源卷）；
//   · 落点写进那一卷的夹签槽（不是「此刻 live 是谁」）。

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS, useQuoteHold } from '../src/plugins/builtin/paper-shell/quote-drop';

type HoldOpts = Parameters<typeof useQuoteHold>[0];
type HoldApi = { begin?: (e: React.PointerEvent) => void; state?: ReturnType<typeof useQuoteHold>['state'] };

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

function seedRegion(sessionId: string) {
  const el = document.createElement('div');
  el.className = 'pp-region';
  el.dataset.sessionId = sessionId;
  document.body.appendChild(el);
  return el;
}

function pointAt(el: Element | null) {
  document.elementFromPoint = () => el as Element | null;
}

function press(api: HoldApi, x = 10, y = 10) {
  act(() =>
    api.begin?.({
      button: 0,
      clientX: x,
      clientY: y,
      pointerId: 0,
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

describe('画布卡长按 → 引用', () => {
  it('**落在本卷也有效**（allowOwn）——画布卡不属于任何槽，本卷就是它的去处', () => {
    const a = seedRegion('1');
    pointAt(a);
    const onDrop = vi.fn();
    const { api } = mountHold({ ownSession: '', allowOwn: true, onDrop });

    press(api);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(document.documentElement.classList.contains('pp-quote-dropping')).toBe(true);
    up(10, 10); // 还在本卷

    expect(onDrop).toHaveBeenCalledWith('1');
    expect(document.documentElement.classList.contains('pp-quote-dropping')).toBe(false);
  });

  it('落空白 = 无操作（给 onAbandon，不误投）', () => {
    pointAt(null);
    const onDrop = vi.fn();
    const onAbandon = vi.fn();
    const { api } = mountHold({ ownSession: '', allowOwn: true, onDrop, onAbandon });
    press(api);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    up(999, 999);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it('指针位置进 state（跟手浮签要靠它定位）', () => {
    const a = seedRegion('1');
    pointAt(a);
    const { api } = mountHold({ ownSession: '', allowOwn: true, onDrop: vi.fn() });
    press(api, 40, 60);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    move(140, 260);
    expect(api.state?.x).toBe(140);
    expect(api.state?.y).toBe(260);
    expect(api.state?.dragging).toBe(true);
  });

  it('没到 320ms 就松手 = 轻点（不引用、不放弃）——块拖拽/点击照旧', () => {
    pointAt(seedRegion('1'));
    const onDrop = vi.fn();
    const onAbandon = vi.fn();
    const { api } = mountHold({ ownSession: '', allowOwn: true, onDrop, onAbandon });
    press(api);
    act(() => vi.advanceTimersByTime(120));
    up(10, 10);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('缺省（夹签轨那枚）仍是「本卷 = 无操作」——两种入口的差别只有 allowOwn', () => {
    pointAt(seedRegion('1'));
    const onDrop = vi.fn();
    const onAbandon = vi.fn();
    const { api } = mountHold({ ownSession: '1', onDrop, onAbandon });
    press(api);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    up(10, 10);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });
});
