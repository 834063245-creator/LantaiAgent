// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// B4 渲染面（multimodal-image-plan）：附图入卷后的两侧对拍——
//   1. markdown 远端图：独立行 ![alt](http/https) → img 块（协议白名单在解析层，
//      非白名单降级 alt 文本——DSH remoteImageUrl 同纪律）+ measure 固定盒镜像；
//   2. 来文附图缩略行：translate payload.images 旁挂 + measure wrap 行几何
//      + UserBody 渲染（进程内预览 URL 快径 / 盘上附件回读慢径两路）。
// INVARIANTS #14 钉面：块/卷只携引用，渲染期才读字节成 data URI。
// harness 镜像 paper-math-rendering.test.ts / paper-c10-attachments.test.tsx
// （pretext mock + 真实 react-dom createRoot）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock '@chenglou/pretext'（同款范式）
const { prepareMock, layoutMock } = vi.hoisted(() => ({
  prepareMock: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: prepareMock,
  layout: layoutMock,
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

// 盘上附件回读慢径：kernelReadFileBase64 按路径出桩值（deadbeef 桩 = 读失败
// 空串 → readAttachmentBase64 上抛「附图读取失败」——错误不静默钉面）。
// typedRpc（2026-10 本地图）：md 本地图经 fs_cap read_base64 回读——按路径出桩：
//   nope → 沙箱式拒绝（读取失败行）；empty-file → 空读（上抛）；余 → JSON 字符串载包。
vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  return {
    ...actual,
    kernelReadFileBase64: vi.fn(async (filePath: string) => (filePath.includes('deadbeef') ? '' : btoa('stub-bytes'))),
    typedRpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'fs_cap' && params.action === 'read_base64') {
        const fp = String(params.file_path ?? '');
        if (fp.includes('nope')) throw new Error(`path "${fp}" is outside project directory`);
        if (fp.includes('empty-file')) return JSON.stringify({ path: fp, base64: '' });
        return JSON.stringify({ path: fp, base64: btoa('stub-bytes') });
      }
      throw new Error(`unexpected rpc: ${method}/${String(params.action ?? '')}`);
    }),
  };
});

import { previewUrlFor, seedPreviewUrl } from '../src/app/chat/image-intake';
import { useShellStore } from '../src/app/shell-store';
import { createBlock } from '../src/paper/block-model';
import { imageSrcRef, parseMarkdown, parseMarkdownIncremental } from '../src/paper/markdown';
import { translateMessages } from '../src/paper/translate';
import { builtinRendererDefs } from '../src/plugins/builtin/paper-renderers/renderers';
import { measureBlockHeight, measureMdBlocks, userImagesRowHeight } from '../src/plugins/builtin/paper-shell/measure';
import { CHROME_TOKENS, MD_TOKENS } from '../src/plugins/builtin/paper-shell/type-tokens';
import type { ChatImageRef } from '../src/provider/types';
import type { UserMessage } from '../src/ui/message-model';

/* jsdom 无 URL.createObjectURL——seedPreviewUrl（object URL 种子）需要桩。 */
let blobSeq = 0;
const origCreateObjectURL = URL.createObjectURL;
beforeAll(() => {
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:paper-image-${blobSeq++}`;
});
afterAll(() => {
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = origCreateObjectURL;
});

function block(kind: Parameters<typeof createBlock>[0], payload: object) {
  return createBlock(kind, payload as never, { messageId: 'm', part: null });
}

function rendererFor(kind: string) {
  const def = builtinRendererDefs().find((d) => d.kind === kind);
  expect(def, `内置渲染器 ${kind} 存在`).toBeDefined();
  return def!.component;
}

function imgRef(id: string, over?: Partial<ChatImageRef>): ChatImageRef {
  return { id, mediaType: 'image/png', bytes: 1024, width: 800, height: 600, name: `${id}.png`, ...over };
}

function userMsg(images?: ChatImageRef[]): UserMessage {
  return {
    role: 'user',
    _id: 'm-b4-user',
    text: '看这张图',
    ...(images ? { images } : undefined),
    sessionIndex: 0,
  };
}

/* ═══ 正文图 — 图源分类（imageSrcRef：远端白名单 + 本地绝对路径）═══ */

describe('paper/markdown — 图源分类（imageSrcRef）', () => {
  it('http/https 绝对 URL → remote 原样（不查扩展名）', () => {
    expect(imageSrcRef('https://example.com/a.png')).toEqual({ src: 'https://example.com/a.png', local: false });
    expect(imageSrcRef('http://example.com/b.jpg')).toEqual({ src: 'http://example.com/b.jpg', local: false });
    expect(imageSrcRef('https://example.com/img?id=1')).toEqual({ src: 'https://example.com/img?id=1', local: false });
  });
  it('本地绝对路径（盘符两种拼写 / UNC / POSIX）→ local（扩展名大小写不敏感）', () => {
    expect(imageSrcRef('D:/shots/a.png')).toEqual({ src: 'D:/shots/a.png', local: true });
    expect(imageSrcRef('D:\\shots\\a.PNG')).toEqual({ src: 'D:\\shots\\a.PNG', local: true });
    expect(imageSrcRef('\\\\srv\\share\\x.jpg')).toEqual({ src: '\\\\srv\\share\\x.jpg', local: true });
    expect(imageSrcRef('/home/u/x.webp')).toEqual({ src: '/home/u/x.webp', local: true });
  });
  it('file:// URI → local（归一为路径；%XX 解码；盘符去前导斜杠）', () => {
    expect(imageSrcRef('file:///D:/shots/x.png')).toEqual({ src: 'D:/shots/x.png', local: true });
    expect(imageSrcRef('file:///D:/My%20Shots/a%2Bb.gif')).toEqual({ src: 'D:/My Shots/a+b.gif', local: true });
  });
  it('本地非图扩展名 → 拒（维持降级，不产盒）', () => {
    expect(imageSrcRef('D:/notes.txt')).toBeUndefined();
    expect(imageSrcRef('file:///D:/doc.pdf')).toBeUndefined();
    expect(imageSrcRef('/etc/hosts')).toBeUndefined();
  });
  it('data:/ftp:/mailto: 一律拒绝', () => {
    expect(imageSrcRef('data:image/png;base64,AAAA')).toBeUndefined();
    expect(imageSrcRef('ftp://host/x.png')).toBeUndefined();
    expect(imageSrcRef('mailto:a@b.c')).toBeUndefined();
  });
  it('相对路径拒绝（裸名/前缀相对都不进图通道）', () => {
    expect(imageSrcRef('./rel.png')).toBeUndefined();
    expect(imageSrcRef('assets/x.png')).toBeUndefined();
    expect(imageSrcRef('pic.png')).toBeUndefined();
  });
});

describe('paper/markdown — 独立行图块解析（B4 D-9）', () => {
  it('独立行 ![alt](https://…) → img 块，前后段落独立', () => {
    const blocks = parseMarkdown('前文\n\n![示意图](https://example.com/a.png)\n\n后文');
    expect(blocks.map((b) => b.t)).toEqual(['p', 'img', 'p']);
    const img = blocks[1] as Extract<(typeof blocks)[number], { t: 'img' }>;
    expect(img.alt).toBe('示意图');
    expect(img.src).toBe('https://example.com/a.png');
  });

  it('空 alt ![](https://…) 也收（常见形态），alt 为空串', () => {
    const blocks = parseMarkdown('![](https://example.com/b.png)');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ t: 'img', alt: '', src: 'https://example.com/b.png' });
  });

  it('带 "title" 后缀的图行：URL 不吃 title', () => {
    const blocks = parseMarkdown('![图](https://example.com/c.png "标题")');
    expect(blocks[0]).toMatchObject({ t: 'img', alt: '图', src: 'https://example.com/c.png' });
  });

  it('本地图路径一：file:// URI → local img 块（路径归一，不再降级）', () => {
    const blocks = parseMarkdown('![本地截图](file:///D:/shots/x.png)');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ t: 'img', alt: '本地截图', src: 'D:/shots/x.png', local: true });
  });

  it('本地图路径二：盘符绝对路径直出 → local img 块（前后段落独立）', () => {
    const blocks = parseMarkdown('看图\n\n![图](D:/shots/a.png)');
    expect(blocks.map((b) => b.t)).toEqual(['p', 'img']);
    expect(blocks[1]).toMatchObject({ t: 'img', src: 'D:/shots/a.png', local: true });
  });

  it('非图扩展名 / 相对路径 / data: 源仍降级 alt 文本段落（2026-10 分类）', () => {
    for (const src of ['D:/notes.txt', './rel.png', 'data:image/png;base64,AAAA']) {
      const blocks = parseMarkdown(`![说明](${src})`);
      const p = blocks[0] as Extract<(typeof blocks)[number], { t: 'p' }>;
      expect(p.inl.map((s) => s.text).join(''), src).toBe('说明');
    }
  });

  it('白名单拒绝路径二：相对路径降级 alt 文本段落', () => {
    const blocks = parseMarkdown('![缩略](./rel.png)');
    expect(blocks[0]).toMatchObject({ t: 'p' });
    const p = blocks[0] as Extract<(typeof blocks)[number], { t: 'p' }>;
    expect(p.inl.map((s) => s.text).join('')).toBe('缩略');
  });

  it('白名单拒绝路径三：alt 空的非白名单图行整行不产块（data: 巨串不灌纸面）', () => {
    const blocks = parseMarkdown('前文\n\n![](data:image/png;base64,AAAA)\n\n后文');
    expect(blocks.map((b) => b.t)).toEqual(['p', 'p']);
  });

  it('行内混排（非独立行）不产 img 块——走段落 + 链接既有语义', () => {
    const blocks = parseMarkdown('看这个 ![图](https://example.com/a.png) 很好');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].t).toBe('p');
  });

  it('段落紧邻图行（无空行）：图行按块起点切段落（isBlockStart 收编）', () => {
    const blocks = parseMarkdown('看图：\n![图](https://example.com/a.png)');
    expect(blocks.map((b) => b.t)).toEqual(['p', 'img']);
  });

  it('引用内的图行：递归解析同收 img 块', () => {
    const blocks = parseMarkdown('> ![引图](https://example.com/q.png)');
    expect(blocks).toHaveLength(1);
    const quote = blocks[0] as Extract<(typeof blocks)[number], { t: 'quote' }>;
    expect(quote.blocks[0]).toMatchObject({ t: 'img', alt: '引图' });
  });

  it('增量解析与全量一致（img 行在尾部追加场景）', () => {
    const full = parseMarkdown('前文\n\n![图](https://example.com/a.png)');
    // 尾部追加图行：复用前缀块，只重解析末块（img 行起 isBlockStart 切段）
    const step1 = parseMarkdownIncremental('前文', null);
    const step2 = parseMarkdownIncremental('前文\n\n![图](https://example.com/a.png)', step1.state);
    expect(step2.blocks.map((b) => b.t)).toEqual(['p', 'img']);
    expect(full.map((b) => b.t)).toEqual(['p', 'img']);
  });
});

/* ═══ markdown 远端图 — measure 固定盒镜像 ═══ */

describe('paper/measure — md img 固定盒（B4 D-9）', () => {
  const W = 720;
  it('img 块高 = 固定盒（末元素无 gap）', () => {
    const blocks = parseMarkdown('![图](https://example.com/a.png)');
    // measureMdBlocks 返回 { h, ink }（2026-09-20：墨迹几何与测高同趟产出）
    expect(measureMdBlocks(blocks, W).h).toBe(MD_TOKENS.imgBoxH);
  });

  it('本地图同盒（remote/local 几何无差——分类只决定渲染源，不动测高）', () => {
    const blocks = parseMarkdown('![本地](D:/shots/a.png)');
    expect(measureMdBlocks(blocks, W).h).toBe(MD_TOKENS.imgBoxH);
  });

  it('img + 后继段落：盒 + gap + 段落高', () => {
    const blocks = parseMarkdown('![图](https://example.com/a.png)\n\n后文');
    const onlyImg = measureMdBlocks([blocks[0]], W).h;
    const both = measureMdBlocks(blocks, W).h;
    // 差值 = imgGap + 段落高（pretext mock 恒 36 + 末元素 p 无 gap）
    expect(both - onlyImg).toBe(MD_TOKENS.imgGap + 36);
  });

  it('D-9 钉值：固定盒高 160（chem 180px 固定盒先例同族）', () => {
    expect(MD_TOKENS.imgBoxH).toBe(160);
    expect(CHROME_TOKENS.userImages).toEqual({ thumb: 64, gap: 8, marginTop: 10 });
  });
});

/* ═══ 来文附图 — translate + measure wrap 行几何 ═══ */

describe('B4 来文附图 — translate payload.images 旁挂', () => {
  it('带附图的来文：payload.images 携带引用（字节永不进块），正文不混入', () => {
    const ref = imgRef('aaaabbbbccccdddd');
    const blocks = translateMessages([userMsg([ref])]);
    expect(blocks).toHaveLength(1);
    const p = blocks[0].payload as { text: string; images?: ChatImageRef[] };
    expect(p.text).toBe('看这张图');
    expect(p.images).toEqual([ref]);
  });

  it('无附图来文：images 不出现（undefined 不入 payload）', () => {
    const blocks = translateMessages([userMsg()]);
    const p = blocks[0].payload as { images?: unknown };
    expect(p.images).toBeUndefined();
  });
});

describe('B4 来文附图 — measure wrap 行几何（userImagesRowHeight）', () => {
  const W = 560; // USER_BLOCK_WIDTH
  it('单图：上距 + tile 一行', () => {
    const t = CHROME_TOKENS.userImages;
    expect(userImagesRowHeight(1, W)).toBe(t.marginTop + t.thumb);
  });

  it('8 图 @560：perRow=7 → 两行（wrap 几何整除推得）', () => {
    const t = CHROME_TOKENS.userImages;
    const perRow = Math.floor((W + t.gap) / (t.thumb + t.gap));
    expect(perRow).toBe(7);
    expect(userImagesRowHeight(8, W)).toBe(t.marginTop + 2 * t.thumb + t.gap);
  });

  it('钉住窄块（宽不足一 tile）：单列防零除', () => {
    const t = CHROME_TOKENS.userImages;
    expect(userImagesRowHeight(3, 10)).toBe(t.marginTop + 3 * t.thumb + 2 * t.gap);
  });

  it('user 块计高：附图行线性叠加（1 图 = 上距+tile）', () => {
    const without = translateMessages([userMsg()])[0];
    const with1 = translateMessages([userMsg([imgRef('fff0')])])[0];
    without.w = W;
    with1.w = W;
    const t = CHROME_TOKENS.userImages;
    expect(measureBlockHeight(with1) - measureBlockHeight(without)).toBeCloseTo(t.marginTop + t.thumb, 5);
  });
});

/* ═══ 来文附图 — UserBody 渲染（两径）+ markdown img 渲染 ═══ */

describe('B4 渲染 — UserBody 附图缩略行 + MdImage', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useShellStore.getState().setProjectPath('');
  });

  it('快径：进程内预览 URL（seedPreviewUrl）直出缩略图', () => {
    const seeded = imgRef('seeded-0001');
    seedPreviewUrl(seeded.id, new Uint8Array([1, 2, 3]), seeded.mediaType);
    const blocks = translateMessages([userMsg([seeded])]);
    act(() => {
      root?.render(createElement(rendererFor('user'), { block: blocks[0] }));
    });
    const row = container!.querySelector('.pp-user-images');
    expect(row).not.toBeNull();
    const thumb = container!.querySelector<HTMLButtonElement>('.pp-user-image');
    expect(thumb).not.toBeNull();
    const img = thumb!.querySelector('img');
    expect(img?.getAttribute('src')).toBe(previewUrlFor(seeded.id));
    expect(img?.getAttribute('alt')).toBe('seeded-0001.png');
    // 无附图语义隔离：附件行不出现
    expect(container!.querySelector('.pp-user-files')).toBeNull();
  });

  it('点击缩略图 → 全屏浮层（media 渲染器同款 .pp-media-preview-overlay）', () => {
    const seeded = imgRef('seeded-0002');
    seedPreviewUrl(seeded.id, new Uint8Array([4]), seeded.mediaType);
    const blocks = translateMessages([userMsg([seeded, imgRef('seeded-0002b')])]);
    act(() => {
      root?.render(createElement(rendererFor('user'), { block: blocks[0] }));
    });
    expect(document.querySelector('.pp-media-preview-overlay')).toBeNull();
    act(() => {
      container!.querySelector<HTMLButtonElement>('.pp-user-image')?.click();
    });
    const overlay = document.querySelector('.pp-media-preview-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('img')?.className).toBe('pp-media-preview');
  });

  it('慢径：重启后（无预览种子）经 readAttachmentBase64 回读盘上附件 → data URI', async () => {
    useShellStore.getState().setProjectPath('D:/ws-root');
    const disk = imgRef('diskfile-0001');
    const blocks = translateMessages([userMsg([disk])]);
    act(() => {
      root?.render(createElement(rendererFor('user'), { block: blocks[0] }));
    });
    await act(async () => {});
    const img = container!.querySelector('.pp-user-image img');
    expect(img?.getAttribute('src')).toBe(`data:image/png;base64,${btoa('stub-bytes')}`);
  });

  it('慢径读失败：占位盒「读取失败」不静默（错误可见）', async () => {
    useShellStore.getState().setProjectPath('D:/ws-root');
    const dead = imgRef('deadbeef-cafe');
    const blocks = translateMessages([userMsg([dead])]);
    act(() => {
      root?.render(createElement(rendererFor('user'), { block: blocks[0] }));
    });
    await act(async () => {});
    expect(container!.querySelector('.pp-user-image img')).toBeNull();
    const fallback = container!.querySelector('.pp-user-image-fallback');
    expect(fallback?.textContent).toBe('读取失败');
    const btn = container!.querySelector<HTMLButtonElement>('.pp-user-image');
    expect(btn?.getAttribute('title')).toContain('附图读取失败');
  });

  it('工作区未开：占位盒提示不可读', async () => {
    const noWs = imgRef('nows-0001');
    const blocks = translateMessages([userMsg([noWs])]);
    act(() => {
      root?.render(createElement(rendererFor('user'), { block: blocks[0] }));
    });
    await act(async () => {});
    expect(container!.querySelector('.pp-user-image-fallback')?.textContent).toBe('读取失败');
  });

  it('markdown 独立行图：.pp-md-imgbox 固定盒 + img（src/alt/loading）', () => {
    const md = block('markdown', { text: '前文\n\n![示意图](https://example.com/a.png)' });
    act(() => {
      root?.render(createElement(rendererFor('markdown'), { block: md }));
    });
    const box = container!.querySelector('.pp-md-imgbox');
    expect(box).not.toBeNull();
    const img = box!.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img?.getAttribute('alt')).toBe('示意图');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('markdown 非白名单源（相对路径）：不产图盒（降级 alt 文本在段内）', () => {
    const md = block('markdown', { text: '![相对](./x.png)' });
    act(() => {
      root?.render(createElement(rendererFor('markdown'), { block: md }));
    });
    expect(container!.querySelector('.pp-md-imgbox')).toBeNull();
    expect(container!.querySelector('.pp-md-p')?.textContent).toBe('相对');
  });

  it('远端图加载失败：onError → 盒内换 alt 行（盒高不变，错误不静默）', () => {
    const md = block('markdown', { text: '![断图](https://example.com/404.png)' });
    act(() => {
      root?.render(createElement(rendererFor('markdown'), { block: md }));
    });
    const img = container!.querySelector<HTMLImageElement>('.pp-md-img');
    expect(img).not.toBeNull();
    act(() => {
      img!.dispatchEvent(new Event('error'));
    });
    expect(container!.querySelector('.pp-md-img')).toBeNull();
    const alt = container!.querySelector('.pp-md-img-alt');
    expect(alt?.textContent).toBe('断图');
    // 盒仍在（固定盒不塌——版面稳定）
    expect(container!.querySelector('.pp-md-imgbox')).not.toBeNull();
  });

  it('本地图：fs_cap read_base64 → data URI 直出（JSON 字符串双形态载包）', async () => {
    const md = block('markdown', { text: '![本地图](D:/shots/a.png)' });
    act(() => {
      root?.render(createElement(rendererFor('markdown'), { block: md }));
    });
    await act(async () => {});
    const box = container!.querySelector('.pp-md-imgbox');
    expect(box).not.toBeNull();
    const img = box!.querySelector('img');
    expect(img?.getAttribute('src')).toBe(`data:image/png;base64,${btoa('stub-bytes')}`);
    expect(img?.getAttribute('alt')).toBe('本地图');
  });

  it('本地图读取失败：盒内可读错误行「图片不可读」（title 带路径与原因，不静默）', async () => {
    const md = block('markdown', { text: '![断图](D:/nope/x.png)' });
    act(() => {
      root?.render(createElement(rendererFor('markdown'), { block: md }));
    });
    await act(async () => {});
    expect(container!.querySelector('.pp-md-img')).toBeNull();
    const line = container!.querySelector('.pp-md-img-alt');
    expect(line?.textContent).toBe('图片不可读：x.png');
    expect(line?.getAttribute('title')).toContain('outside project directory');
    // 盒仍在（固定盒不塌——版面稳定）
    expect(container!.querySelector('.pp-md-imgbox')).not.toBeNull();
  });

  it('本地图解码失败：onError → 错误行（同盒同形，错误不静默）', async () => {
    const md = block('markdown', { text: '![坏图](D:/shots/bad.png)' });
    act(() => {
      root?.render(createElement(rendererFor('markdown'), { block: md }));
    });
    await act(async () => {});
    const img = container!.querySelector<HTMLImageElement>('.pp-md-img');
    expect(img).not.toBeNull();
    act(() => {
      img!.dispatchEvent(new Event('error'));
    });
    expect(container!.querySelector('.pp-md-img')).toBeNull();
    const line = container!.querySelector('.pp-md-img-alt');
    expect(line?.textContent).toBe('图片不可读：bad.png');
    expect(line?.getAttribute('title')).toContain('解码失败');
  });

  it('远端图点击 → 放大浮层（.pp-media-preview-overlay；Esc 关闭）', () => {
    const md = block('markdown', { text: '![大图](https://example.com/big.png)' });
    act(() => {
      root?.render(createElement(rendererFor('markdown'), { block: md }));
    });
    expect(document.querySelector('.pp-media-preview-overlay')).toBeNull();
    act(() => {
      container!.querySelector<HTMLButtonElement>('.pp-md-img-zoom')?.click();
    });
    const overlay = document.querySelector('.pp-media-preview-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('img')?.getAttribute('src')).toBe('https://example.com/big.png');
    // Esc 关闭（Overlay 原语统一语义）
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.querySelector('.pp-media-preview-overlay')).toBeNull();
  });

  it('本地图点击 → 放大浮层（同一 data URI，不二次读取）', async () => {
    const md = block('markdown', { text: '![本地图](D:/shots/a.png)' });
    act(() => {
      root?.render(createElement(rendererFor('markdown'), { block: md }));
    });
    await act(async () => {});
    act(() => {
      container!.querySelector<HTMLButtonElement>('.pp-md-img-zoom')?.click();
    });
    const overlay = document.querySelector('.pp-media-preview-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${btoa('stub-bytes')}`);
  });
});
