// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-light — P1 轻查看器总装里我这三件（表格 / 归档 / 兜底 hex·文本嗅探）：
//   ① 表格：RFC4180 子集（引号转义/CRLF/ragged）+ 行数读数 + 截断横幅；
//   ② 归档：zip 中央目录 / tar 头链 / gz 头——**只列目录不解压**；坏包出可读错误；
//   ③ 兜底：未认领扩展名不再落文件壳——文本嗅探走行号视图、二进制走 hex 分页。

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

function readOk(content: string): string {
  return JSON.stringify({ path: 'D:/a.csv', content });
}

/** base64 编码（测试构造二进制载荷；btoa 在 jsdom 可用）。 */
function b64(bytes: number[] | string): string {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(bin);
}

/** 文本 → UTF-8 字节 → base64（btoa 只吃 Latin-1，中文必须先过 TextEncoder）。 */
function b64Text(text: string): string {
  return b64([...new TextEncoder().encode(text)]);
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

describe('P1 轻查看器：表格 / 归档 / 兜底（hex·文本嗅探）', () => {
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
    const Comp = resolveAssetBlock('file', 'media')!;
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock(payload) }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  // ── 表格（csv / tsv）──
  it('csv：引号内逗号/换行不切列 + 读数 + 表头冻结类名', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('name,note\r\n"a,b","say ""hi""\nsecond"\r\nplain,x'));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.csv', ext: 'csv', label: 'a.csv' });
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read',
        file_path: 'D:/a.csv',
        limit: 4001,
        is_agent: false,
      });
      const heads = [...container.querySelectorAll('.pp-viewer-table-grid th')].map((th) => th.textContent);
      expect(heads).toEqual(['name', 'note']);
      const cells = [...container.querySelectorAll('.pp-viewer-table-grid tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent),
      );
      expect(cells).toEqual([
        ['a,b', 'say "hi"\nsecond'],
        ['plain', 'x'],
      ]);
      expect(container.querySelector('.pp-viewer-table-meta')?.textContent).toContain('2 行 × 2 列');
    });
  });

  it('tsv：按制表符切；列数不一致的行显式读数（不静默）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('a\tb\tc\n1\t2\n'));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.tsv', ext: 'tsv', label: 'a.tsv' });
      expect(container.querySelector('.pp-viewer-table-meta')?.textContent).toContain('制表符');
      expect(container.querySelector('.pp-viewer-table-meta')?.textContent).toContain('1 行列数与表头不一致');
    });
  });

  it('csv 空文件 → 可读空态（不空白、不 JSON 兜底）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(''));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.csv', ext: 'csv', label: 'a.csv' });
      expect(container.querySelector('.pp-viewer-empty')?.textContent).toContain('文件为空');
    });
  });

  // ── 归档（zip / tar / gz）──
  it('zip：从中央目录列条目（名/原始大小/压缩后），且**不解压**（读数行明说）', async () => {
    // 构造最小 zip：EOCD(count=1, cdOffset=0) + 一条中央目录（名 hello.txt，packed 5 / size 11）
    const cd = new Uint8Array(46 + 9);
    const dv = new DataView(cd.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint32(20, 5, true); // packed
    dv.setUint32(24, 11, true); // uncompressed
    dv.setUint16(28, 9, true); // name len
    cd.set(new TextEncoder().encode('hello.txt'), 46);
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(10, 1, true); // count
    edv.setUint32(16, 0, true); // cd offset
    const zip = new Uint8Array(cd.length + eocd.length);
    zip.set(cd, 0);
    zip.set(eocd, cd.length);
    vi.mocked(typedRpc).mockResolvedValue(JSON.stringify({ path: 'D:/a.zip', base64: b64([...zip]) }));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.zip', ext: 'zip', label: 'a.zip' });
      const note = container.querySelector('.pp-viewer-note')?.textContent ?? '';
      expect(note).toContain('只列目录，不解压、不落盘');
      expect(note).toContain('1 条目');
      expect(container.querySelector('.pp-viewer-archive-name')?.textContent).toBe('hello.txt');
      expect(container.querySelector('.pp-viewer-archive-table')?.textContent).toContain('11 B');
      expect(container.querySelector('.pp-viewer-archive-table')?.textContent).toContain('压缩至 5 B');
    });
  });

  it('坏 zip → 可读错误 + 明说「解析不了就不猜内容」', async () => {
    vi.mocked(typedRpc).mockResolvedValue(JSON.stringify({ path: 'D:/a.zip', base64: b64('not a zip at all') }));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.zip', ext: 'zip', label: 'a.zip' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('无法列出归档目录');
      expect(err).toContain('中央目录');
    });
  });

  it('gz：读头取原文件名 + 尾部 ISIZE 作解压后大小', async () => {
    const body = new Uint8Array([0x1f, 0x8b, 0x08, 0x08, 0, 0, 0, 0, 0, 0xff]);
    const name = new TextEncoder().encode('orig.txt\0');
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, 1234, true);
    const gz = new Uint8Array(body.length + name.length + tail.length);
    gz.set(body, 0);
    gz.set(name, body.length);
    gz.set(tail, body.length + name.length);
    vi.mocked(typedRpc).mockResolvedValue(JSON.stringify({ path: 'D:/a.gz', base64: b64([...gz]) }));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.gz', ext: 'gz', label: 'a.gz' });
      expect(container.querySelector('.pp-viewer-archive-name')?.textContent).toBe('orig.txt');
      expect(container.querySelector('.pp-viewer-archive-table')?.textContent).toContain('1.2 KB');
    });
  });

  // ── 兜底（未认领扩展名；`bytesKind:'auto'` = 先文本窗口，失败再二进制）──
  it('未认领扩展名 + 文本内容 → **走文本行窗口**（有界、不读 base64）+ 行号视图', async () => {
    vi.mocked(typedRpc).mockResolvedValue(JSON.stringify({ path: 'D:/a.weird', content: '第一行\n第二行\n' }));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.weird', ext: 'weird', label: 'a.weird' });
      const note = container.querySelector('.pp-viewer-note')?.textContent ?? '';
      expect(note).toContain('未认领的扩展名「.weird」');
      expect(note).toContain('按文本显示');
      expect(container.querySelector('.pp-viewer-hex-gutter')?.textContent).toBe('1\n2\n3');
      expect(container.querySelector('.pp-viewer-hex-pre')?.textContent).toContain('第二行');
      // 首选路径 = fs_cap read 行窗口（readLines 4000 ⇒ 读 4001 行）
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read',
        file_path: 'D:/a.weird',
        limit: 4001,
        is_agent: false,
      });
      expect(typedRpc).not.toHaveBeenCalledWith('fs_cap', expect.objectContaining({ action: 'read_base64' }));
    });
  });

  it('未认领扩展名 + 真二进制（文本读失败）→ 回退 read_base64 + hex 视图（偏移/字节/ASCII/分页）', async () => {
    vi.mocked(typedRpc).mockImplementation(async (_method, params) => {
      if ((params as { action?: string }).action === 'read') throw new Error('无法读取文件: invalid UTF-8');
      return JSON.stringify({ path: 'D:/b.bin', base64: b64([0x00, 0x01, 0xff, 0xfe, 0x41, 0x42]) });
    });
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/b.bin', ext: 'bin', label: 'b.bin' });
      const note = container.querySelector('.pp-viewer-note')?.textContent ?? '';
      expect(note).toContain('按十六进制显示');
      expect(note).toContain('第 1/1 页');
      const text = container.querySelector('.pp-viewer-hex-table')?.textContent ?? '';
      expect(text).toContain('00000000');
      expect(text).toContain('00 01 ff fe 41 42');
      expect(text).toContain('..AB');
      expect((container.querySelector('.pp-viewer-hex-nav button') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('无扩展名的文本文件（如 Dockerfile）也走兜底，不再落文件壳', async () => {
    vi.mocked(typedRpc).mockResolvedValue(JSON.stringify({ path: 'D:/Dockerfile', content: 'FROM node:20\n' }));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/Dockerfile', ext: '', label: 'Dockerfile' });
      expect(container.querySelector('.pp-viewer-note')?.textContent).toContain('（无扩展名）');
      expect(container.querySelector('.pp-viewer-hex-pre')?.textContent).toContain('FROM node:20');
      expect(container.querySelector('.pp-media-file')).toBeNull(); // 旧行为（文件壳）不再出现
    });
  });
});
