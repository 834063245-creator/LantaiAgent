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
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
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

/* ── B1（2026-09-23）：查看器宿主 = 按扩展名路由 + 公共壳 + 降级链 ──────────────
 * 既有四条用例（上）在宿主改造后**逐字未改**——这是「图片/视频迁入查看器面 =
 * 行为零漂移」的对拍证据；下面四条覆盖本批新增面（音频 / 壳 / 超限 / 渲染抛错）。 */
describe('查看器宿主（B1）：音频 · 公共壳 · 降级链', () => {
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

  async function renderMedia(payload: unknown): Promise<void> {
    const Comp = resolveAssetBlock('file', 'media')!;
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock(payload) }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('音频 ext → 音频查看器（原生播放器 + 诚实时长读数），字节经 fs_cap 取回', async () => {
    vi.mocked(typedRpc).mockResolvedValue('QUJD');
    await withRenderers(async () => {
      await renderMedia({ filePath: 'D:/a.mp3', ext: 'mp3', label: '曲' });
      const el = container.querySelector('.pp-viewer-audio-el');
      expect(el).not.toBeNull();
      expect(el?.getAttribute('aria-label')).toBe('曲');
      expect(el?.getAttribute('src')).toBe('data:audio/mpeg;base64,QUJD');
      expect(container.querySelector('.pp-viewer-label')?.textContent).toBe('曲');
      // jsdom 无媒体栈 ⇒ metadata 永不就绪：读数必须诚实说「未知」，不假装 0:00
      expect(container.querySelector('.pp-viewer-audio-meta')?.textContent).toBe('时长未知');
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read_base64',
        file_path: 'D:/a.mp3',
        is_agent: false,
      });
    });
  });

  it('公共壳：.pp-viewer 出题签行（带 asset.title）+ 题名行；旧容器名 `.pp-media` 已退休', async () => {
    vi.mocked(typedRpc).mockResolvedValue('QUJD');
    await withRenderers(async () => {
      await renderMedia({ filePath: 'D:/a.png', ext: 'png', label: '图' });
      expect(container.querySelector('.pp-viewer')).not.toBeNull();
      expect(container.querySelector('.pp-media')).toBeNull(); // 破坏性改名，不做双写兼容
      expect(container.querySelector('.pp-plate-title')?.textContent).toBe('t'); // mediaBlock 的 asset.title
      expect(container.querySelector('.pp-media-img')).not.toBeNull(); // 查看器体仍在壳内
    });
  });

  it('字节超 maxBytes → 可读错误 + 文件壳（不静默截断、不渲染查看器体）', async () => {
    const dispose = viewerRegistry.register({
      id: 'tmp-big',
      exts: ['zzbig'],
      mimes: { zzbig: 'application/octet-stream' },
      needsBytes: true,
      maxBytes: 4,
      component: () => createElement('div', { className: 'tmp-big-body' }),
    });
    try {
      vi.mocked(typedRpc).mockResolvedValue('QUJDRA=='); // base64 → 6 字节 > 4 上限
      await withRenderers(async () => {
        await renderMedia({ filePath: 'D:/a.zzbig', ext: 'zzbig', label: '大' });
        expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('超过「tmp-big」查看器的');
        expect(container.querySelector('.pp-media-file')).not.toBeNull();
        expect(container.querySelector('.tmp-big-body')).toBeNull();
      });
    } finally {
      dispose();
    }
  });

  it('查看器渲染抛错 → 错误边界兜住：可读错误（带查看器 id）+ 文件壳，不炸纸面', async () => {
    const dispose = viewerRegistry.register({
      id: 'tmp-boom',
      exts: ['zzboom'],
      needsBytes: false,
      component: () => {
        throw new Error('boom-render');
      },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); // React 照例记一次，测试面静音
    try {
      await withRenderers(async () => {
        await renderMedia({ filePath: 'D:/a.zzboom', ext: 'zzboom', label: '坏' });
        expect(container.querySelector('.pp-viewer-error')?.textContent).toContain(
          '查看器「tmp-boom」渲染失败：boom-render',
        );
        expect(container.querySelector('.pp-media-file')).not.toBeNull();
        expect(typedRpc).not.toHaveBeenCalled(); // needsBytes=false ⇒ 不读字节
      });
    } finally {
      spy.mockRestore();
      dispose();
    }
  });
});
