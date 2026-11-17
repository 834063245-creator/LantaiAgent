// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// useDragGesture 守护（2026-11-17 交互原语收口批 C2）。
//
// 九份手势收编到一条核心之后，**行为契约**必须由这里钉住：起手阈值、失联即收、
// 窗外松手定夺、捕获不可用时的回退、卸载即收。每一条都对应旧实现里炸过的那种形态。

import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDragGesture } from '../src/app/interaction/use-drag-gesture';

type Opts = Parameters<typeof useDragGesture>[0];

/** 消费组件：把整个 DOM 当手势面，`begin` 挂在根 div 的 onPointerDown 上。 */
function Harness(props: Opts & { onGesture?: (g: ReturnType<typeof useDragGesture>) => void }) {
  const { onGesture, ...opts } = props;
  const g = useDragGesture(opts);
  const ref = useRef<HTMLDivElement | null>(null);
  onGesture?.(g);
  return createElement('div', {
    ref,
    className: 'gesture-surface',
    onPointerDown: (e: React.PointerEvent) => g.begin(e),
  });
}

function pointer(target: EventTarget, type: string, x: number, y: number, pointerId = 1): void {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    clientX?: number;
    clientY?: number;
    pointerId?: number;
  };
  Object.defineProperty(ev, 'clientX', { value: x });
  Object.defineProperty(ev, 'clientY', { value: y });
  Object.defineProperty(ev, 'pointerId', { value: pointerId });
  target.dispatchEvent(ev);
}

function reactPointerDown(el: Element, x: number, y: number, pointerId = 1): void {
  /* React 的合成事件由根上的原生监听生成——派发原生 pointerdown 即可。
   * jsdom 没有 PointerEvent：用 MouseEvent + pointerId 垫一层（React 认得出）。 */
  const ev = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, 'pointerId', { value: pointerId });
  el.dispatchEvent(ev);
}

describe('useDragGesture', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const surface = () => container.querySelector('.gesture-surface')!;

  it('起手阈值：没过阈值的位移不调 onStart/onMove，松手算点击（onCancel("click")）', () => {
    const onStart = vi.fn();
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      root.render(createElement(Harness, { threshold: 6, onStart, onMove, onEnd, onCancel }));
    });
    act(() => {
      reactPointerDown(surface(), 100, 100);
    });
    act(() => {
      pointer(window, 'pointermove', 102, 102);
      pointer(window, 'pointerup', 102, 102);
    });
    expect(onStart).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith('click');
  });

  it('过阈值后 onStart 只调一次，onMove 每帧调，松手交最终位移', () => {
    const onStart = vi.fn();
    const onMove = vi.fn();
    const onEnd = vi.fn();
    act(() => {
      root.render(createElement(Harness, { threshold: 6, onStart, onMove, onEnd }));
    });
    act(() => {
      reactPointerDown(surface(), 100, 100);
    });
    act(() => {
      pointer(window, 'pointermove', 110, 100);
      pointer(window, 'pointermove', 140, 120);
      pointer(window, 'pointerup', 140, 120);
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0][1]).toMatchObject({ dx: 40, dy: 20, dragging: true });
  });

  it('失联（窗口失焦）⇒ onCancel("lost-focus")，**不提交** onEnd', () => {
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      root.render(createElement(Harness, { threshold: 0, onEnd, onCancel }));
    });
    act(() => {
      reactPointerDown(surface(), 10, 10);
      pointer(window, 'pointermove', 40, 40);
    });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onCancel).toHaveBeenCalledWith('lost-focus');
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('pointercancel ⇒ 取消（浏览器免费给的失联信号）', () => {
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      root.render(createElement(Harness, { threshold: 0, onEnd, onCancel }));
    });
    act(() => {
      reactPointerDown(surface(), 10, 10);
      pointer(window, 'pointermove', 40, 40);
      pointer(window, 'pointercancel', 40, 40);
    });
    expect(onCancel).toHaveBeenCalledWith('pointercancel');
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('clampToViewport：窗外松手仍定夺，落点夹回视口内', () => {
    const onEnd = vi.fn();
    act(() => {
      root.render(createElement(Harness, { threshold: 0, clampToViewport: true, onEnd }));
    });
    act(() => {
      reactPointerDown(surface(), 10, 10);
      pointer(window, 'pointermove', 5000, 5000);
      pointer(window, 'pointerup', 5000, 5000);
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
    const d = onEnd.mock.calls[0][1];
    expect(d.outsideViewport).toBe(true);
    expect(d.x).toBeLessThanOrEqual(window.innerWidth);
    expect(d.y).toBeLessThanOrEqual(window.innerHeight);
  });

  it('没有 clampToViewport 时，窗外松手原样交出（由手势域自己判）', () => {
    const onEnd = vi.fn();
    act(() => {
      root.render(createElement(Harness, { threshold: 0, onEnd }));
    });
    act(() => {
      reactPointerDown(surface(), 10, 10);
      pointer(window, 'pointermove', 5000, 5000);
      pointer(window, 'pointerup', 5000, 5000);
    });
    expect(onEnd.mock.calls[0][1]).toMatchObject({ x: 5000, y: 5000, outsideViewport: true });
  });

  it('isActive 如实反映在途态（「有手势时别抢指针」的判据面）', () => {
    let gesture: ReturnType<typeof useDragGesture> | null = null;
    act(() => {
      root.render(createElement(Harness, { threshold: 0, onGesture: (g) => (gesture = g) }));
    });
    expect(gesture!.isActive()).toBe(false);
    act(() => {
      reactPointerDown(surface(), 5, 5);
    });
    expect(gesture!.isActive()).toBe(true);
    act(() => {
      pointer(window, 'pointermove', 30, 30);
      pointer(window, 'pointerup', 30, 30);
    });
    expect(gesture!.isActive()).toBe(false);
  });

  it('卸载即收：组件拆掉时在途手势作废（不许活过组件寿命）', () => {
    const onCancel = vi.fn();
    act(() => {
      root.render(createElement(Harness, { threshold: 0, onCancel }));
    });
    act(() => {
      reactPointerDown(surface(), 5, 5);
      pointer(window, 'pointermove', 30, 30);
    });
    act(() => root.unmount());
    expect(onCancel).toHaveBeenCalled();
    /* afterEach 会再 unmount 一次——重建一个 root 免得它炸 */
    root = createRoot(container);
  });
});
