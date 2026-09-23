// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-legacy-office — 旧 Office 出口（渲染面补全 P3 · B5 余项，2026-09-23）：
//   ① 三格式各出类型标记（doc → Word 97-2003 文档 / xls → Excel 97-2003 工作簿 /
//      ppt → PowerPoint 97-2003 演示文稿）+ 文件壳（`.pp-media-file` 家族）+ 一行说明；
//   ② **不解析**：零 RPC（既不读字节，也不碰 officecli——旧格式是 OLE 二进制，见 D5）；
//   ③ 系统打开按钮由**公共壳**提供（`.pp-viewer-open-system`），本查看器不自己画按钮；
//   ④ 无 filePath ⇒ 只出文件壳（没有可移交的文件，不出类型标记）。
//
// 注册行（`viewers/index.ts`）在用户缝里：本文件自带**幂等注册守卫**，用完 `dispose()`。
// 取 def 走动态 import（静态 import 会把 `viewers/legacy-office` 顶到渲染面之前求值）。

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

/** 注册守卫的 disposer（本文件注册过才非 null）。 */
let disposeLegacy: (() => void) | null = null;

/** 注册面取件：用户注册行已落 ⇒ 直接用；未落 ⇒ 动态取 def 自注册（幂等：`get(id)` 存在则跳过）。 */
async function ensureLegacyRegistered(): Promise<void> {
  if (viewerRegistry.get('legacy-office') || disposeLegacy) return;
  const mod = await import('../src/plugins/builtin/renderers/viewers/legacy-office');
  if (viewerRegistry.get('legacy-office')) return; // 用户注册行已落 ⇒ 不重复注册（同名装载期会 throw）
  disposeLegacy = viewerRegistry.register(mod.legacyOfficeViewer);
}

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  await ensureLegacyRegistered();
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

describe('旧 Office 出口（不解析：文件壳 + 类型标记 + 系统打开出口）', () => {
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

  async function renderFile(payload: unknown): Promise<void> {
    root?.unmount(); // 同一用例里换文件：先卸旧根（免得 createRoot 撞同一容器）
    root = null;
    const Comp = resolveAssetBlock('file', 'media')!;
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock(payload) }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('doc → 「Word 97-2003 文档」+ 文件壳 + 一行说明', async () => {
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/来文.doc', ext: 'doc', label: '来文.doc' });
      expect(container.querySelector('.pp-viewer-legacy-type')?.textContent).toBe('Word 97-2003 文档');
      expect(container.querySelector('.pp-media-file')).not.toBeNull();
      expect(container.querySelector('.pp-media-ext')?.textContent).toBe('doc');
      expect(container.querySelector('.pp-media-path')?.textContent).toBe('D:/来文.doc');
      expect(container.querySelector('.pp-viewer-note')?.textContent).toBe(
        '旧格式无法内嵌预览，已提供「用系统程序打开」',
      );
    });
  });

  it('xls → 「Excel 97-2003 工作簿」', async () => {
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/账.xls', ext: 'xls', label: '账.xls' });
      expect(container.querySelector('.pp-viewer-legacy-type')?.textContent).toBe('Excel 97-2003 工作簿');
    });
  });

  it('ppt → 「PowerPoint 97-2003 演示文稿」', async () => {
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/汇报.ppt', ext: 'ppt', label: '汇报.ppt' });
      expect(container.querySelector('.pp-viewer-legacy-type')?.textContent).toBe('PowerPoint 97-2003 演示文稿');
    });
  });

  it('不解析：三格式都零 RPC（不读字节、不碰 officecli）', async () => {
    await withRenderers(async () => {
      for (const ext of ['doc', 'xls', 'ppt']) {
        await renderFile({ filePath: `D:/a.${ext}`, ext, label: `a.${ext}` });
      }
      expect(typedRpc).not.toHaveBeenCalled();
    });
  });

  it('系统打开出口由公共壳提供（有路径 ⇒ 壳的按钮在；本查看器自己不画按钮）', async () => {
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/来文.doc', ext: 'doc', label: '来文.doc' });
      const hostButton = container.querySelector('.pp-viewer-open-system');
      expect(hostButton?.textContent).toContain('用系统程序打开');
      expect(container.querySelector('.pp-viewer-legacy button')).toBeNull();
    });
  });

  it('无 filePath ⇒ 只出文件壳（没有可移交的文件，不出类型标记、不发 RPC）', async () => {
    await withRenderers(async () => {
      await renderFile({ ext: 'doc', label: '来文.doc' });
      expect(container.querySelector('.pp-media-file')).not.toBeNull();
      expect(container.querySelector('.pp-viewer-legacy-type')).toBeNull();
      expect(container.querySelector('.pp-viewer-open-system')).toBeNull(); // 壳也不出按钮（没路径）
      expect(typedRpc).not.toHaveBeenCalled();
    });
  });

  it('认领面：doc / xls / ppt 三个扩展名都路由到 legacy-office，且不读字节', () => {
    const def = viewerRegistry.get('legacy-office');
    expect(def).toBeTruthy();
    expect(def?.id).toBe('legacy-office');
    expect(def?.needsBytes).toBe(false);
    for (const ext of ['doc', 'xls', 'ppt']) {
      expect(viewerRegistry.resolve(ext)?.id, ext).toBe('legacy-office');
    }
    // 旧格式与 OOXML 两档不互抢：docx/xlsx/pptx 不属于本档
    for (const ext of ['docx', 'xlsx', 'pptx']) {
      expect(viewerRegistry.resolve(ext)?.id, ext).not.toBe('legacy-office');
    }
  });
});
