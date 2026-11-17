// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 宽度手调的手势面（2026-11-17 交互原语批 C3 · 2/9）。
//
// 这一份此前**没有任何自动化测试**（`pp-resize` 的手势只在真机上走过）。收编到
// `useDragGesture` 之后补上行为面：起手 / 跟手跟缩 / 松手一次性写回 / 失联即收不写回。
// 手势输入按 pointer 事件喂（核心要 `setPointerCapture`）。

import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePinStripResize } from '../src/plugins/builtin/paper-shell/use-pin-strip-resize';

const panelId = 'p1';
const viewRef = { current: { zoom: 1, panX: 0, panY: 0 } };
const canvasRef = { current: null as HTMLDivElement | null };

const resizePin = vi.fn();
const resizeStrip = vi.fn();

vi.mock('../src/plugins/builtin/paper-shell/host', async () => {
  const actual = await vi.importActual<typeof import('../src/plugins/builtin/paper-shell/host')>(
    '../src/plugins/builtin/paper-shell/host',
  );
  return {
    ...actual,
    getCanvasStore: () => ({
      getState: () => ({ resizePin, resizeStrip }),
    }),
  };
});

type Api = ReturnType<typeof usePinStripResize>;

function Probe({ onApi }: { onApi: (a: Api) => void }) {
  const api = usePinStripResize({ core: { panelId } as never, canvasRef, viewRef });
  const el = useRef<HTMLDivElement | null>(null);
  onApi(api);
  return createElement('div', {
    ref: el,
    className: 'resize-surface',
    onPointerDown: (e: React.PointerEvent) => api.onResizePointerDown(e, 'b1', 'pin', 400),
  });
}

function pointerDown(el: Element, x: number, y = 0): void {
  const ev = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  el.dispatchEvent(ev);
}

function pointerMove(x: number): void {
  const ev = new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: 0 });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  window.dispatchEvent(ev);
}

function pointerUp(x: number): void {
  const ev = new MouseEvent('pointerup', { bubbles: true, clientX: x, clientY: 0 });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  window.dispatchEvent(ev);
}

describe('usePinStripResize（手势面）', () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: Api;

  beforeEach(() => {
    resizePin.mockClear();
    resizeStrip.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const mount = (): void => {
    act(() => {
      root.render(createElement(Probe, { onApi: (a: Api) => (api = a) }));
    });
  };
  const surface = (): Element => container.querySelector('.resize-surface')!;

  it('拖动 → 预览跟手改宽（按 zoom 换算），松手一次性写回 store', () => {
    mount();
    act(() => {
      pointerDown(surface(), 100);
    });
    act(() => {
      pointerMove(160);
    });
    expect(api.resizePreview).toEqual({ id: 'b1', w: 460 });
    act(() => {
      pointerUp(160);
    });
    expect(api.resizePreview).toBeNull();
    expect(resizePin).toHaveBeenCalledWith('b1', 460);
  });

  it('缩放画布后位移按 zoom 折算（zoom=2 时拖 100px 只加 50 世界宽）', () => {
    viewRef.current = { zoom: 2, panX: 0, panY: 0 };
    mount();
    act(() => {
      pointerDown(surface(), 100);
      pointerMove(200);
    });
    expect(api.resizePreview).toEqual({ id: 'b1', w: 450 });
    viewRef.current = { zoom: 1, panX: 0, panY: 0 };
  });

  it('夹在 [最小宽, 流区宽] 之间（拖出界不写越界值）', () => {
    mount();
    act(() => {
      pointerDown(surface(), 5000);
      pointerMove(0);
    });
    expect(api.resizePreview?.w).toBeGreaterThan(0);
    expect(api.resizePreview?.w).toBeLessThanOrEqual(720);
  });

  it('失联（窗口失焦）⇒ 撤预览且**不写回**（失联 = 无事发生）', () => {
    mount();
    act(() => {
      pointerDown(surface(), 100);
      pointerMove(300);
    });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(api.resizePreview).toBeNull();
    expect(resizePin).not.toHaveBeenCalled();
  });

  it('Esc ⇒ 同样是取消（不写回）', () => {
    mount();
    act(() => {
      pointerDown(surface(), 100);
      pointerMove(300);
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(api.resizePreview).toBeNull();
    expect(resizePin).not.toHaveBeenCalled();
  });
});
