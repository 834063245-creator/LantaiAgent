// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-font — 字体查看器（渲染面补全 B10，2026-09-23）：
//   ① 认领表 = 宿主层分类表（`VIEWER_FONT_EXTS` ↔ `viewerClassOf` 的 'font' 类）；
//   ② 环境不支持（jsdom 无 CSS Font Loading API）⇒ 一行可读提示，**文件身份照显**
//      （文件名 / 扩展名 / 字节数）——不空白、不 JSON 兜底；
//   ③ 支持环境（桩 `FontFace` + 桩 `document.fonts`）⇒ 装载走 `.load()` →
//      `document.fonts.add`，正文档出样本行 + 受控输入行 + 字号阶梯，输入跟着变；
//   ④ `.load()` 失败 ⇒ 带原因的错误行；⑤ 读口坏响应 ⇒ 宿主可读错误行。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { VIEWER_FONT_EXTS, viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
import { fontViewer } from '../src/plugins/builtin/renderers/viewers/font';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/** 读口成功响应（`fs_cap read_base64` 的二进制结局：{path, base64}）。 */
function readOk(base64: string): string {
  return JSON.stringify({ path: 'D:/a.ttf', base64 });
}

/** 注册自带 + 用完摘除：主编排批次把本查看器加进 `viewers/index.ts` 后，
 *  这里不因重名再注册（装载期重名是硬拒绝，不是可忽略的重复）。 */
function withViewerRegistered(): () => void {
  if (viewerRegistry.get(fontViewer.id)) return () => {};
  return viewerRegistry.register(fontViewer);
}

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const disposeViewer = withViewerRegistered();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  try {
    await fn();
  } finally {
    await f3.dispose();
    await f2.dispose();
    await f1.dispose();
    disposeViewer();
  }
}

function mediaBlock(payload: unknown): SourcedBlock {
  return {
    ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
  };
}

/** 桩：支持 CSS Font Loading API 的宿主（jsdom 没有——按需装上，用完摘除）。 */
function stubFontLoading(load: () => Promise<unknown>): {
  add: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const add = vi.fn();
  const del = vi.fn();
  class FakeFontFace {
    constructor(
      public family: string,
      public source: string,
    ) {}
    load(): Promise<unknown> {
      return load();
    }
  }
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add, delete: del } });
  return { add, del };
}

function unstubFontLoading(): void {
  delete (document as { fonts?: unknown }).fonts;
  vi.unstubAllGlobals();
}

describe('字体查看器 · 认领面（B10）', () => {
  it('认领表就是宿主层分类表（ttf/otf/woff/woff2 全在 font 类）', () => {
    expect([...fontViewer.exts]).toEqual([...VIEWER_FONT_EXTS]);
    expect([...fontViewer.exts]).toEqual(['ttf', 'otf', 'woff', 'woff2']);
    for (const ext of VIEWER_FONT_EXTS) expect(viewerClassOf(ext), ext).toBe('font');
  });

  it('装载面：data-uri 读取 + 每个 ext 都有 MIME（宿主拼得出 data URI）', async () => {
    expect(fontViewer.id).toBe('font');
    expect(fontViewer.needsBytes).toBe(true);
    for (const ext of fontViewer.exts) expect(fontViewer.mimes?.[ext], ext).toBeTruthy();
    await withRenderers(async () => {
      for (const ext of fontViewer.exts) expect(viewerRegistry.resolve(ext)?.id, ext).toBe('font');
    });
  });

  it('本查看器不认领别类的扩展名（认领表逐字 = 分类表）', () => {
    for (const ext of ['eml', 'srt', 'vtt', 'pdf', 'glb', 'md', 'csv']) {
      expect(fontViewer.exts.includes(ext), ext).toBe(false);
    }
  });
});

describe('字体查看器 · 渲染与失败面（B10）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function renderFont(payload: unknown): Promise<void> {
    const Comp = resolveAssetBlock('file', 'media')!;
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock(payload) }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  /** 桩环境撤除**之前**卸载（effect 清理要在 Font Loading API 还在时跑）——
   *  卸载后 root 置空，afterEach 不再重复卸载。 */
  async function unmountViewer(): Promise<void> {
    const current = root;
    root = null;
    if (!current) return;
    await act(async () => {
      current.unmount();
    });
  }

  it('环境不支持字体预览 ⇒ 提示 + 文件身份照显（名 / 扩展名 / 字节数），不空白', async () => {
    expect('fonts' in document, 'jsdom 应无 CSS Font Loading API——本用例的前提').toBe(false);
    vi.mocked(typedRpc).mockResolvedValue(readOk('QUJD'));
    await withRenderers(async () => {
      await renderFont({ filePath: 'D:/a.ttf', ext: 'ttf', label: '测试字体.ttf' });
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read_base64',
        file_path: 'D:/a.ttf',
        is_agent: false,
      });
      expect(container.querySelector('.pp-viewer-font-meta-name')?.textContent).toBe('测试字体.ttf');
      expect(container.querySelector('.pp-viewer-font-meta-ext')?.textContent).toBe('ttf');
      expect(container.querySelector('.pp-viewer-font-meta-size')?.textContent).toBe('约 3 B');
      expect(container.querySelector('.pp-viewer-note')?.textContent).toContain('当前环境不支持字体预览');
      // 预览不可用 ⇒ 不拿回退字体冒充该字体的字形
      expect(container.querySelector('.pp-viewer-font-sample')).toBeNull();
    });
  });

  it('支持环境 ⇒ FontFace 装载（load → fonts.add）+ 样本 / 受控输入 / 字号阶梯', async () => {
    const loads: string[] = [];
    const { add } = stubFontLoading(() => {
      loads.push('load');
      return Promise.resolve({ family: 'pp-viewer-font-sample' });
    });
    try {
      vi.mocked(typedRpc).mockResolvedValue(readOk('QUJD'));
      await withRenderers(async () => {
        await renderFont({ filePath: 'D:/a.ttf', ext: 'ttf', label: '测试字体.ttf' });
        expect(loads.length).toBe(1);
        expect(add).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.pp-viewer-note')?.textContent).toContain('已装载');
        expect(container.querySelector('.pp-viewer-font-sample')?.textContent).toContain('永和九年');
        const ladder = [...container.querySelectorAll<HTMLElement>('.pp-viewer-font-ladder-item')];
        expect(ladder.map((el) => el.style.fontSize)).toEqual(['14px', '18px', '24px', '32px']);
        // 受控输入：输入的字用该字体显示（React 受控 ⇒ 走原生 setter + input 事件）
        const input = container.querySelector('.pp-viewer-font-input') as HTMLInputElement;
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(input, '兰台');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect((container.querySelector('.pp-viewer-font-input') as HTMLInputElement).value).toBe('兰台');
        expect(container.querySelector('.pp-viewer-font-custom-line')?.textContent).toBe('兰台');
      });
    } finally {
      await unmountViewer();
      unstubFontLoading();
    }
  });

  it('.load() 失败 ⇒ 带原因的可读错误行（不空白、不假装装载成功）', async () => {
    stubFontLoading(() => Promise.reject(new Error('不是有效的字体文件')));
    try {
      vi.mocked(typedRpc).mockResolvedValue(readOk('QUJD'));
      await withRenderers(async () => {
        await renderFont({ filePath: 'D:/a.woff2', ext: 'woff2', label: '坏字体.woff2' });
        const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
        expect(err).toContain('字体装载失败');
        expect(err).toContain('不是有效的字体文件');
        expect(container.querySelector('.pp-viewer-font-sample')).toBeNull();
        // 文件身份仍在（失败不吞元信息）
        expect(container.querySelector('.pp-viewer-font-meta-name')?.textContent).toBe('坏字体.woff2');
      });
    } finally {
      await unmountViewer();
      unstubFontLoading();
    }
  });

  it('读口失败（拒绝）⇒ 可读错误行带原因（不空白、不 JSON 兜底）', async () => {
    vi.mocked(typedRpc).mockRejectedValue(new Error('文件不存在'));
    await withRenderers(async () => {
      await renderFont({ filePath: 'D:/a.ttf', ext: 'ttf', label: '测试字体.ttf' });
      const line = container.querySelector('.pp-media-loading')?.textContent ?? '';
      expect(line).toContain('读取失败');
      expect(line).toContain('文件不存在');
      expect(container.querySelector('.pp-viewer-font')).toBeNull();
    });
  });

  it('字节未取到（读口给空 base64）⇒ 可读错误 + 文件身份，不空白', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(''));
    await withRenderers(async () => {
      await renderFont({ filePath: 'D:/a.ttf', ext: 'ttf', label: '测试字体.ttf' });
      // 宿主在字节未就绪时不渲染查看器（加载态/失败态由宿主负责）——两条路都不许空白
      const body = container.querySelector('.pp-viewer-body')?.textContent ?? '';
      expect(body.length).toBeGreaterThan(0);
    });
  });
});
