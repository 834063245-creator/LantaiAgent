// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 指针穿透盾（2026-11-24）行为考官：宿主按住期间 iframe 不吃指针。
// 病灶：iframe 是独立 document，画布拖动经过它时 pointermove/pointerup 被吞进
// 子文档——画布停摆、松手丢 up、pointer claim 残留。盾的生命周期必须与宿主
// 主键严格同拍；iframe 内起手（父文档收不到按下）不得误伤。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POINTER_HELD_ATTR, usePointerShield } from '../src/app/interaction/pointer-shield';

function Harness() {
  usePointerShield();
  return null;
}

/** jsdom 没有 PointerEvent 构造器：MouseEvent + pointerId 即可让监听面认账。 */
function pointer(target: EventTarget, type: string, init: MouseEventInit & { pointerId?: number } = {}): void {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
  target.dispatchEvent(ev);
}

function held(): boolean {
  return document.documentElement.hasAttribute(POINTER_HELD_ATTR);
}

describe('pointer-shield：宿主按住期 iframe 不吃指针', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.documentElement.removeAttribute(POINTER_HELD_ATTR);
  });

  it('主键按下挂盾；抬起摘盾', () => {
    pointer(document.body, 'pointerdown', { button: 0 });
    expect(held()).toBe(true);
    pointer(window, 'pointerup', { button: 0 });
    expect(held()).toBe(false);
  });

  it('非主键（右键 / 中键）不挂盾', () => {
    pointer(document.body, 'pointerdown', { button: 2 });
    expect(held()).toBe(false);
    pointer(document.body, 'pointerdown', { button: 1 });
    expect(held()).toBe(false);
  });

  it('iframe 本体按下不挂盾（窗内交互不能被掐死）', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    pointer(frame, 'pointerdown', { button: 0 });
    expect(held()).toBe(false);
    frame.remove();
  });

  it('原生窗口拖动热区按下不挂盾（OS 模态循环收不到 mouseup）', () => {
    const chrome = document.createElement('div');
    chrome.className = 'pp-chrome';
    document.body.appendChild(chrome);
    pointer(chrome, 'pointerdown', { button: 0 });
    expect(held()).toBe(false);
    chrome.remove();
  });

  it('丢 up 的兜底：无按键移动即摘盾，按着移动不收', () => {
    pointer(document.body, 'pointerdown', { button: 0 });
    pointer(window, 'pointermove', { buttons: 1 });
    expect(held(), '还按着，盾要留着').toBe(true);
    pointer(window, 'pointermove', { buttons: 0 });
    expect(held(), '已经松手（up 丢了）——下一帧移动自救').toBe(false);
  });

  it('多指：抬起一根不收盾，全抬起才收', () => {
    pointer(document.body, 'pointerdown', { button: 0, pointerId: 11 });
    pointer(document.body, 'pointerdown', { button: 0, pointerId: 12 });
    pointer(window, 'pointerup', { button: 0, pointerId: 11 });
    expect(held(), '还有一根按着，盾不能收').toBe(true);
    pointer(window, 'pointerup', { button: 0, pointerId: 12 });
    expect(held()).toBe(false);
  });

  it('pointercancel / 失焦 / 切走 / 指针离开文档都清账（up 不会来）', () => {
    pointer(document.body, 'pointerdown', { button: 0 });
    pointer(window, 'pointercancel', { button: 0 });
    expect(held()).toBe(false);

    pointer(document.body, 'pointerdown', { button: 0 });
    window.dispatchEvent(new Event('blur'));
    expect(held()).toBe(false);

    pointer(document.body, 'pointerdown', { button: 0 });
    document.dispatchEvent(new MouseEvent('mouseleave'));
    expect(held()).toBe(false);

    pointer(document.body, 'pointerdown', { button: 0 });
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(held()).toBe(false);
    if (original) Object.defineProperty(document, 'visibilityState', original);
    else Reflect.deleteProperty(document, 'visibilityState');
  });

  it('卸载即摘盾（组件死在按住中也不留脏标记）', () => {
    pointer(document.body, 'pointerdown', { button: 0 });
    expect(held()).toBe(true);
    act(() => root?.unmount());
    root = null;
    expect(held()).toBe(false);
  });

  it('CSS 规则与标记同生共死（jsdom 不算级联，守源码面）', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'app', 'foundation.css'), 'utf8');
    expect(css).toMatch(/html\[data-pointer-held\]\s+iframe\s*\{[^}]*pointer-events:\s*none/);
  });
});
