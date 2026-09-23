// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-code — 代码/文本查看器（渲染面补全 B2，2026-09-23）：
//   ① 认领覆盖：脚本/系统/前端/shell/纯文本各族扩展名都路由到 'code'；
//   ② 文本读取形态：宿主走 `fs_cap read`（**行窗口 limit = readLines + 1**，不整份进 IPC）；
//   ③ 高亮与墨阶：hljs 出 span（类名映射在 CSS，本用例只钉「有高亮层 + 与流内同款类名」）；
//   ④ 截断**不静默**：窗口里还有下一行 ⇒ 吸顶横幅说清「只显示前 N 行」；未截断 ⇒ 无横幅；
//   ⑤ 失败面：读口返回非文本（图片结局）→ 可读错误行，不空白、不 JSON 兜底；
//   ⑥ 体积闸：窗口文本超 maxBytes → 可读错误（带「约」）+ 文件壳，不静默截断。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { measureBlockHeight } from '../src/paper/measure';
import { ASSET_DERIVED } from '../src/paper/type-tokens';
import { viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/** 读口成功响应（`fs_cap read` 的文本结局：{path, content}）。 */
function readOk(content: string): string {
  return JSON.stringify({ path: 'D:/a.ts', content });
}

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
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

describe('代码查看器 · 认领面（B2）', () => {
  it('脚本 / 系统 / 前端 / shell / 纯文本各族都路由到 code', () => {
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'rs', 'py', 'go', 'java', 'c', 'h', 'cpp', 'cs', 'rb', 'php']) {
      expect(viewerClassOf(ext), ext).toBe('code');
    }
    for (const ext of ['css', 'scss', 'html', 'htm', 'vue', 'svelte', 'sql', 'proto', 'ini']) {
      expect(viewerClassOf(ext), ext).toBe('code');
    }
    for (const ext of ['sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'tex', 'txt', 'log']) {
      expect(viewerClassOf(ext), ext).toBe('code');
    }
  });

  it('留给后续包（P3）的扩展名**不被**本包抢占：office / epub / ipynb / md', () => {
    for (const ext of ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'epub', 'ipynb', 'md']) {
      expect(viewerRegistry.resolve(ext), `${ext} 应留给后续包（P3）`).toBeUndefined();
    }
  });
});

describe('代码查看器 · 读取与渲染（B2）', () => {
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

  async function renderCode(payload: unknown): Promise<void> {
    const Comp = resolveAssetBlock('file', 'media')!;
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock(payload) }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('文本读取走 fs_cap read 且开**行窗口**（limit = readLines + 1）——不整份进 IPC', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('const a = 1;\nexport {};\n'));
    await withRenderers(async () => {
      await renderCode({ filePath: 'D:/a.ts', ext: 'ts', label: 'a.ts' });
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read',
        file_path: 'D:/a.ts',
        limit: 2001,
        is_agent: false,
      });
      expect(container.querySelector('.pp-viewer-code')).not.toBeNull();
      expect(container.querySelector('.pp-viewer-label')?.textContent).toBe('a.ts');
    });
  });

  it('行号列逐行对齐 + hljs 高亮层（类名与流内围栏码同款：.hljs-keyword）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('const a = 1;\nfunction b() {}\nexport {};'));
    await withRenderers(async () => {
      await renderCode({ filePath: 'D:/a.ts', ext: 'ts', label: 'a.ts' });
      expect(container.querySelector('.pp-viewer-code-gutter')?.textContent).toBe('1\n2\n3');
      const code = container.querySelector('.pp-viewer-code-pre code');
      expect(code?.innerHTML).toContain('hljs-keyword'); // hljs 输出 = 可信本地渲染
      expect(container.querySelector('.pp-viewer-code-note')).toBeNull(); // 3 行 → 无截断横幅
    });
  });

  it('无 hljs 语言（.txt/.vue）→ 原文 mono，不误着色、不炸', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('纯文本一行\n第二行'));
    await withRenderers(async () => {
      await renderCode({ filePath: 'D:/a.txt', ext: 'txt', label: 'a.txt' });
      const code = container.querySelector('.pp-viewer-code-pre code');
      expect(code?.textContent).toBe('纯文本一行\n第二行');
      expect(code?.innerHTML).not.toContain('hljs-');
      expect(container.querySelector('.pp-viewer-code-gutter')?.textContent).toBe('1\n2');
    });
  });

  it('窗口里有第 2001 行 → 吸顶横幅（只显示前 2000 行，截断可见）', async () => {
    const long = Array.from({ length: 2001 }, (_, i) => `line ${i + 1}`).join('\n');
    vi.mocked(typedRpc).mockResolvedValue(readOk(long));
    await withRenderers(async () => {
      await renderCode({ filePath: 'D:/a.log', ext: 'log', label: 'a.log' });
      const note = container.querySelector('.pp-viewer-code-note');
      expect(note?.textContent).toContain('已截断：只显示前 2000 行（文件更长）');
      // 行号列只到 2000（截断后不再多画一行）
      const gutterLines = container.querySelector('.pp-viewer-code-gutter')?.textContent?.split('\n') ?? [];
      expect(gutterLines.length).toBe(2000);
      expect(gutterLines[1999]).toBe('2000');
    });
  });

  it('恰好 2000 行 → 不截断（末行存在性判据不误报）', async () => {
    const exact = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n');
    vi.mocked(typedRpc).mockResolvedValue(readOk(exact));
    await withRenderers(async () => {
      await renderCode({ filePath: 'D:/a.log', ext: 'log', label: 'a.log' });
      expect(container.querySelector('.pp-viewer-code-note')).toBeNull();
      expect(container.querySelector('.pp-viewer-code-gutter')?.textContent?.split('\n').length).toBe(2000);
    });
  });

  it('空文件 → 明说「文件为空（0 行）」，不留空白盒', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(''));
    await withRenderers(async () => {
      await renderCode({ filePath: 'D:/a.ts', ext: 'ts', label: 'a.ts' });
      expect(container.querySelector('.pp-viewer-code-empty')?.textContent).toContain('文件为空');
      expect(container.querySelector('.pp-viewer-code')).toBeNull();
    });
  });

  it('读口返回非文本（图片结局：无 content 键）→ 可读错误行，不空白、不 JSON 兜底', async () => {
    vi.mocked(typedRpc).mockResolvedValue(JSON.stringify({ path: 'D:/a.ts', image: { id: 'x' } }));
    await withRenderers(async () => {
      await renderCode({ filePath: 'D:/a.ts', ext: 'ts', label: 'a.ts' });
      const line = container.querySelector('.pp-media-loading');
      expect(line?.textContent).toContain('读取失败');
      expect(line?.textContent).toContain('不是文本内容');
      expect(container.querySelector('.pp-viewer-code')).toBeNull();
    });
  });

  it('读口响应不是 JSON → 可读错误带前 120 字符（错误即导航）', async () => {
    vi.mocked(typedRpc).mockResolvedValue('<html>not json</html>');
    await withRenderers(async () => {
      await renderCode({ filePath: 'D:/a.ts', ext: 'ts', label: 'a.ts' });
      const line = container.querySelector('.pp-media-loading')?.textContent ?? '';
      expect(line).toContain('无法解析为 JSON');
      expect(line).toContain('<html>not json</html>');
    });
  });

  it('窗口文本超 maxBytes → 可读错误（带「约」）+ 文件壳（不静默截断）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('x'.repeat(2 * 1024 * 1024 + 1)));
    await withRenderers(async () => {
      await renderCode({ filePath: 'D:/a.ts', ext: 'ts', label: 'a.ts' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('约');
      expect(err).toContain('超过「code」查看器的');
      expect(container.querySelector('.pp-media-file')).not.toBeNull();
      expect(container.querySelector('.pp-viewer-code')).toBeNull();
    });
  });
});

describe('代码查看器 · 静态测高（B2：按类查表，token 同源）', () => {
  it('代码类块高 = 未认领（文件壳）档 + codeBoxH − 文件行', () => {
    const code = measureBlockHeight({ ...mediaBlock({ filePath: 'D:/a.ts', ext: 'ts' }), id: 'pb:m1:code' });
    const shell = measureBlockHeight({ ...mediaBlock({ filePath: 'D:/a.xyz', ext: 'xyz' }), id: 'pb:m1:shell' });
    const rowH = ASSET_DERIVED.mediaRowSize * 1.8;
    expect(code - shell).toBe(ASSET_DERIVED.viewerCodeBoxH - rowH);
  });

  it('代码 / 音频 / 图片三档互不相同（各自就位，没有一张表串档）', () => {
    const heights = ['ts', 'mp3', 'png'].map((ext) =>
      measureBlockHeight({ ...mediaBlock({ filePath: `D:/a.${ext}`, ext }), id: `pb:m1:${ext}` }),
    );
    expect(new Set(heights).size).toBe(3);
  });
});
