// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-pdf — PDF 查看器（渲染面补全 P2 · B3，2026-09-23）的判据面。
//
// 这个环境能测到哪一步（**如实栏**，不 mock 出假绿灯）：
//   · jsdom **没有 canvas**（`getContext('2d')` 返回 null）⇒ 「首页缩略图真画出来」这条腿在
//     jsdom 里**必败**——用例把它当**环境事实**断言（画布失败行在、读数行仍在），
//     真机验收项留给施工单 §8 第 3 项（翻页 / 缩放 / 选文）；
//   · pdfjs **真解析**是可跑的：宿主给的是 base64 → 组件 `atob` → `getDocument({data})`。
//     Node 无 `Worker` ⇒ pdfjs 走 fake worker，其 `_setupFakeWorkerGlobal` 会
//     `await import(workerSrc)`；组件在生产把 workerSrc 设成 vite `?url` 资源（浏览器路径），
//     Node 解析不了 ⇒ 本文件在**首次 getDocument 之前**把它换成 file:// 真路径
//     （pdfjs 的 `_setupFakeWorkerGlobal` 是 shadow 缓存，第一次取用即定格，故必须前置）。
//   · 页数读数 / 翻页 / 文本层（浮层）三条因此走的是**真 pdfjs 解析**（fixture 是手工构造的
//     最小 PDF，见 buildPdf），不是桩。
//
// 覆盖：失败面（无字节 / 形态不符 / 坏 base64 / 空载荷 / 非 PDF / 加密异常映射）+ 读数逻辑
// （页数 / 翻页 / 缩放档）+ 上限显式标注（页数 500 / 单页 4096px）+ 宿主降级链（heavy 取件失败）。

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { GlobalWorkerOptions, PasswordException } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PdfViewer, {
  clampPageScale,
  layoutPdfText,
  PDF_MAX_PAGE_PX,
  PDF_MAX_PAGES,
  pdfErrorMessage,
} from '../src/app/paper/viewers/pdf';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import type { ViewerProps } from '../src/plugins/builtin/renderers/viewer-registry';
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';

/* ── pdfjs worker：jsdom 侧必须先定格成 Node 可解析的 file:// 真路径（见文件头注） ── */
const nodeRequire = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(nodeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')).href;

/* ── 手工构造的最小 PDF（无 fixture 文件依赖）：正确 xref 偏移 + 可指定页数与文本 ── */
function buildPdf(opts: { pages?: number; text?: string } = {}): Uint8Array {
  const pageCount = Math.max(1, opts.pages ?? 1);
  const text = opts.text ?? 'Hello PDF';
  const total = 3 + 2 * pageCount; // 1 Catalog / 2 Pages / 3 Font / 每页 1 Page + 1 Contents
  const objs: string[] = new Array(total + 1).fill('');
  const pageNums = Array.from({ length: pageCount }, (_, i) => 4 + i);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  for (let i = 0; i < pageCount; i++) {
    const contentNum = 3 + pageCount + 1 + i;
    objs[4 + i] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] ' +
      `/Contents ${contentNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    const stream = `BT /F1 18 Tf 20 60 Td (${text}) Tj ET`;
    objs[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n <= total; n++) {
    offsets.push(out.length);
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** 字节 → 宿主给查看器的 data URI 形态（base64）。 */
function pdfDataUri(opts: { pages?: number; text?: string } = {}): string {
  return `data:application/pdf;base64,${Buffer.from(buildPdf(opts)).toString('base64')}`;
}

/** 最小可渲染调用面：只喂 ViewerProps（宿主壳不在本文件的被测面内）。 */
function viewerProps(over: Partial<ViewerProps> = {}): ViewerProps {
  return {
    block: { id: 'pb:m1:0' } as unknown as ViewerProps['block'],
    label: '样张.pdf',
    ext: 'pdf',
    filePath: 'D:/docs/样张.pdf',
    mode: 'stream',
    ...over,
  };
}

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function renderViewer(over: Partial<ViewerProps> = {}): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PdfViewer, viewerProps(over)));
  });
  mounted.push({ root, container });
  return container;
}

/** 等在途异步（pdfjs fake worker 的动态 import / 解析 / 渲染）落定——轮询而非数 microtask。 */
async function waitFor(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor 超时：${what}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

describe('viewer-pdf · 失败面（错误不静默：一行可读错误，不空白、不 JSON 兜底）', () => {
  it('无 bytes → 空态（说清是「没取到字节」，不是渲染空白）', async () => {
    const c = await renderViewer({ bytes: undefined });
    const empty = c.querySelector('.pp-viewer-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('未取到 PDF 字节');
    expect(c.querySelector('.pp-viewer-error')).toBeNull();
  });

  it('字节形态是文本（宿主读取形态不符）→ 可读错误，不静默当空文件', async () => {
    const c = await renderViewer({ bytes: { kind: 'text', value: '%PDF-1.4' } });
    expect(c.querySelector('.pp-viewer-error')?.textContent).toContain('宿主读取形态与查看器声明不一致');
  });

  it('坏 base64 → 可读错误（带解码原因）', async () => {
    const c = await renderViewer({
      bytes: { kind: 'data-uri', value: 'data:application/pdf;base64,!!!not-base64!!!' },
    });
    await waitFor(() => c.querySelector('.pp-viewer-error') !== null, '坏 base64 错误行');
    const text = c.querySelector('.pp-viewer-error')?.textContent ?? '';
    expect(text).toContain('base64 解码失败');
    expect(text).toContain('D:/docs/样张.pdf'); // 错误即导航：说清哪个文件
  });

  it('空载荷（data URI 合法但 0 字节）→ 可读错误', async () => {
    const c = await renderViewer({ bytes: { kind: 'data-uri', value: 'data:application/pdf;base64,' } });
    await waitFor(() => c.querySelector('.pp-viewer-error') !== null, '空载荷错误行');
    expect(c.querySelector('.pp-viewer-error')?.textContent).toContain('PDF 字节为空');
  });

  it('非 PDF 数据（真喂给 pdfjs）→ 可读错误带 pdfjs 原话', async () => {
    const payload = Buffer.from('这不是 PDF，只是一段文本', 'utf8').toString('base64');
    const c = await renderViewer({ bytes: { kind: 'data-uri', value: `data:application/pdf;base64,${payload}` } });
    await waitFor(
      () => (c.querySelector('.pp-viewer-error')?.textContent ?? '').includes('不是有效的 PDF'),
      'pdfjs 解析失败错误行',
    );
    expect(c.querySelector('.pp-viewer-error')?.textContent).toContain('Invalid PDF structure');
  });

  it('加密 PDF 的异常映射（无密码输入能力位）：PasswordException → 一句「已加密、需要密码」', () => {
    const mapped = pdfErrorMessage(new PasswordException('No password given', 1));
    expect(mapped).toContain('已加密');
    expect(mapped).toContain('No password given'); // pdfjs 原话
    expect(mapped).toContain('不提供密码输入');
  });
});

describe('viewer-pdf · 读数与两态（流内缩略 / 浮层全篇）', () => {
  it('真解析一份最小 PDF：流内出「共 1 页」读数 + 进浮层的按钮', async () => {
    const onOpenOverlay = vi.fn();
    const c = await renderViewer({ bytes: { kind: 'data-uri', value: pdfDataUri() }, onOpenOverlay });
    await waitFor(() => c.querySelector('.pp-viewer-pdf-pages') !== null, '页数读数行');
    expect(c.querySelector('.pp-viewer-pdf-pages')?.textContent).toBe('共 1 页');
    const open = c.querySelector('.pp-viewer-pdf-btn') as HTMLButtonElement | null;
    expect(open?.textContent).toContain('翻页');
    await act(async () => {
      open?.click();
    });
    expect(onOpenOverlay).toHaveBeenCalledTimes(1);
    // 环境事实（不假装绿）：jsdom 无 2D 上下文 ⇒ 缩略图这条腿必败，但读数行仍在（两条失败面解耦）
    await waitFor(() => c.querySelector('.pp-viewer-error') !== null, '画布失败行');
    expect(c.querySelector('.pp-viewer-error')?.textContent).toContain('2D 画布上下文');
    expect(c.querySelector('.pp-viewer-pdf-pages')?.textContent).toBe('共 1 页');
  });

  it('浮层：文本层按 pdfjs 真解析结果铺 span（可选中），翻页读数随按钮走', async () => {
    const c = await renderViewer({ bytes: { kind: 'data-uri', value: pdfDataUri({ pages: 2 }) }, mode: 'overlay' });
    await waitFor(() => c.querySelector('.pp-viewer-pdf-text-item') !== null, '文本层 span');
    const span = c.querySelector('.pp-viewer-pdf-text-item') as HTMLElement;
    expect(span.textContent).toContain('Hello PDF');
    expect(Number.parseFloat(span.style.fontSize)).toBeGreaterThan(0);
    expect(Number.parseFloat(span.style.left)).toBeGreaterThan(0);
    // 页面盒尺寸由 viewport 落定（**不等 canvas 成功**）——canvas 失败时选文不会被压成 0 高
    expect((c.querySelector('.pp-viewer-pdf-page') as HTMLElement).style.width).toBe('300px');
    expect(c.querySelector('.pp-viewer-pdf-pages')?.textContent).toBe('第 1 / 2 页');
    const next = [...c.querySelectorAll('.pp-viewer-pdf-btn')].find((b) => b.textContent === '下一页');
    await act(async () => {
      (next as HTMLButtonElement).click();
    });
    expect(c.querySelector('.pp-viewer-pdf-pages')?.textContent).toBe('第 2 / 2 页');
    // 缩放档：读数行给出百分比（默认 1 → 100%）
    expect(c.querySelector('.pp-viewer-pdf-zoom')?.textContent).toBe('100%');
  });

  it('页数超上限（>500）→ 显式标注，不静默（仍按当前页渲染，不预取整册）', async () => {
    const c = await renderViewer({
      bytes: { kind: 'data-uri', value: pdfDataUri({ pages: PDF_MAX_PAGES + 1 }) },
    });
    await waitFor(() => c.querySelector('.pp-viewer-note') !== null, '页数上限标注');
    const note = c.querySelector('.pp-viewer-note')?.textContent ?? '';
    expect(note).toContain(`超过查看器页数上限 ${PDF_MAX_PAGES} 页`);
    expect(c.querySelector('.pp-viewer-pdf-pages')?.textContent).toBe(`共 ${PDF_MAX_PAGES + 1} 页`);
  }, 30_000);
});

describe('viewer-pdf · 几何与落位（纯函数直呼面）', () => {
  it('单页渲染上限解算：超 4096px 按比例缩回并报 clamped；未超不动', () => {
    const big = clampPageScale({ baseW: 20_000, baseH: 20_000, scale: 1, outputScale: 1 });
    expect(big.clamped).toBe(true);
    expect(big.width).toBeLessThanOrEqual(PDF_MAX_PAGE_PX);
    expect(big.height).toBeLessThanOrEqual(PDF_MAX_PAGE_PX);
    const small = clampPageScale({ baseW: 612, baseH: 792, scale: 3, outputScale: 1 });
    expect(small.clamped).toBe(false);
    expect(small.width).toBe(1836); // 612 × 3
    expect(small.height).toBe(2376);
    // 设备像素比同样算进上限（高分屏不越过渲染预算）
    const hidpi = clampPageScale({ baseW: 612, baseH: 792, scale: 3, outputScale: 2 });
    expect(hidpi.clamped).toBe(true);
    expect(hidpi.width).toBeLessThanOrEqual(PDF_MAX_PAGE_PX);
  });

  it('文本层落位：基线 → 顶边换算、字高取矩阵范数、旋转角进 span', () => {
    const viewport = { transform: [1, 0, 0, -1, 0, 144] } as unknown as PageViewport;
    const spans = layoutPdfText([{ text: 'Hi', transform: [18, 0, 0, 18, 20, 60] }], viewport);
    expect(spans).toEqual([{ text: 'Hi', left: 20, top: 66, fontSize: 18, angle: 0 }]);
    const rotated = layoutPdfText([{ text: '竖', transform: [0, 12, -12, 0, 30, 40] }], viewport);
    expect(rotated[0]?.fontSize).toBe(12);
    expect(Math.abs(rotated[0]?.angle ?? 0)).toBeCloseTo(Math.PI / 2, 6);
    // 退化矩阵（无字高）不摆 span——宁缺不叠
    expect(layoutPdfText([{ text: 'x', transform: [0, 0, 0, 0, 10, 10] }], viewport)).toEqual([]);
  });
});

describe('viewer-pdf · 宿主降级链（heavy 取件失败 → 可读错误 + 文件壳）', () => {
  /** 媒体块（kind='file' + presentation='media'——与 asset-media-load 同一形状）。 */
  function mediaBlock(payload: unknown): SourcedBlock {
    return {
      ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
      id: 'pb:m1:0',
      asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
    };
  }

  it('登记一个取件键不存在的重查看器 → 宿主出「重查看器「…」装载失败」', async () => {
    const dispose = viewerRegistry.register({
      id: 'tmp-heavy-missing',
      exts: ['zzheavy'],
      needsBytes: false,
      heavy: '不存在的id',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const ctx = new Context();
    try {
      await ctx.plugin(compositionServicesPlugin);
      const fiber = await ctx.plugin(rendererServicePlugin);
      const rendererFiber = await ctx.plugin(builtinRenderersPlugin);
      const Comp = resolveAssetBlock('file', 'media');
      expect(Comp).toBeTruthy();
      await act(async () => {
        root.render(
          createElement(Comp as React.ComponentType<{ block: SourcedBlock }>, {
            block: mediaBlock({ filePath: 'D:/a.zzheavy', ext: 'zzheavy', label: '重' }),
          }),
        );
      });
      await waitFor(
        () => (container.querySelector('.pp-viewer-error')?.textContent ?? '').includes('装载失败'),
        '宿主重查看器取件失败行',
      );
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('重查看器「不存在的id」装载失败');
      expect(container.querySelector('.pp-media-file')).not.toBeNull(); // 降级 = 文件壳
      await rendererFiber.dispose();
      await fiber.dispose();
    } finally {
      dispose();
      await ctx[Symbol.asyncDispose]?.();
    }
  }, 30_000);
});
