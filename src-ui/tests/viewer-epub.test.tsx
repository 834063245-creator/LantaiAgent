// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-epub — 电子书查看器（渲染面补全 P3 · B11）：
//   ① 认领面 = 宿主层分类表（epub 一个扩展名）+ 读取形态（data-uri + MIME + 32 MiB 闸）；
//   ② 两章 epub：spine 序出目录（标题取 h1、缺则文件名）+ 首章正文**按段落**（不是一整坨 pre）；
//   ③ 切章：点目录项 / 上一章 / 下一章，正文与读数跟着走；
//   ④ method 8（deflate）：条目字节是离线生成的 deflate-raw 流——
//      环境有原生 `DecompressionStream` ⇒ **真跑**（解出来的正文逐字断言）；
//      没有 ⇒ 走「环境无解压能力」那条可读降级（不 mock 出假绿灯）；
//   ⑤ 失败面（每种一行可读、点明哪一步哪个文件）：坏 zip / 缺 container.xml /
//      缺 <rootfile full-path> / OPF 不在包内 / OPF 非法 / 无 <spine> / 加密条目 / 无解压能力；
//   ⑥ 空 spine 与空字节出空态（不是错误）；
//   ⑦ 体积：单章正文截断 + 吸顶横幅；压缩包条目数超上限如实标注。
//
// fixture 是**内存里手写的 zip**（local header + 中央目录 + EOCD，CRC 按真值算），
// 章节用 method 0 直存——只有 method 8 那条用离线压缩字节（见 DEFLATED_BYTES）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { VIEWER_EPUB_EXTS, viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
import { epubViewer } from '../src/plugins/builtin/renderers/viewers/epub';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

const encoder = new TextEncoder();

/* ── 内存 zip（真 CRC）────────────────────────────────────────────────────── */

interface ZipFile {
  name: string;
  /** 原文（CRC 与「解压后大小」都按它算） */
  raw: Uint8Array;
  /** 写进包里的字节（method 8 = 压缩结果；缺省 = raw） */
  stored?: Uint8Array;
  method?: 0 | 8;
  /** 通用位（缺省 0x0800 = UTF-8 名字；加密条目再加 bit0） */
  flags?: number;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files: ZipFile[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const stored = file.stored ?? file.raw;
    const method = file.method ?? 0;
    const flags = file.flags ?? 0x0800;
    const crc = crc32(file.raw);

    const local = new Uint8Array(30 + nameBytes.length + stored.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, file.raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(stored, 30 + nameBytes.length);
    locals.push(local);

    const entry = new Uint8Array(46 + nameBytes.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(4, 20, true);
    ev.setUint16(6, 20, true);
    ev.setUint16(8, flags, true);
    ev.setUint16(10, method, true);
    ev.setUint32(16, crc, true);
    ev.setUint32(20, stored.length, true);
    ev.setUint32(24, file.raw.length, true);
    ev.setUint16(28, nameBytes.length, true);
    ev.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);
    offset += local.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...central, eocd];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/* ── epub fixture ─────────────────────────────────────────────────────────── */

const CH1_TITLE = '第一章 · 起';
const CH2_TITLE = '第二章 · 承';

function xhtml(title: string, paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join('\n');
  return encoder.encode(
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>\n<h1>${title}</h1>\n${body}\n</body></html>`,
  );
}

function containerXml(opfPath: string): Uint8Array {
  return encoder.encode(
    `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>\n</container>`,
  );
}

function opfXml(opts: {
  items: Array<{ id: string; href: string }>;
  spine?: string[];
  omitSpine?: boolean;
}): Uint8Array {
  const manifest = opts.items
    .map((item) => `    <item id="${item.id}" href="${item.href}" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const refs = (opts.spine ?? []).map((id) => `    <itemref idref="${id}"/>`).join('\n');
  const spine = opts.omitSpine ? '' : `  <spine>\n${refs}\n  </spine>\n`;
  return encoder.encode(
    `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:title>测试电子书</dc:title>\n    <dc:creator>作者甲</dc:creator>\n  </metadata>\n  <manifest>\n${manifest}\n  </manifest>\n${spine}</package>`,
  );
}

const MIMETYPE: ZipFile = { name: 'mimetype', raw: encoder.encode('application/epub+zip') };

/** 标准两章 fixture：ch1 有 `<h1>`；ch2 **没有**标题（目录该退文件名）。 */
function twoChapterEpub(): Uint8Array {
  return buildZip([
    MIMETYPE,
    { name: 'META-INF/container.xml', raw: containerXml('content.opf') },
    {
      name: 'content.opf',
      raw: opfXml({
        items: [
          { id: 'c1', href: 'ch1.xhtml' },
          { id: 'c2', href: 'ch2.xhtml' },
        ],
        spine: ['c1', 'c2'],
      }),
    },
    { name: 'ch1.xhtml', raw: xhtml(CH1_TITLE, ['第一段正文。', '第二段正文。']) },
    {
      // head 里有 `<title>` 但正文**没有 h1..h3**：章节标题只认 h1..h3（缺则文件名），
      // 不拿 head 的 `<title>` 冒充（它常是书名或文件名）。
      name: 'ch2.xhtml',
      raw: encoder.encode(
        `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${CH2_TITLE}</title></head><body>\n<p>第二章正文甲。</p>\n<ul><li>条目一</li></ul>\n</body></html>`,
      ),
    },
  ]);
}

/** deflate 条目的原文（与 `DEFLATED_BYTES` 逐字节对应）。 */
const DEFLATED_XHTML =
  '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body>\n<h1>压缩章</h1>\n<p>这一段来自 deflate 条目。</p>\n</body></html>';

/** deflate-raw 压缩字节（离线用原生压缩器生成并验证过往返）。
 *  写死（而不是测试里现压）是为了让「环境没有解压能力」那条用例在任何环境都造得出 deflate 条目。 */
const DEFLATED_BYTES = new Uint8Array([
  179, 177, 175, 200, 205, 81, 40, 75, 45, 42, 206, 204, 207, 179, 85, 50, 212, 51, 80, 82, 72, 205, 75, 206, 79, 201,
  204, 75, 183, 85, 42, 45, 73, 211, 181, 80, 178, 183, 227, 178, 201, 40, 201, 205, 81, 168, 200, 205, 201, 43, 182,
  85, 202, 40, 41, 41, 176, 210, 215, 47, 47, 47, 215, 43, 55, 214, 203, 47, 74, 215, 55, 180, 180, 180, 212, 175, 0,
  169, 81, 178, 179, 73, 202, 79, 169, 4, 233, 48, 180, 123, 218, 215, 253, 124, 207, 202, 231, 171, 23, 216, 232, 103,
  24, 218, 113, 217, 20, 216, 189, 216, 63, 243, 201, 142, 134, 103, 235, 182, 62, 155, 187, 244, 69, 251, 42, 133, 148,
  212, 180, 156, 196, 146, 84, 133, 103, 115, 23, 62, 159, 189, 238, 113, 67, 147, 141, 126, 129, 29, 151, 141, 62, 216,
  12, 27, 125, 144, 137, 118, 0,
]);

/** method 8 的单章 fixture（章节字节 = 上面的 deflate 流）。 */
function deflatedChapterEpub(): Uint8Array {
  return buildZip([
    MIMETYPE,
    { name: 'META-INF/container.xml', raw: containerXml('content.opf') },
    { name: 'content.opf', raw: opfXml({ items: [{ id: 'c1', href: 'ch1.xhtml' }], spine: ['c1'] }) },
    { name: 'ch1.xhtml', raw: encoder.encode(DEFLATED_XHTML), stored: DEFLATED_BYTES, method: 8 },
  ]);
}

/** 环境有没有原生解压能力（jsdom 下由 Node 的 web streams 提供；真机由 WebView2 提供）。 */
const HAS_INFLATE = typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream === 'function';

/* ── 宿主与注册面 ─────────────────────────────────────────────────────────── */

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/** 注册自带 + 用完摘除：主编排批次把本查看器加进 `viewers/index.ts` 后，
 *  这里不因重名再注册（装载期重名是硬拒绝，不是可忽略的重复）。 */
function withViewerRegistered(): () => void {
  if (viewerRegistry.get(epubViewer.id)) return () => {};
  return viewerRegistry.register(epubViewer);
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

/** 查看器的解析是异步链（开卷 → 逐章标题 → 本章正文）：每轮 act + 一个宏任务排空在途 promise。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('电子书查看器 · 认领面（P3 · B11）', () => {
  it('认领表就是宿主层分类表（epub 一个扩展名）', () => {
    expect([...epubViewer.exts]).toEqual([...VIEWER_EPUB_EXTS]);
    expect([...epubViewer.exts]).toEqual(['epub']);
    expect(viewerClassOf('epub')).toBe('epub');
  });

  it('读取形态：data-uri + epub MIME + 32 MiB 体积闸（宿主据此 preflight）', () => {
    expect(epubViewer.id).toBe('epub');
    expect(epubViewer.needsBytes).toBe(true);
    expect(epubViewer.bytesKind).toBe('data-uri');
    expect(epubViewer.mimes).toEqual({ epub: 'application/epub+zip' });
    expect(epubViewer.maxBytes).toBe(32 * 1024 * 1024);
    expect(epubViewer.component).toBeTypeOf('function');
  });

  it('不认领别类的扩展名（ipynb / md 走各自通道，归档 zip ≠ epub）', () => {
    for (const ext of ['ipynb', 'md', 'pdf', 'csv', 'zip', 'txt']) {
      expect(epubViewer.exts.includes(ext), ext).toBe(false);
    }
  });
});

describe('电子书查看器 · 解析与渲染（B11）', () => {
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

  /** 走宿主真链路渲染（`resolveAssetBlock('file','media')`）：`zip === null` = 读口给出空字节。 */
  async function renderEpub(zip: Uint8Array | null): Promise<void> {
    vi.mocked(typedRpc).mockResolvedValue(JSON.stringify({ path: 'D:/a.epub', base64: zip === null ? '' : b64(zip) }));
    const Comp = resolveAssetBlock('file', 'media')!;
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock({ filePath: 'D:/a.epub', ext: 'epub', label: 'a.epub' }) }));
    });
    await settle();
  }

  const tocTitles = (): Array<string | undefined> =>
    [...container.querySelectorAll('.pp-viewer-epub-tocItem .pp-viewer-epub-tocName')].map((n) => n.textContent ?? '');

  const paragraphs = (): Array<string | undefined> =>
    [...container.querySelectorAll('.pp-viewer-epub-p')].map((p) => p.textContent ?? '');

  it('两章 epub：spine 序出目录（标题取 h1、缺则文件名）+ 首章正文按段落', async () => {
    await withRenderers(async () => {
      await renderEpub(twoChapterEpub());
      // 整份字节走用户路径 read_base64（data-uri 形态）
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read_base64',
        file_path: 'D:/a.epub',
        is_agent: false,
      });
      expect(tocTitles()).toEqual([CH1_TITLE, 'ch2']);
      // 缺 h1 的那章用文件名当标题，并明确标记（文件名不冒充章节标题）
      const items = [...container.querySelectorAll('.pp-viewer-epub-tocItem')];
      expect(items[1]?.className).toContain('pp-viewer-epub-tocItem-fromName');
      expect(items[0]?.getAttribute('aria-current')).toBe('true');
      expect(container.querySelector('.pp-viewer-epub-tocItem-on .pp-viewer-epub-tocName')?.textContent).toBe(
        CH1_TITLE,
      );
      // 正文按段落渲染（不是一整坨 pre）；章节内的 h1 留在正文里当标题档
      expect(paragraphs()).toEqual(['第一段正文。', '第二段正文。']);
      expect([...container.querySelectorAll('.pp-viewer-epub-h1')].map((h) => h.textContent)).toEqual([CH1_TITLE]);
      expect(container.querySelector('pre')).toBeNull();
      expect(container.querySelector('.pp-viewer-epub-toc .pp-viewer-note')?.textContent).toContain('目录 · 2 章');
      expect(container.querySelector('.pp-viewer-epub-body .pp-viewer-note')?.textContent).toContain(
        `第 1/2 章 · ${CH1_TITLE}`,
      );
      // 书级信息 + 能力边界如实写在下面
      const meta = container.querySelector('.pp-viewer-epub-meta')?.textContent ?? '';
      expect(meta).toContain('测试电子书');
      expect(meta).toContain('作者甲');
      expect(meta).toContain('纯文本阅读');
      expect(container.querySelector('.pp-viewer-error')).toBeNull();
    });
  });

  it('切章：点目录项 / 上一章 / 下一章，正文与读数跟着走', async () => {
    await withRenderers(async () => {
      await renderEpub(twoChapterEpub());
      const items = [...container.querySelectorAll<HTMLButtonElement>('.pp-viewer-epub-tocItem')];
      await act(async () => {
        items[1]?.click();
      });
      await settle();
      expect(paragraphs()).toEqual(['第二章正文甲。', '条目一']);
      expect(container.querySelector('.pp-viewer-epub-tocItem-on .pp-viewer-epub-tocName')?.textContent).toBe('ch2');
      expect(container.querySelector('.pp-viewer-epub-body .pp-viewer-note')?.textContent).toContain('第 2/2 章');

      const navButtons = (): HTMLButtonElement[] => [
        ...container.querySelectorAll<HTMLButtonElement>('.pp-viewer-epub-navBtn'),
      ];
      expect(navButtons()[1]?.disabled).toBe(true); // 末章：下一章禁用

      await act(async () => {
        navButtons()[0]?.click();
      });
      await settle();
      expect(paragraphs()).toEqual(['第一段正文。', '第二段正文。']);
      expect(navButtons()[0]?.disabled).toBe(true); // 首章：上一章禁用

      await act(async () => {
        navButtons()[1]?.click();
      });
      await settle();
      expect(paragraphs()).toEqual(['第二章正文甲。', '条目一']);
    });
  });

  it('章节文件不在包内（spine 悬空）⇒ 跳过并**如实标注**，其余章照常读', async () => {
    const zip = buildZip([
      MIMETYPE,
      { name: 'META-INF/container.xml', raw: containerXml('content.opf') },
      {
        name: 'content.opf',
        raw: opfXml({
          items: [
            { id: 'c1', href: 'ch1.xhtml' },
            { id: 'c2', href: 'missing.xhtml' },
          ],
          spine: ['c1', 'c2'],
        }),
      },
      { name: 'ch1.xhtml', raw: xhtml(CH1_TITLE, ['正文。']) },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      expect(tocTitles()).toEqual([CH1_TITLE]);
      expect(container.querySelector('.pp-viewer-epub-toc .pp-viewer-note')?.textContent).toContain(
        'spine 里 1 条 itemref 找不到对应文件（已跳过）',
      );
      expect(paragraphs()).toEqual(['正文。']);
    });
  });

  it('子目录 OPF + 相对 href（OEBPS/text/ch1.xhtml）也能定位章节', async () => {
    const zip = buildZip([
      MIMETYPE,
      { name: 'META-INF/container.xml', raw: containerXml('OEBPS/content.opf') },
      {
        name: 'OEBPS/content.opf',
        raw: opfXml({ items: [{ id: 'c1', href: 'text/ch1.xhtml' }], spine: ['c1'] }),
      },
      { name: 'OEBPS/text/ch1.xhtml', raw: xhtml(CH1_TITLE, ['子目录正文。']) },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      expect(tocTitles()).toEqual([CH1_TITLE]);
      expect(paragraphs()).toEqual(['子目录正文。']);
    });
  });

  // ── method 8（deflate）──
  it.skipIf(!HAS_INFLATE)('deflate（method 8）**真跑**：原生 DecompressionStream 把章节解回来', async () => {
    await withRenderers(async () => {
      await renderEpub(deflatedChapterEpub());
      expect(tocTitles()).toEqual(['压缩章']); // 标题也要能取到（同一份 deflate 条目）
      expect(paragraphs()).toEqual(['这一段来自 deflate 条目。']);
      expect([...container.querySelectorAll('.pp-viewer-epub-h1')].map((h) => h.textContent)).toEqual(['压缩章']);
      expect(container.querySelector('.pp-viewer-error')).toBeNull();
    });
  });

  it('环境没有 DecompressionStream ⇒ 可读降级（点明哪一步、哪个文件），不静默空白', async () => {
    await withRenderers(async () => {
      const holder = globalThis as unknown as Record<string, unknown>;
      const saved = Object.getOwnPropertyDescriptor(holder, 'DecompressionStream');
      Object.defineProperty(holder, 'DecompressionStream', { value: undefined, configurable: true, writable: true });
      try {
        await renderEpub(deflatedChapterEpub());
      } finally {
        if (saved) Object.defineProperty(holder, 'DecompressionStream', saved);
        else Reflect.deleteProperty(holder, 'DecompressionStream');
      }
      expect(tocTitles()).toEqual(['ch1']); // 标题退文件名（解压不了 = 取不到 h1）
      const error = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(error).toContain('无法读取章节「ch1.xhtml」');
      expect(error).toContain('当前环境不支持 deflate 解压');
      expect(container.querySelector('.pp-viewer-epub-p')).toBeNull();
    });
  });

  it('加密条目（DRM / 加密封装）⇒ 可读错误点明条目名，不伪装成正文', async () => {
    const zip = buildZip([
      MIMETYPE,
      { name: 'META-INF/container.xml', raw: containerXml('content.opf') },
      { name: 'content.opf', raw: opfXml({ items: [{ id: 'c1', href: 'ch1.xhtml' }], spine: ['c1'] }) },
      { name: 'ch1.xhtml', raw: xhtml(CH1_TITLE, ['加密正文。']), flags: 0x0801 },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      const error = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(error).toContain('无法读取章节「ch1.xhtml」');
      expect(error).toContain('加密条目');
      expect(paragraphs()).toEqual([]);
    });
  });

  // ── 失败面（每种一行可读，点明哪一步哪个文件）──
  it('坏 zip（不是 ZIP 容器）⇒ 「找不到中央目录结尾记录」', async () => {
    await withRenderers(async () => {
      await renderEpub(encoder.encode('x'.repeat(64)));
      const error = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(error).toContain('无法解析 EPUB');
      expect(error).toContain('中央目录结尾记录');
      expect(container.querySelector('.pp-viewer-epub-toc')).toBeNull();
    });
  });

  it('缺 META-INF/container.xml ⇒ 可读错误点名该文件', async () => {
    const zip = buildZip([
      MIMETYPE,
      { name: 'content.opf', raw: opfXml({ items: [{ id: 'c1', href: 'ch1.xhtml' }], spine: ['c1'] }) },
      { name: 'ch1.xhtml', raw: xhtml(CH1_TITLE, ['正文。']) },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      const error = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(error).toContain('缺少 META-INF/container.xml');
    });
  });

  it('container.xml 没有 <rootfile full-path> ⇒ 可读错误（无法定位 OPF）', async () => {
    const zip = buildZip([
      MIMETYPE,
      {
        name: 'META-INF/container.xml',
        raw: encoder.encode(
          '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0"><rootfiles></rootfiles></container>',
        ),
      },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('没有 <rootfile full-path>');
    });
  });

  it('container.xml 指的 OPF 不在包内 ⇒ 可读错误带路径', async () => {
    const zip = buildZip([
      MIMETYPE,
      { name: 'META-INF/container.xml', raw: containerXml('OEBPS/content.opf') },
      { name: 'content.opf', raw: opfXml({ items: [{ id: 'c1', href: 'ch1.xhtml' }], spine: ['c1'] }) },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('OPF 不在压缩包内：OEBPS/content.opf');
    });
  });

  it('OPF 不是合法 XML ⇒ 可读错误（带文件名）', async () => {
    const zip = buildZip([
      MIMETYPE,
      { name: 'META-INF/container.xml', raw: containerXml('content.opf') },
      { name: 'content.opf', raw: encoder.encode('<package><manifest>') },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      const error = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(error).toContain('OPF（content.opf）');
      expect(error).toContain('不是合法 XML');
    });
  });

  it('OPF 里没有 <spine> ⇒ 可读错误（不是空态：包结构就不对）', async () => {
    const zip = buildZip([
      MIMETYPE,
      { name: 'META-INF/container.xml', raw: containerXml('content.opf') },
      { name: 'content.opf', raw: opfXml({ items: [{ id: 'c1', href: 'ch1.xhtml' }], omitSpine: true }) },
      { name: 'ch1.xhtml', raw: xhtml(CH1_TITLE, ['正文。']) },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('没有 <spine>');
    });
  });

  it('空 spine ⇒ 空态（不是错误）：说清「没有可读章节」', async () => {
    const zip = buildZip([
      MIMETYPE,
      { name: 'META-INF/container.xml', raw: containerXml('content.opf') },
      { name: 'content.opf', raw: opfXml({ items: [], spine: [] }) },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      expect(container.querySelector('.pp-viewer-empty')?.textContent).toContain('spine 为空');
      expect(container.querySelector('.pp-viewer-error')).toBeNull();
      expect(container.querySelector('.pp-viewer-epub-toc')).toBeNull();
    });
  });

  it('空字节 ⇒ 空态（说清可能是空文件或非法 base64）', async () => {
    await withRenderers(async () => {
      await renderEpub(null);
      expect(container.querySelector('.pp-viewer-empty')?.textContent).toContain('读取到的字节为空');
      expect(container.querySelector('.pp-viewer-error')).toBeNull();
    });
  });

  // ── 体积（截断可见 + 上限如实标注）──
  it('单章正文超上限 ⇒ 截断 + 吸顶横幅（`.pp-viewer-note`，不静默截断）', async () => {
    const long = '甲'.repeat(150_000);
    const zip = buildZip([
      MIMETYPE,
      { name: 'META-INF/container.xml', raw: containerXml('content.opf') },
      { name: 'content.opf', raw: opfXml({ items: [{ id: 'c1', href: 'ch1.xhtml' }], spine: ['c1'] }) },
      { name: 'ch1.xhtml', raw: xhtml(CH1_TITLE, [long, long, long]) },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      const note = container.querySelector('.pp-viewer-epub-body .pp-viewer-note')?.textContent ?? '';
      expect(note).toContain('已截断：只显示前 200000 字（本章更长）');
      const shown = paragraphs();
      expect(shown.length).toBe(2); // 150000 + 截断的 50000
      expect(shown[0]?.length).toBe(150_000);
      expect(shown[1]?.endsWith('…')).toBe(true);
    });
  });

  it('压缩包条目数超上限（2000）⇒ 如实标注，正文照常读', async () => {
    const files: ZipFile[] = [
      MIMETYPE,
      { name: 'META-INF/container.xml', raw: containerXml('content.opf') },
      { name: 'content.opf', raw: opfXml({ items: [{ id: 'c1', href: 'ch1.xhtml' }], spine: ['c1'] }) },
      { name: 'ch1.xhtml', raw: xhtml(CH1_TITLE, ['正文。']) },
    ];
    for (let i = files.length; i < 2001; i++) files.push({ name: `extra/${i}.txt`, raw: encoder.encode(`x${i}`) });
    await withRenderers(async () => {
      await renderEpub(buildZip(files));
      const note = container.querySelector('.pp-viewer-epub-toc .pp-viewer-note')?.textContent ?? '';
      expect(note).toContain('压缩包共 2001 条目');
      expect(note).toContain('只读前 2000 条');
      expect(paragraphs()).toEqual(['正文。']);
    });
  });

  it('章节标题与目录关系：非 UTF-8 的章节如实标注，不静默乱码', async () => {
    const bad = new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]); // <p>�< /p>
    const zip = buildZip([
      MIMETYPE,
      { name: 'META-INF/container.xml', raw: containerXml('content.opf') },
      { name: 'content.opf', raw: opfXml({ items: [{ id: 'c1', href: 'ch1.xhtml' }], spine: ['c1'] }) },
      { name: 'ch1.xhtml', raw: bad },
    ]);
    await withRenderers(async () => {
      await renderEpub(zip);
      const note = container.querySelector('.pp-viewer-epub-body .pp-viewer-note')?.textContent ?? '';
      expect(note).toContain('不是合法 UTF-8——已按宽容解码');
      expect(tocTitles()).toEqual(['ch1']);
    });
  });
});
