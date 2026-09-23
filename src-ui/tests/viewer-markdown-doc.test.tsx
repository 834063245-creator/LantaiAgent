// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-markdown-doc — Markdown 独立查看器（渲染面补全 P3 · B14，2026-09-23）的判据面。
//
// 这个环境能测到哪一步（**如实栏**，不 mock 出假绿灯）：
//   · 正文判据是**真渲染结果**（应用侧渲染器产出的 `.pp-md-*` 纸面元素），复用面被换掉即红；
//   · 标题树与锚点**同源**（`splitMarkdownSections` 是纯函数，直接断言 + DOM 对拍）；
//   · 点标题的落点断言用**自铺桩**：jsdom 29 没有 `Element.prototype.scrollIntoView`
//     （实测 lib 里无此方法），本文件按 playwright/puppeteer 同款手法铺一个记录桩，
//     既数调用次数，也抓住 `this`（被滚动的那个 `<section>`）。
//   · 窄容器判据 = **容器宽度**（`clientWidth < 640`）。jsdom 无 ResizeObserver 且
//     `clientWidth` 恒 0 ⇒ 默认走宽档；窄档用 `Element.prototype.clientWidth` 的
//     只读桩喂 400 触发（用完即还原）。
//   · 宿主路径走真取件：临时 def 声明 `heavy:'markdown-doc'`，宿主桥 `loadViewer` 从
//     `app/paper/viewers/`（目录即白名单）取到本件，字节经 `fs_cap read` 行窗口来。
//
// 未覆盖（不伪造）：ResizeObserver 的**运行时**收放（jsdom 无 RO，只测首帧判据与折叠行为）、
// 滚动后的视觉落位（jsdom 无布局）、脚注/数学/HTML 的渲染细节（归应用侧渲染器的判据面）。

import { act, type ComponentType, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heavyViewerIds, loadHeavyViewer } from '../src/app/paper/viewers';
import MarkdownDocViewer, {
  MDDOC_LINE_CAP,
  MDDOC_NARROW_PX,
  outlineOf,
  splitMarkdownSections,
  windowedText,
} from '../src/app/paper/viewers/markdown-doc';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { VIEWER_MARKDOWN_EXTS, viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import {
  type ViewerBytes,
  type ViewerDef,
  type ViewerProps,
  viewerRegistry,
} from '../src/plugins/builtin/renderers/viewer-registry';
import { markdownDocViewer } from '../src/plugins/builtin/renderers/viewers/markdown-doc';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/* ── fixture：四级标题 + 围栏码里的伪标题（真渲染，真解析） ─────────────── */

const FENCE = '```';

const DOC = [
  '# 甲 部',
  '',
  '引子段 **粗体**。',
  '',
  '## 乙 节',
  '',
  '乙的正文。',
  '',
  `${FENCE}md`,
  '# 伪标题（围栏码内，不进目录）',
  FENCE,
  '',
  '### 丙 目',
  '',
  '丙的正文。',
  '',
  '#### 丁（四级，不进目录）',
  '',
  '丁的正文。',
  '',
  '## 乙 节 二',
  '',
  '第二个二级。',
].join('\n');

/* ── 渲染脚手架 ────────────────────────────────────────────────── */

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  vi.clearAllMocks();
});

async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function textBytes(value: string): ViewerBytes {
  return { kind: 'text', value };
}

function viewerProps(over: Partial<ViewerProps> = {}): ViewerProps {
  return {
    block: { id: 'pb:m1:0' } as unknown as ViewerProps['block'],
    label: '样张.md',
    ext: 'md',
    filePath: 'D:/docs/样张.md',
    mode: 'stream',
    ...over,
  };
}

async function renderDirect(over: Partial<ViewerProps> = {}): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(MarkdownDocViewer, viewerProps(over)));
  });
  await settle(1);
}

/** 同一容器换 props 重挂（二次 `createRoot` 会被 React 警告——先卸干净）。 */
async function rerender(over: Partial<ViewerProps> = {}): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  await renderDirect(over);
}

function textOf(selector: string): string {
  return container.querySelector(selector)?.textContent ?? '';
}

function textsOf(selector: string): string[] {
  return [...container.querySelectorAll(selector)].map((el) => el.textContent ?? '');
}

/** jsdom 没有 `scrollIntoView`（实测）——自铺记录桩：数调用次数，也抓住 `this`（落点元素）。 */
function stubScrollIntoView(): { spy: ReturnType<typeof vi.fn>; targets: HTMLElement[]; restore: () => void } {
  const targets: HTMLElement[] = [];
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  const spy = vi.fn(function (this: HTMLElement) {
    targets.push(this);
  });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: spy });
  return {
    spy,
    targets,
    restore: () => {
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    },
  };
}

/** 容器宽度桩（读数判据 = clientWidth；jsdom 恒 0 ⇒ 默认走宽档）。 */
function stubContainerWidth(width: number): () => void {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => width });
  return () => {
    if (original) Object.defineProperty(Element.prototype, 'clientWidth', original);
    else Reflect.deleteProperty(Element.prototype, 'clientWidth');
  };
}

/* ── ① 装载面（认领 / 取件键 / 读取形态） ─────────────────────────── */

describe('Markdown 独立查看器 · 装载面（P3 · B14）', () => {
  it('default 导出 = 取件键 `markdown-doc`：目录即白名单，`loadHeavyViewer` 取到的就是它', async () => {
    expect(typeof MarkdownDocViewer).toBe('function');
    expect(heavyViewerIds()).toContain('markdown-doc');
    expect(await loadHeavyViewer('markdown-doc')).toBe(MarkdownDocViewer);
  });

  it('认领表 = 宿主层分类表；产物侧 def 声明 heavy 取件键 + 文本行窗口', () => {
    expect([...VIEWER_MARKDOWN_EXTS]).toEqual(['md']);
    expect(viewerClassOf('md')).toBe('markdown-doc');
    expect(markdownDocViewer.id).toBe('markdown-doc');
    expect(markdownDocViewer.heavy).toBe('markdown-doc');
    expect(markdownDocViewer.component).toBeUndefined();
    expect(markdownDocViewer.bytesKind).toBe('text');
    expect(markdownDocViewer.readLines).toBeGreaterThan(0);
  });
});

/* ── ② 标题树（条目数 + 层级 + 围栏码不误收） ────────────────────── */

describe('Markdown 独立查看器 · 标题树（P3 · B14）', () => {
  it('分段纯函数：#/##/### 成段，围栏码里的伪标题与四级标题都不进树', () => {
    const sections = splitMarkdownSections(DOC);
    expect(sections.map((s) => [s.level, s.title])).toEqual([
      [1, '甲 部'],
      [2, '乙 节'],
      [3, '丙 目'],
      [2, '乙 节 二'],
    ]);
    expect(outlineOf(sections).map((h) => [h.level, h.section])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [2, 3],
    ]);
    // 首个标题之前的引子自成一段（level 0，不进树）
    const pre = splitMarkdownSections(`开场白\n\n# 甲\n`);
    expect(pre.map((s) => [s.level, s.title])).toEqual([
      [0, ''],
      [1, '甲'],
    ]);
    expect(outlineOf(pre).length).toBe(1);
    // 空/纯空白：没有段（调用方据此出空态）
    expect(splitMarkdownSections('')).toEqual([]);
    expect(splitMarkdownSections('   \n  ')).toEqual([]);
  });

  it('DOM 标题树：条目数 + 层级缩进类 + 目录读数', async () => {
    await renderDirect({ bytes: textBytes(DOC) });
    const items = [...container.querySelectorAll('.pp-viewer-mddoc-tocitem')];
    expect(items.map((el) => el.textContent)).toEqual(['甲 部', '乙 节', '丙 目', '乙 节 二']);
    expect(items.map((el) => (el.className.match(/pp-viewer-mddoc-lv\d/) ?? [''])[0])).toEqual([
      'pp-viewer-mddoc-lv1',
      'pp-viewer-mddoc-lv2',
      'pp-viewer-mddoc-lv3',
      'pp-viewer-mddoc-lv2',
    ]);
    expect(textOf('.pp-viewer-mddoc-tochead')).toBe('目录 · 4 个标题');
    expect(container.querySelector('.pp-viewer-mddoc-tocbtn')).toBeNull(); // 宽档不出折叠按钮
  });
});

/* ── ③ 正文（真纸面渲染） ────────────────────────────────────────── */

describe('Markdown 独立查看器 · 正文（P3 · B14）', () => {
  it('正文走应用侧渲染器：标题/段落/四级标题/围栏码都是真纸面元素', async () => {
    await renderDirect({ bytes: textBytes(DOC) });
    const main = container.querySelector('.pp-viewer-mddoc-main');
    expect(main).not.toBeNull();
    expect(textsOf('.pp-viewer-mddoc-main .pp-md-h1')).toEqual(['甲 部']);
    expect(textsOf('.pp-viewer-mddoc-main .pp-md-h2')).toEqual(['乙 节', '乙 节 二']);
    expect(textsOf('.pp-viewer-mddoc-main .pp-md-h3')).toEqual(['丙 目']);
    // 四级标题不进标题树，但正文照渲染（分段锚点因此不靠「数第 N 个 h*」）
    expect(textsOf('.pp-viewer-mddoc-main .pp-md-h4')).toEqual(['丁（四级，不进目录）']);
    expect(textOf('.pp-viewer-mddoc-main .pp-md-p')).toContain('引子段');
    expect(main?.querySelector('.pp-md-code code')?.textContent).toContain('# 伪标题');
    // 段数与标题数对齐（每段一个 <section> 锚点）
    expect(container.querySelectorAll('.pp-viewer-mddoc-section').length).toBe(4);
  });
});

/* ── ④ 点标题 → 滚动落点（scrollIntoView 桩） ────────────────────── */

describe('Markdown 独立查看器 · 锚点跳转（P3 · B14）', () => {
  it('点标题 → 对应 section 的 scrollIntoView 被调用 + 该条落「当前」态', async () => {
    const stub = stubScrollIntoView();
    try {
      await renderDirect({ bytes: textBytes(DOC) });
      const items = [...container.querySelectorAll('.pp-viewer-mddoc-tocitem')] as HTMLButtonElement[];
      expect(stub.spy).not.toHaveBeenCalled();
      await act(async () => {
        items[1]?.click();
      });
      expect(stub.spy).toHaveBeenCalledTimes(1);
      const target = stub.targets[0];
      expect(target?.className).toContain('pp-viewer-mddoc-section');
      expect(target?.textContent).toContain('乙的正文');
      expect(items[1]?.className).toContain('pp-viewer-mddoc-tocitem--on');
      expect(items[0]?.className).not.toContain('pp-viewer-mddoc-tocitem--on');
      // 再点第三条：落点换成「丙 目」段，调用数 +1（不是复用旧锚点）
      await act(async () => {
        items[2]?.click();
      });
      expect(stub.spy).toHaveBeenCalledTimes(2);
      expect(stub.targets[1]?.textContent).toContain('丙的正文');
    } finally {
      stub.restore();
    }
  });
});

/* ── ⑤ 窄容器（容器宽度 < 640）→ 目录折叠 ────────────────────────── */

describe('Markdown 独立查看器 · 窄容器折叠（P3 · B14）', () => {
  it(`容器宽 < ${MDDOC_NARROW_PX}px → 标题树收成一行按钮，点开可跳转（跳后自动收起）`, async () => {
    const restore = stubContainerWidth(400);
    const stub = stubScrollIntoView();
    try {
      await renderDirect({ bytes: textBytes(DOC) });
      const btn = container.querySelector('.pp-viewer-mddoc-tocbtn') as HTMLButtonElement | null;
      expect(btn?.textContent).toBe('目录 · 4 个标题');
      expect(container.querySelector('.pp-viewer-mddoc-toc')).toBeNull();
      await act(async () => {
        btn?.click();
      });
      expect(container.querySelector('.pp-viewer-mddoc-toc')).not.toBeNull();
      expect(btn?.getAttribute('aria-expanded')).toBe('true');
      const item = container.querySelector('.pp-viewer-mddoc-tocitem') as HTMLButtonElement | null;
      await act(async () => {
        item?.click();
      });
      expect(stub.spy).toHaveBeenCalledTimes(1);
      expect(stub.targets[0]?.textContent).toContain('引子段');
      expect(container.querySelector('.pp-viewer-mddoc-toc')).toBeNull(); // 跳后收起
    } finally {
      stub.restore();
      restore();
    }
  });

  it('宽档（clientWidth 未实测 = 0）不折叠：目录常在（不误判成窄）', async () => {
    await renderDirect({ bytes: textBytes(DOC) });
    expect(container.querySelector('.pp-viewer-mddoc-toc')).not.toBeNull();
    expect(container.querySelector('.pp-viewer-mddoc-tocbtn')).toBeNull();
  });
});

/* ── ⑥ 失败面（错误不静默） ──────────────────────────────────────── */

describe('Markdown 独立查看器 · 失败面（错误不静默）', () => {
  it('无 bytes → 空态（说清「没取到内容」，不是渲染空白）', async () => {
    await renderDirect({ bytes: undefined });
    expect(textOf('.pp-viewer-empty')).toContain('未取到 Markdown 内容');
    expect(container.querySelector('.pp-viewer-error')).toBeNull();
    expect(container.querySelector('.pp-viewer-mddoc')).toBeNull();
  });

  it('空文本 / 纯空白 → 空态（0 字符），不留空白盒、不出空目录', async () => {
    await renderDirect({ bytes: textBytes('') });
    expect(textOf('.pp-viewer-empty')).toContain('Markdown 为空（0 字符）');
    await rerender({ bytes: textBytes('  \n\n   ') });
    expect(textOf('.pp-viewer-empty')).toContain('Markdown 为空（0 字符）');
    expect(container.querySelector('.pp-viewer-mddoc-toc')).toBeNull();
  });

  it('字节形态是 data URI（宿主读取形态不符）→ 可读错误', async () => {
    await renderDirect({ bytes: { kind: 'data-uri', value: 'data:text/markdown;base64,IyDniYc=' } });
    expect(textOf('.pp-viewer-error')).toContain('宿主读取形态与查看器声明不一致');
  });

  it('没有标题的纯正文：正文照渲染，目录不出（不是空态）', async () => {
    await renderDirect({ bytes: textBytes('只有一段正文。\n\n还有一段。') });
    expect(container.querySelector('.pp-viewer-mddoc')).not.toBeNull();
    expect(container.querySelector('.pp-viewer-mddoc-toc')).toBeNull();
    expect(textsOf('.pp-viewer-mddoc-main .pp-md-p').length).toBe(2);
  });

  it('行窗口满（> 8000 行）→ 只渲染前 8000 行 + 吸顶横幅（截断可见，不静默丢尾巴）', async () => {
    const long = ['# 顶', ...Array.from({ length: MDDOC_LINE_CAP }, (_, i) => `第 ${i} 行`)].join('\n');
    expect(windowedText(long)).toEqual({
      text: long.split('\n').slice(0, MDDOC_LINE_CAP).join('\n'),
      truncated: true,
    });
    expect(windowedText('# 短\n正文')).toEqual({ text: '# 短\n正文', truncated: false });
    await renderDirect({ bytes: textBytes(long) });
    expect(textOf('.pp-viewer-note')).toContain(`已截断：只显示前 ${MDDOC_LINE_CAP} 行（文件更长）`);
    // 截断保留的是**前** N 行：首行标题仍在（不是丢头留尾）
    expect(textsOf('.pp-viewer-mddoc-main .pp-md-h1')).toEqual(['顶']);
  });
});

/* ── ⑦ 宿主路径（heavy 取件 + 行窗口读取） ───────────────────────── */

/** 起组合服务 + 装载出厂渲染器行（`components.tsx` 模块装载期注册出厂查看器表）。 */
async function withHostSurface(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
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
  }
}

/** 媒体块（kind='file' + presentation='media'——与 asset-media-load 同一形状）。 */
function mediaBlock(payload: unknown): SourcedBlock {
  return {
    ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
  };
}

describe('Markdown 独立查看器 · 宿主路径（P3 · B14）', () => {
  it('宿主桥 `loadViewer` 真取件 + `fs_cap read` 行窗口（limit = readLines + 1）', async () => {
    const temp: ViewerDef = {
      id: 'test-mddoc-host',
      exts: ['zzmd'],
      needsBytes: true,
      bytesKind: 'text',
      readLines: 8000,
      heavy: 'markdown-doc',
    };
    const dispose = viewerRegistry.register(temp);
    vi.mocked(typedRpc).mockResolvedValue(JSON.stringify({ path: 'D:/docs/a.zzmd', content: DOC }));
    try {
      await withHostSurface(async () => {
        const Comp = resolveAssetBlock('file', 'media');
        expect(Comp).toBeTruthy();
        root = createRoot(container);
        await act(async () => {
          root?.render(
            createElement(Comp as ComponentType<{ block: SourcedBlock }>, {
              block: mediaBlock({ filePath: 'D:/docs/a.zzmd', ext: 'zzmd', label: '样张.md' }),
            }),
          );
        });
        await settle(4);
      });
    } finally {
      dispose();
    }
    expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
      action: 'read',
      file_path: 'D:/docs/a.zzmd',
      limit: 8001,
      is_agent: false,
    });
    expect(container.querySelector('.pp-viewer')).not.toBeNull();
    expect(textOf('.pp-viewer-mddoc-tochead')).toBe('目录 · 4 个标题');
    expect(textsOf('.pp-viewer-mddoc-main .pp-md-h1')).toEqual(['甲 部']);
  });
});
