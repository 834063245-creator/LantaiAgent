// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话文件引用可点（2026-11-23 相对路径批）——正文两种写法都走宿主 openWith：
//   · Markdown 链接 [x](docs/a.md)：相对路径按**工作区根**解析成绝对路径后点开；
//   · 行内码 `docs/a.md`：整段是文件引用就可点（绝对/相对同一判据）；
//   · 外部 URL / 普通行内码 / 无工作区 ⇒ 保持原样，不误伤、不静默改道。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellStore } from '../src/app/shell-store';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { builtinRendererDefs } from '../src/plugins/builtin/paper-renderers/renderers';

const openWith = vi.fn((_path: string) => true);

function markdownRenderer() {
  const def = builtinRendererDefs().find((d) => d.kind === 'markdown');
  expect(def, '内置 markdown 渲染器存在').toBeDefined();
  return def!.component;
}

function block(text: string): SourcedBlock {
  return createBlock('markdown', { text } as never, { messageId: 'm', part: null });
}

describe('paper-renderers — 会话文件引用点开（相对路径批）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    useShellStore.getState().setProjectPath('D:/ws');
    (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__ = {
      windows: { openWith },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    delete (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__;
    useShellStore.getState().setProjectPath('');
    openWith.mockClear();
  });

  const render = (text: string) => {
    act(() => {
      root?.render(createElement(markdownRenderer(), { block: block(text) }));
    });
  };

  it('Markdown 链接的相对路径 → 按工作区根解析后点开（占位 href 不导航）', () => {
    render('[说明](docs/README.md)');
    const a = container!.querySelector('a.pp-md-a') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(a.getAttribute('href')).toBe('docs/README.md');
    expect(a.getAttribute('data-tip')).toBe('D:/ws/docs/README.md');
    let canceled = false;
    act(() => {
      canceled = !a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(canceled).toBe(true);
    expect(openWith).toHaveBeenCalledWith('D:/ws/docs/README.md');
  });

  it('Markdown 链接的绝对路径 → 归一后点开', () => {
    render('[说明](D:\\proj\\docs\\a.md#L24)');
    const a = container!.querySelector('a.pp-md-a') as HTMLAnchorElement;
    act(() => {
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(openWith).toHaveBeenCalledWith('D:/proj/docs/a.md');
  });

  it('外部 URL 保持普通链接（target=_blank，不经宿主 openWith）', () => {
    render('[站点](https://example.com/x)');
    const a = container!.querySelector('a.pp-md-a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com/x');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.hasAttribute('data-tip')).toBe(false);
  });

  it('行内码整段是相对路径 → 可点按钮；不是路径的行内码保持 code 元素', () => {
    render('看 `docs/plans/a.md` 与 `npm run build`');
    const refBtn = container!.querySelector('button.pp-md-ci--ref') as HTMLButtonElement;
    expect(refBtn).not.toBeNull();
    expect(refBtn.textContent).toBe('docs/plans/a.md');
    act(() => {
      refBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openWith).toHaveBeenCalledWith('D:/ws/docs/plans/a.md');
    const plain = [...container!.querySelectorAll('code.pp-md-ci')].map((n) => n.textContent);
    expect(plain).toContain('npm run build');
  });

  it('无工作区根 ⇒ 相对路径不拦截（链接保持原 href，行内码保持 code 元素）', () => {
    useShellStore.getState().setProjectPath('');
    render('[说明](docs/README.md) 与 `docs/README.md`');
    const a = container!.querySelector('a.pp-md-a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('docs/README.md');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(container!.querySelector('button.pp-md-ci--ref')).toBeNull();
  });
});
