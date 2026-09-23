// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 渲染器产物 · 生产同形装载（渲染面补全 B1/B2，2026-09-23）——
// `tests/face-deps-seal.test.ts` 只覆盖**工具域**产物（面产物被它显式排除），渲染器面
// 的磁盘通道此前没有运行期考官。本用例把它补上，钉四件事（都是真撞过的缝）：
//   ① 产物在 `window.__lantai_plugin_host__` 桥下能装载并注册行 → 渲染媒体块
//      （自包含契约的**运行期**对拍，不只靠构建期静态检查）；
//   ② 别名桥的 React 出口够用（`Component`——B1 错误边界类组件；`useMemo`——B2 代码
//      查看器的高亮记忆化）；
//   ③ 子目录查看器（`viewers/*`）在产物域能跑：B1 首构即撞「宿主桥重定向只认同目录
//      形态」的缺口（`scripts/build-builtin-plugins.mjs` 已修），本用例防它回潮；
//   ④ B2 的 hljs 是**产物内联**依赖：产物域里真出高亮 span（应用 bundle 不受影响）。
//
// `dist-plugins` 不在场时跳过（本地 `npm run build` 后即生效；CI 的 build 步已产出）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveRenderer } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';

const ENTRY = join(__dirname, '..', 'dist-plugins', 'builtin', 'hologram', 'renderers', 'entry.js');
const hasArtifact = existsSync(ENTRY);
const d = hasArtifact ? describe : describe.skip;

/** 读口桩：`read`（文本窗口）给 content，其余（read_base64）给 base64。
 *  ⚠️ **模块级单例**：产物在首次 import 时就把宿主桥收进模块常量
 *  （renderer-host.aliased.ts 的 `const host = requireHost()`）⇒ 每个用例换一个新 mock
 *  是无效的（产物仍打旧对象）。故桥与桩在本文件生命周期内身份稳定，用例间只 `mockClear`。 */
const rpcMock = vi.fn(async (_method: string, params: Record<string, unknown>) =>
  params.action === 'read'
    ? JSON.stringify({ path: 'D:/a.ts', content: 'const a = 1;\nexport {};' })
    : JSON.stringify({ base64: 'QUJD' }),
);
const BRIDGE = {
  react: React, // 产物域取用的就是宿主 React 本体（loader.ts 同款注入）
  Overlay: () => null,
  rpc: rpcMock,
};
(globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__ = BRIDGE;
afterAll(() => {
  delete (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__;
});

/** 媒体块（kind='file' + presentation='media'——与 asset-media-load 同一形状）。 */
function mediaBlock(payload: unknown): SourcedBlock {
  return {
    ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
  };
}

/** 起服务 + 装载磁盘产物，把一个可渲染的行交给用例（用完逆序拆）。 */
async function withArtifact(fn: (render: (payload: unknown) => Promise<void>) => Promise<void>): Promise<void> {
  const ctx = new Context();
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  try {
    await ctx.plugin(compositionServicesPlugin);
    await ctx.plugin(rendererServicePlugin);
    const mod = (await import(/* @vite-ignore */ `file://${ENTRY.replace(/\\/g, '/')}`)) as {
      default?: { name: string; apply: (ctx: unknown) => void };
    };
    const plugin = mod.default;
    expect(plugin?.name, '产物无 default 插件对象').toBe('hologram/renderers');
    const fiber = await ctx.plugin(plugin);
    const ids = ctx.renderers.list().map((r) => r.id);
    expect(ids).toContain('plugin/hologram/renderers/media');
    // 磁盘行晚于出厂行注册 ⇒ resolveRenderer 取到的就是产物那份（行覆盖语义）
    const row = resolveRenderer('media');
    expect(row?.id).toBe('plugin/hologram/renderers/media');
    const Comp = row!.component;
    await fn(async (payload: unknown) => {
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(Comp, { block: mediaBlock(payload) }));
      });
      await act(async () => {
        await Promise.resolve();
      });
    });
    await fiber.dispose();
  } finally {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    await ctx[Symbol.asyncDispose]?.();
  }
}

d('渲染器产物：磁盘通道装载 + 查看器面渲染（dist-plugins 在场）', () => {
  afterEach(() => {
    rpcMock.mockClear();
  });

  it('装载 → 注册行 → 子目录查看器（音频）在产物域真渲染 + fs 能力口取字节', async () => {
    await withArtifact(async (render) => {
      await render({ filePath: 'D:/a.mp3', ext: 'mp3', label: '曲' });
      expect(document.querySelector('.pp-viewer')).not.toBeNull();
      expect(document.querySelector('.pp-viewer-audio-el')?.getAttribute('aria-label')).toBe('曲');
      expect(rpcMock).toHaveBeenCalledWith('fs_cap', {
        action: 'read_base64',
        file_path: 'D:/a.mp3',
        is_agent: false,
      });
    });
  }, 90_000);

  it('B2 代码查看器在产物域：hljs 内联生效（真出高亮 span）+ 行窗口走 fs_cap read', async () => {
    await withArtifact(async (render) => {
      await render({ filePath: 'D:/a.ts', ext: 'ts', label: 'a.ts' });
      expect(rpcMock).toHaveBeenCalledWith('fs_cap', {
        action: 'read',
        file_path: 'D:/a.ts',
        limit: 2001,
        is_agent: false,
      });
      expect(document.querySelector('.pp-viewer-code-gutter')?.textContent).toBe('1\n2');
      expect(document.querySelector('.pp-viewer-code-pre code')?.innerHTML).toContain('hljs-keyword');
    });
  }, 90_000);
});
