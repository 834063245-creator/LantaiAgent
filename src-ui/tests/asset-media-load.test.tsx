// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-media-load — 媒体资产块图片加载链路回归（2026-08-30）：
//   Tauri WebView 拦裸本地路径（<img src="D:/..."> 打不开），MediaBody 必须
//   经 read_file_base64 读成 base64 再喂 data: URI。本测试 mock typedRpc，
//   验证：图片 → data URI img；未知扩展名 → 文件壳（不调 RPC）；读取失败 → 报错。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  // P1：媒体渲染器由内置渲染器插件注册（service 不再构造期注册资产行）
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  await fn();
  await f3.dispose();
  await f2.dispose();
  await f1.dispose();
}

function mediaBlock(payload: unknown): SourcedBlock {
  return {
    ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
  };
}

describe('composition/asset-renderers — 媒体图片经 read_file_base64 加载', () => {
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

  it('图片路径 → 渲染 data URI 的 img，且调用 read_file_base64', async () => {
    vi.mocked(typedRpc).mockResolvedValue('QUJD'); // base64("ABC")
    await withRenderers(async () => {
      const Comp = resolveAssetBlock('file', 'media')!;
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(Comp, { block: mediaBlock({ filePath: 'D:/a.png', ext: 'png', label: '图' }) }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      const img = container.querySelector('.pp-media-img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('data:image/png;base64,QUJD');
      expect(img?.getAttribute('alt')).toBe('图');
      // fs 域收口（kernel-capability-c3-design.md）：read_file_base64 从 tool_call
      // 信封换 fs_cap read_base64 能力口直呼（用户路径 is_agent=false）——
      // 返回 JSON {path, base64}，组件取 base64 喂 data: URI
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read_base64',
        file_path: 'D:/a.png',
        is_agent: false,
      });
    });
  });

  it('未知扩展名 → 文件壳，且不调用 read_file_base64', async () => {
    await withRenderers(async () => {
      const Comp = resolveAssetBlock('file', 'media')!;
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(Comp, { block: mediaBlock({ filePath: 'D:/a.xyz', ext: 'xyz', label: 'x' }) }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('.pp-media-file')).not.toBeNull();
      expect(container.querySelector('.pp-media-img')).toBeNull();
      expect(typedRpc).not.toHaveBeenCalled();
    });
  });

  it('读取失败 → 显示加载错误，不渲染裂图', async () => {
    vi.mocked(typedRpc).mockRejectedValue(new Error('boom'));
    await withRenderers(async () => {
      const Comp = resolveAssetBlock('file', 'media')!;
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(Comp, { block: mediaBlock({ filePath: 'D:/a.png', ext: 'png' }) }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      const loading = container.querySelector('.pp-media-loading');
      expect(loading).not.toBeNull();
      expect(loading?.textContent).toContain('读取失败');
      expect(container.querySelector('.pp-media-img')).toBeNull();
    });
  });

  it('点击缩略图 → 打开全屏预览浮层；Esc 关闭', async () => {
    vi.mocked(typedRpc).mockResolvedValue('QUJD'); // base64("ABC")
    await withRenderers(async () => {
      const Comp = resolveAssetBlock('file', 'media')!;
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(Comp, { block: mediaBlock({ filePath: 'D:/a.png', ext: 'png' }) }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('.pp-media-preview-overlay')).toBeNull();
      const openBtn = container.querySelector('.pp-media-open') as HTMLButtonElement | null;
      expect(openBtn).not.toBeNull();
      await act(async () => {
        openBtn!.click();
      });
      const overlay = document.querySelector('.pp-media-preview-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay?.querySelector('.pp-media-preview')?.getAttribute('src')).toBe('data:image/png;base64,QUJD');
      // Esc 关闭
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(document.querySelector('.pp-media-preview-overlay')).toBeNull();
    });
  });
});
