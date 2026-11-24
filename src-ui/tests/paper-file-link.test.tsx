// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话文件引用可点（2026-11-23 相对路径批；2026-11-24 stat 门禁批）——
//   · Markdown 链接 [x](docs/a.md)：相对路径按**工作区根**解析，stat 核实后才可点；
//   · 行内码 `docs/a.md`：整段是文件引用 + stat 核实可开 → 可点；
//   · 外部 URL / 普通行内码 / 无工作区 / 目录 / 文卷打不开的后缀 ⇒ 保持原样；
//   · 点击由宿主 openWith 承接，导航被拦。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellStore } from '../src/app/shell-store';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { builtinRendererDefs } from '../src/plugins/builtin/paper-renderers/renderers';

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }));

vi.mock('../src/plugins/builtin/paper-renderers/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/plugins/builtin/paper-renderers/host')>();
  return {
    ...actual,
    typedRpc: (method: string, params: Record<string, unknown>) => statMock(method, params),
  };
});

const openWith = vi.fn((_path: string) => true);

function markdownRenderer() {
  const def = builtinRendererDefs().find((d) => d.kind === 'markdown');
  expect(def, '内置 markdown 渲染器存在').toBeDefined();
  return def!.component;
}

function block(text: string): SourcedBlock {
  return createBlock('markdown', { text } as never, { messageId: 'm', part: null });
}

/** 等 stat 门禁的 effect/微任务落定（无 testing-library，act + 0ms 足矣）。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('paper-renderers — 会话文件引用点开（stat 门禁批）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    useShellStore.getState().setProjectPath('D:/ws');
    statMock.mockReset();
    statMock.mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      const fp = String(params.file_path ?? '');
      if (fp.includes('missing') || fp.includes('gone')) throw new Error('无法读取文件');
      if (fp.endsWith('docs-dir.md')) return { path: fp, size: 0, is_dir: true };
      return { path: fp, size: 1, is_dir: false };
    });
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

  const render = async (text: string) => {
    await act(async () => {
      root?.render(createElement(markdownRenderer(), { block: block(text) }));
    });
    await flush();
  };

  it('Markdown 链接的相对路径 → stat 核实后按工作区根解析点开（占位 href 不导航）', async () => {
    await render('[说明](docs/README.md)');
    const a = container!.querySelector('a.pp-md-a') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(a.getAttribute('href')).toBe('docs/README.md');
    expect(a.getAttribute('data-tip')).toBe('D:/ws/docs/README.md');
    let canceled = false;
    act(() => {
      canceled = !a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(canceled).toBe(true);
    await flush();
    expect(openWith).toHaveBeenCalledWith('D:/ws/docs/README.md');
  });

  it('Markdown 链接的绝对路径 → 归一后点开', async () => {
    await render('[说明](D:\\proj\\docs\\a.md#L24)');
    const a = container!.querySelector('a.pp-md-a') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    act(() => {
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(openWith).toHaveBeenCalledWith('D:/proj/docs/a.md');
  });

  it('外部 URL 保持普通链接（target=_blank，不经宿主 openWith）', async () => {
    await render('[站点](https://example.com/x)');
    const a = container!.querySelector('a.pp-md-a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com/x');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.hasAttribute('data-tip')).toBe(false);
    expect(statMock).not.toHaveBeenCalled();
  });

  it('行内码整段是相对路径 → 可点按钮；不是路径的行内码保持 code 元素', async () => {
    await render('看 `docs/plans/a.md` 与 `npm run build` 与 `doc.save`');
    const refBtn = container!.querySelector('button.pp-md-ci--ref') as HTMLButtonElement;
    expect(refBtn).not.toBeNull();
    expect(refBtn.textContent).toBe('docs/plans/a.md');
    act(() => {
      refBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(openWith).toHaveBeenCalledWith('D:/ws/docs/plans/a.md');
    const plain = [...container!.querySelectorAll('code.pp-md-ci')].map((n) => n.textContent);
    expect(plain).toContain('npm run build');
    expect(plain).toContain('doc.save');
  });

  it('stat 说不存在的文件 / 目录 / 非文卷后缀 ⇒ 不可点（不闪假链接）', async () => {
    await render('`docs/missing.md` `docs-dir.md` `docs/pic.png` `docs/README.md`');
    const buttons = [...container!.querySelectorAll('button.pp-md-ci--ref')].map((n) => n.textContent);
    expect(buttons).toEqual(['docs/README.md']);
    const codes = [...container!.querySelectorAll('code.pp-md-ci')].map((n) => n.textContent);
    expect(codes).toEqual(['docs/missing.md', 'docs-dir.md', 'docs/pic.png']);
    expect(container!.querySelector('a.pp-md-a')).toBeNull();
  });

  it('不可开的本地链接落成不可点字面（保留 href 语义场但不导航）', async () => {
    await render('[坏链](docs/missing.md)');
    expect(container!.querySelector('a.pp-md-a')).toBeNull();
    expect(container!.querySelector('span.pp-md-a--dead')?.textContent).toBe('坏链');
  });

  it('无工作区根 ⇒ 相对路径不拦截（链接保持原 href，行内码保持 code 元素）', async () => {
    useShellStore.getState().setProjectPath('');
    await render('[说明](docs/README.md) 与 `docs/README.md`');
    const a = container!.querySelector('a.pp-md-a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('docs/README.md');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(container!.querySelector('button.pp-md-ci--ref')).toBeNull();
  });
});
