// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 渲染器产物 · 生产同形装载（渲染面补全 B1，2026-09-23）——
// `tests/face-deps-seal.test.ts` 只覆盖**工具域**产物（面产物被它显式排除），渲染器面
// 的磁盘通道此前没有运行期考官。本用例把它补上，钉三件事（都是 B1 真撞过的缝）：
//   ① 产物在 `window.__lantai_plugin_host__` 桥下能装载并注册行 → 渲染媒体块
//      （自包含契约的**运行期**对拍，不只靠构建期静态检查）；
//   ② 别名桥的 React 出口够用（含 `Component`——查看器宿主的错误边界类组件用它）；
//   ③ 子目录查看器（`viewers/*`）在产物域能跑：B1 首构即撞「宿主桥重定向只认同目录
//      形态」的缺口（`scripts/build-builtin-plugins.mjs` 已修），本用例防它回潮。
//
// `dist-plugins` 不在场时跳过（本地 `npm run build` 后即生效；CI 的 build 步已产出）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveRenderer } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';

const ENTRY = join(__dirname, '..', 'dist-plugins', 'builtin', 'hologram', 'renderers', 'entry.js');
const hasArtifact = existsSync(ENTRY);
const d = hasArtifact ? describe : describe.skip;

/** 媒体块（kind='file' + presentation='media'——与 asset-media-load 同一形状）。 */
function mediaBlock(payload: unknown): SourcedBlock {
  return {
    ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
  };
}

d('渲染器产物：磁盘通道装载 + 查看器面渲染（dist-plugins 在场）', () => {
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
  });

  it('产物经宿主桥装载 → 注册渲染器行（磁盘行覆盖出厂行）', async () => {
    const rpc = vi.fn(async () => JSON.stringify({ base64: 'QUJD' }));
    (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__ = {
      react: React, // 产物域取用的就是宿主 React 本体（loader.ts 同款注入）
      Overlay: () => null,
      rpc,
    };
    const ctx = new Context();
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
      const resolved = resolveRenderer('media');
      expect(resolved?.id).toBe('plugin/hologram/renderers/media');

      // ③ 子目录查看器在产物域能真渲染：音频块 → 音频查看器 + fs 能力口取字节
      const Comp = resolved!.component;
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(Comp, { block: mediaBlock({ filePath: 'D:/a.mp3', ext: 'mp3', label: '曲' }) }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('.pp-viewer')).not.toBeNull();
      expect(container.querySelector('.pp-viewer-audio-el')?.getAttribute('aria-label')).toBe('曲');
      expect(rpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read_base64',
        file_path: 'D:/a.mp3',
        is_agent: false,
      });
      // ② 错误边界类组件的基类来自桥（`Component`）——装载期拿不到会当场炸在上面
      await fiber.dispose();
    } finally {
      await ctx[Symbol.asyncDispose]?.();
      delete (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__;
    }
  }, 90_000);
});
