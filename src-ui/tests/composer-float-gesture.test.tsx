// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞拖动（2026-11-17 交互原语批 C3 · 5/9）。
//
// 这一份原来自己挂 window pointer 监听，收编后有三条新语义要钉：
//   ① **失联即收**：窗口失焦 ⇒ 取消 + 位置回滚（旧实现会卡在 dragging 态）；
//   ② **只点不拖不落盘**：单击坞体不该把已存坞位当「无覆盖」清掉；
//   ③ 拖动期全页禁选类的挂/摘成对（`pp-composer-dragging`）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerFloat } from '../src/plugins/builtin/paper-shell/use-composer-float';

const saveComposerPos = vi.fn();
vi.mock('../src/plugins/builtin/paper-shell/composer-float', async () => {
  const actual = await vi.importActual<typeof import('../src/plugins/builtin/paper-shell/composer-float')>(
    '../src/plugins/builtin/paper-shell/composer-float',
  );
  return {
    ...actual,
    loadComposerPos: () => null,
    loadComposerUnlocked: () => true,
    saveComposerPos: (...args: unknown[]) => saveComposerPos(...args),
    saveComposerUnlocked: () => {},
  };
});

type Api = ReturnType<typeof useComposerFloat>;

function Probe({ onApi }: { onApi: (a: Api) => void }) {
  const api = useComposerFloat({ rackOn: false });
  onApi(api);
  /* ⚠ 必须用 hook 自己那把 `slotRef`：坞位是从**槽的实测矩形**起算的，外部另起一把 ref
   * 会让 `slotEl.current` 为 null ⇒ 起拖守卫（未实测不起拖）直接返回。 */
  return createElement(
    'div',
    { ref: api.slotRef, className: 'pp-composer' },
    createElement('div', { className: 'cd-drag-surface', onPointerDown: api.onPointerDown }, 'dock'),
  );
}

function pointer(target: EventTarget, type: string, x: number, y: number): void {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  target.dispatchEvent(ev);
}

describe('useComposerFloat 拖动（手势核心）', () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: Api;

  beforeEach(() => {
    saveComposerPos.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // 坞槽要有实测矩形（核心/本域都以「未实测不起拖」守卫）
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        return {
          left: 100,
          top: 600,
          right: 900,
          bottom: 700,
          width: 800,
          height: 100,
          x: 100,
          y: 600,
          toJSON: () => ({}),
        };
      },
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });

  const mount = (): void => {
    act(() => {
      root.render(createElement(Probe, { onApi: (a: Api) => (api = a) }));
    });
  };

  it('拖动：坞位跟手（left/bottom 按位移），拖动期挂禁选类、松手摘类并落盘', () => {
    mount();
    const surface = container.querySelector('.cd-drag-surface')!;
    act(() => {
      pointer(surface, 'pointerdown', 500, 650);
    });
    act(() => {
      pointer(window, 'pointermove', 560, 610);
    });
    expect(document.documentElement.classList.contains('pp-composer-dragging')).toBe(true);
    expect(api.dragging).toBe(true);
    act(() => {
      pointer(window, 'pointerup', 560, 610);
    });
    expect(document.documentElement.classList.contains('pp-composer-dragging')).toBe(false);
    expect(api.dragging).toBe(false);
    expect(saveComposerPos).toHaveBeenCalled();
  });

  it('只点不拖（位移不过阈值）⇒ 不落盘（坞无故跳回底部是老病灶）', () => {
    mount();
    const surface = container.querySelector('.cd-drag-surface')!;
    act(() => {
      pointer(surface, 'pointerdown', 500, 650);
    });
    act(() => {
      pointer(window, 'pointerup', 500, 650);
    });
    expect(api.dragging).toBe(false);
    expect(saveComposerPos).not.toHaveBeenCalled();
  });

  it('失联（窗口失焦）⇒ 取消：禁选类摘下、位置回滚、**不落盘**', () => {
    mount();
    const surface = container.querySelector('.cd-drag-surface')!;
    act(() => {
      pointer(surface, 'pointerdown', 500, 650);
    });
    act(() => {
      pointer(window, 'pointermove', 700, 500);
    });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(document.documentElement.classList.contains('pp-composer-dragging')).toBe(false);
    expect(api.dragging).toBe(false);
    expect(saveComposerPos).not.toHaveBeenCalled();
  });
});
