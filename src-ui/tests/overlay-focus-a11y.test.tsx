// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// frontend-overlay-a11y-plan 档位 A 守护：
// - Overlay 原语（portal 到 body / 面板内就地 / 背景 inert / 遮罩点关）
// - useDialogEscape 单点 Escape 语义（enabled / blockPropagation / capture）
// - dialog-focus 的 FOCUSABLE 含 [contenteditable]
// - CommandPalette ARIA（listbox/option/aria-activedescendant/aria-selected）

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerActions } from '../src/app/actions';
import { CommandPalette } from '../src/app/CommandPalette';
import { mountDialogFocus } from '../src/app/dialog-focus';
import { Overlay, useDialogEscape } from '../src/app/overlay';
import { useShellStore } from '../src/app/shell-store';

function Harness({
  open,
  onClose,
  portal,
  inertBackground,
}: {
  open: boolean;
  onClose: () => void;
  portal?: boolean;
  inertBackground?: boolean;
}) {
  return createElement(
    Overlay,
    { open, onClose, portal, inertBackground, className: 'test-overlay' },
    createElement('div', { className: 'test-sheet' }, 'sheet'),
  );
}

/** useDialogEscape 消费组件（enabled 由父控制） */
function EscapeHarness({ onClose, enabled }: { onClose: () => void; enabled: boolean }) {
  useDialogEscape(onClose, { enabled });
  return createElement('div', null, 'escape-consumer');
}

describe('Overlay 原语', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
  });

  it('closed → 渲染 null；open → 就地渲染 sheet', () => {
    act(() => {
      root?.render(createElement(Harness, { open: false, onClose: () => {} }));
    });
    expect(container!.querySelector('.test-overlay')).toBeNull();
    act(() => {
      root?.render(createElement(Harness, { open: true, onClose: () => {} }));
    });
    expect(container!.querySelector('.test-overlay')).not.toBeNull();
    expect(container!.querySelector('.test-sheet')?.textContent).toBe('sheet');
  });

  it('portal=true → 渲染到 document.body 而非容器内', () => {
    act(() => {
      root?.render(createElement(Harness, { open: true, onClose: () => {}, portal: true }));
    });
    // 容器本身不包含 overlay；body 里有
    expect(container!.querySelector('.test-overlay')).toBeNull();
    expect(document.body.querySelector('.test-overlay')).not.toBeNull();
  });

  it('遮罩点关：点 overlay 空白关闭，点 sheet 不关', () => {
    const onClose = vi.fn();
    act(() => {
      root?.render(createElement(Harness, { open: true, onClose }));
    });
    const veil = container!.querySelector('.test-overlay')!;
    const sheet = container!.querySelector('.test-sheet')!;
    act(() => {
      veil.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      sheet.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1); // sheet 内点击不关
  });

  it('Escape 关闭（面板内模态默认 capture + 拦截冒泡）', () => {
    const onClose = vi.fn();
    act(() => {
      root?.render(createElement(Harness, { open: true, onClose }));
    });
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(ev);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('背景 inert：open 时遮罩兄弟 inert，关闭后还原', () => {
    act(() => {
      root?.render(
        createElement('div', null, [
          createElement('div', { key: 'bg', className: 'bg-sibling' }),
          createElement(Harness, { key: 'ov', open: true, onClose: () => {}, inertBackground: true }),
        ]),
      );
    });
    const bg = container!.querySelector<HTMLElement>('.bg-sibling')!;
    expect(bg.inert).toBe(true);
    // 关闭后还原
    act(() => {
      root?.render(
        createElement('div', null, [
          createElement('div', { key: 'bg', className: 'bg-sibling' }),
          createElement(Harness, { key: 'ov', open: false, onClose: () => {}, inertBackground: true }),
        ]),
      );
    });
    expect(container!.querySelector<HTMLElement>('.bg-sibling')!.inert).toBe(false);
  });
});

describe('useDialogEscape 单点 Escape', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
  });

  it('enabled 时 Esc 触发 onClose；disabled 不触发', () => {
    const onClose = vi.fn();
    act(() => {
      root?.render(createElement(EscapeHarness, { onClose, enabled: true }));
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      root?.render(createElement(EscapeHarness, { onClose, enabled: false }));
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1); // 未再触发
  });

  it('非 Escape 键不触发', () => {
    const onClose = vi.fn();
    act(() => {
      root?.render(createElement(EscapeHarness, { onClose, enabled: true }));
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('dialog-focus FOCUSABLE 含 contenteditable', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let opener: HTMLButtonElement | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
  });

  it('mountDialogFocus 首个可聚焦项 = contenteditable（此前被漏掉）', () => {
    opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const holder = document.createElement('div');
    holder.innerHTML = '<div class="ce" contenteditable="true">editable</div><button>b</button>';
    container!.appendChild(holder);
    const dispose = mountDialogFocus(holder, { initial: null });
    expect(document.activeElement).toBe(holder.querySelector('.ce'));
    dispose();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('CommandPalette ARIA（档位 A-3）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // 动作注册表：至少一个「操作」组动作，供 palette 清单展开
    registerActions([{ id: 'test-action', group: '操作', label: '测试动作', run: () => {} }]);
    useShellStore.setState({ paletteOpen: true });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    useShellStore.setState({ paletteOpen: false });
  });

  it('listbox + option + aria-activedescendant + aria-selected 接线', () => {
    act(() => {
      root?.render(createElement(CommandPalette));
    });
    const list = container!.querySelector('[role="listbox"]');
    expect(list).not.toBeNull();
    expect(list?.id).toBe('pal-listbox');
    const opts = container!.querySelectorAll('[role="option"]');
    expect(opts.length).toBeGreaterThan(0);
    const input = container!.querySelector('input[role="combobox"]')!;
    expect(input.getAttribute('aria-controls')).toBe('pal-listbox');
    expect(input.getAttribute('aria-activedescendant')).toBe('pal-opt-0');
    const first = opts[0];
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(first.id).toBe('pal-opt-0');
    // 组头是 presentation（不在 option 集合里）
    expect(container!.querySelectorAll('.pal-group[role="presentation"]').length).toBeGreaterThan(0);
  });
});
