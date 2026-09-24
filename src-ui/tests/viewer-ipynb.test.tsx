// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-ipynb — 笔记本查看器（渲染面补全 P3 · B11，2026-09-23）的判据面。
//
// 这个环境能测到哪一步（**如实栏**，不 mock 出假绿灯）：
//   · markdown 单元格的判据是**真渲染结果**（应用侧渲染器产出的 `.pp-md-*` 纸面元素），
//     不是「调用了某个函数」——复用面若被换掉，断言当场红；
//   · hljs 是**真高亮**（断言 hljs-* token span 存在，非原文纯文本）；
//   · 失败面逐条走真解析（坏 JSON / 非数组 cells / 行窗口满 / 空文件），每条都断言
//     **可读错误行**且**没有 JSON 兜底**（`.pp-json` 不存在）；
//   · 宿主路径走真装配：临时 def **直挂组件**（批 8c 撤 heavy——组件本体已随 renderers 产物），
//     字节经 `fs_cap read` 行窗口来；白名单不再含 `ipynb`（撤 heavy 的机器判据）。
//
// 未覆盖（要真笔记本才有结论，本文件不伪造）：widget 运行时（无依赖，只出「不渲染」说明）、
// 图片内联（只报 MIME 与字节数，不断言像素）、超 6000 行大笔记本（只钉「不解析 + 明说」）。

import { act, type ComponentType, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heavyViewerIds } from '../src/app/paper/viewers';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { VIEWER_IPYNB_EXTS, viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import {
  type ViewerBytes,
  type ViewerDef,
  type ViewerProps,
  viewerRegistry,
} from '../src/plugins/builtin/renderers/viewer-registry';
import IpyNbViewer, {
  base64Bytes,
  IPYNB_LINE_CAP,
  ipynbViewer,
  parseNotebook,
} from '../src/plugins/builtin/renderers/viewers/ipynb';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/* ── fixture：一份三类型俱全的最小笔记本（真 JSON，真解析） ────────────── */

/** 12 字符 base64（末尾 1 个 `=`）→ 原始 8 字节；用来钉死「字节数」读数。 */
const PNG_B64 = 'iVBORw0KGgo=';
const PNG_BYTES = base64Bytes(PNG_B64);

const MD_CELL = {
  cell_type: 'markdown',
  metadata: {},
  source: ['# 实验记录\n', '\n', '第一段 **粗体** 与 `码`。\n'],
};

const CODE_CELL = {
  cell_type: 'code',
  execution_count: 3,
  metadata: {},
  source: ['import os\n', 'print("hi")\n'],
  outputs: [
    { output_type: 'stream', name: 'stdout', text: ['hi\n'] },
    { output_type: 'stream', name: 'stderr', text: ['warn: 慢\n'] },
    { output_type: 'execute_result', execution_count: 3, metadata: {}, data: { 'text/plain': ['42'] } },
    { output_type: 'display_data', metadata: {}, data: { 'image/png': PNG_B64 } },
    {
      output_type: 'display_data',
      metadata: {},
      data: { 'text/html': '<b>not injected</b>', 'application/vnd.jupyter.widget-view+json': { model_id: 'w1' } },
    },
    {
      output_type: 'error',
      ename: 'ValueError',
      evalue: 'boom',
      traceback: ['\u001b[0;31mValueError\u001b[0m: boom', '  at 第 2 行'],
    },
  ],
};

const RAW_CELL = { cell_type: 'raw', metadata: {}, source: 'raw 原文一行' };

/** 三类型俱全的笔记本文本（host 路径与直挂路径共用一份）。 */
function notebookText(
  cells: unknown[] = [MD_CELL, CODE_CELL, RAW_CELL],
  metadata: unknown = { language_info: { name: 'python3' } },
): string {
  return JSON.stringify({ cells, metadata, nbformat: 4, nbformat_minor: 5 });
}

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

/** 让 promise 链 + React 提交都落地（动态取件 / 解析 / effect 各一轮）。 */
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
    label: '样张.ipynb',
    ext: 'ipynb',
    filePath: 'D:/nb/样张.ipynb',
    mode: 'stream',
    ...over,
  };
}

/** 直挂组件（不经宿主）：props 形状与宿主传参逐字一致。 */
async function renderDirect(over: Partial<ViewerProps> = {}): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(IpyNbViewer, viewerProps(over)));
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

/* ── ① 装载面（认领 / 取件键 / 读取形态） ─────────────────────────── */

describe('笔记本查看器 · 装载面（P3 · B11）', () => {
  it('default 导出 = 组件本体（批 8c 撤 heavy：不再走应用 bundle 取件）', () => {
    expect(typeof IpyNbViewer).toBe('function');
    // 撤 heavy 的机器判据：白名单里不再有它，取件链对它不再是必经之路
    expect(heavyViewerIds()).not.toContain('ipynb');
  });

  it('认领表 = 宿主层分类表；产物侧 def 直挂组件 + 文本行窗口', () => {
    expect([...VIEWER_IPYNB_EXTS]).toEqual(['ipynb']);
    expect(viewerClassOf('ipynb')).toBe('ipynb');
    expect(ipynbViewer.id).toBe('ipynb');
    expect(ipynbViewer.heavy).toBeUndefined();
    expect(ipynbViewer.component).toBe(IpyNbViewer);
    expect(ipynbViewer.needsBytes).toBe(true);
    expect(ipynbViewer.bytesKind).toBe('text');
    expect(ipynbViewer.readLines).toBe(IPYNB_LINE_CAP); // 行窗口与查看器同值（宿主多读 1 行作判据）
  });
});

/* ── ② 单元格序列（三类都出；markdown 是真纸面渲染） ──────────────── */

describe('笔记本查看器 · 单元格序列（P3 · B11）', () => {
  it('三类单元格都出：markdown 走应用侧渲染器 / code 高亮 / raw 原文', async () => {
    await renderDirect({ bytes: textBytes(notebookText()) });
    const cells = [...container.querySelectorAll('.pp-viewer-ipynb-cell')];
    expect(cells.length).toBe(3);
    expect(textsOf('.pp-viewer-ipynb-badge')).toEqual(['md', 'code', 'raw']);

    // markdown 单元格：**真出纸面 markdown 元素**（复用面被换掉这条就红）
    const mdCell = container.querySelector('.pp-viewer-ipynb-cell--markdown');
    expect(mdCell?.querySelector('.pp-md')).not.toBeNull();
    expect(mdCell?.querySelector('.pp-md-h1')?.textContent).toBe('实验记录');
    expect(mdCell?.querySelector('.pp-md strong')?.textContent).toBe('粗体');
    expect(mdCell?.querySelector('.pp-md-ci')?.textContent).toBe('码');

    // code 单元格：mono 代码块 + hljs token（真高亮，不是原文）
    const codeCell = container.querySelector('.pp-viewer-ipynb-cell--code');
    const code = codeCell?.querySelector('.pp-md-code code');
    expect(code?.textContent).toContain('print("hi")');
    expect(code?.innerHTML).toContain('hljs-');
    expect(codeCell?.querySelector('.pp-viewer-ipynb-exec')?.textContent).toBe('In [3]');

    // raw 单元格：原文 mono（nbformat 语义：本就不渲染）
    expect(container.querySelector('.pp-viewer-ipynb-raw')?.textContent).toBe('raw 原文一行');
  });

  it('读数行：单元格总数 + 各类型计数 + 内核名', async () => {
    await renderDirect({ bytes: textBytes(notebookText()) });
    expect(textOf('.pp-viewer-ipynb-count')).toBe('共 3 个单元格');
    expect(textsOf('.pp-viewer-ipynb-stat')).toEqual(['markdown ×1', 'code ×1', 'raw ×1']);
    expect(textOf('.pp-viewer-ipynb-kernel')).toBe('内核 python3');
  });

  it('未知 cell_type 也说话（序号 + 原名 + 具名说明），不静默丢格子', async () => {
    await renderDirect({ bytes: textBytes(notebookText([{ cell_type: 'sql', source: 'select 1' }])) });
    expect(textOf('.pp-viewer-ipynb-badge')).toBe('sql');
    expect(textsOf('.pp-viewer-ipynb-note').join('\n')).toContain('未知单元格类型「sql」');
    expect(textsOf('.pp-viewer-ipynb-stat')).toEqual(['markdown ×0', 'code ×0', 'raw ×0', '未知类型 ×1']);
  });

  it('内核语言不识别（hljs 无此语言）→ 原文 mono，不误着色、不炸', async () => {
    const cell = { cell_type: 'code', execution_count: 1, metadata: {}, source: '纯文本一行', outputs: [] };
    await renderDirect({ bytes: textBytes(notebookText([cell], { kernelspec: { name: '不存在内核' } })) });
    const code = container.querySelector('.pp-md-code code');
    expect(code?.textContent).toBe('纯文本一行');
    expect(code?.innerHTML).not.toContain('hljs-');
    expect(textOf('.pp-viewer-ipynb-kernel')).toBe('内核 不存在内核');
  });
});

/* ── ③ 输出分发（按 output_type） ────────────────────────────────── */

describe('笔记本查看器 · 输出分发（P3 · B11）', () => {
  it('stream / execute_result 的 text/plain → 文本块；stderr 与 error 各自落失败墨', async () => {
    await renderDirect({ bytes: textBytes(notebookText()) });
    const outs = [...container.querySelectorAll('.pp-viewer-ipynb-out')];
    const labels = outs.map((el) => el.querySelector('.pp-viewer-ipynb-outlabel')?.textContent ?? '');
    expect(labels).toEqual(['输出 · stdout', '输出 · stderr', '结果 · text/plain', '错误']);
    expect(outs[0]?.querySelector('.pp-viewer-ipynb-outtext')?.textContent).toBe('hi\n');
    expect(outs[1]?.className).toContain('pp-viewer-ipynb-out--err');
    expect(outs[2]?.querySelector('.pp-viewer-ipynb-outtext')?.textContent).toBe('42');
    expect(outs[3]?.className).toContain('pp-viewer-ipynb-out--error');
  });

  it('图片输出如实说明：MIME + 字节数，且**不**内联（容器里没有 img）', async () => {
    await renderDirect({ bytes: textBytes(notebookText()) });
    const notes = textsOf('.pp-viewer-ipynb-note').join('\n');
    expect(notes).toContain('输出含图片，本查看器不渲染');
    expect(notes).toContain('image/png');
    expect(notes).toContain(`约 ${PNG_BYTES} 字节`);
    expect(container.querySelector('img')).toBeNull();
  });

  it('HTML / widget / 其余 MIME 各自具名说明（绝不把 notebook 里的 HTML 注入纸面）', async () => {
    await renderDirect({ bytes: textBytes(notebookText()) });
    const notes = textsOf('.pp-viewer-ipynb-note').join('\n');
    expect(notes).toContain('输出含 HTML，本查看器不渲染 HTML');
    expect(notes).toContain('Jupyter widget');
    expect(container.querySelector('.pp-viewer-ipynb b')).toBeNull(); // `<b>` 没有被注入
    expect(container.textContent).not.toContain('not injected');
  });

  it('error 输出 → 错误块（ename/evalue + traceback），ANSI 转义剥除', async () => {
    await renderDirect({ bytes: textBytes(notebookText()) });
    const errText = textOf('.pp-viewer-ipynb-out--error .pp-viewer-ipynb-outtext');
    expect(errText).toContain('ValueError: boom');
    expect(errText).toContain('at 第 2 行');
    expect(errText).not.toContain('\u001b');
  });

  it('未知 output_type → 具名说明（不静默丢输出）', async () => {
    const cell = {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      source: 'x',
      outputs: [{ output_type: '未来类型', data: {} }],
    };
    await renderDirect({ bytes: textBytes(notebookText([cell])) });
    expect(textsOf('.pp-viewer-ipynb-note').join('\n')).toContain('未知输出类型「未来类型」');
  });

  it('markdown 单元格的 attachments → 具名说明（附件图片不内联）', async () => {
    const cell = {
      cell_type: 'markdown',
      metadata: {},
      source: '看图',
      attachments: { 'a.png': { 'image/png': PNG_B64 } },
    };
    await renderDirect({ bytes: textBytes(notebookText([cell])) });
    expect(textsOf('.pp-viewer-ipynb-note').join('\n')).toContain('markdown 单元格含 1 个附件');
  });
});

/* ── ④ 失败面（错误不静默；不拿 JSON 兜底） ──────────────────────── */

describe('笔记本查看器 · 失败面（错误不静默，不 JSON 兜底）', () => {
  it('无 bytes → 空态（说清「没取到内容」，不是渲染空白）', async () => {
    await renderDirect({ bytes: undefined });
    expect(textOf('.pp-viewer-empty')).toContain('未取到笔记本内容');
    expect(container.querySelector('.pp-viewer-error')).toBeNull();
  });

  it('字节形态是 data URI（宿主读取形态不符）→ 可读错误', async () => {
    await renderDirect({ bytes: { kind: 'data-uri', value: 'data:application/json;base64,e30=' } });
    expect(textOf('.pp-viewer-error')).toContain('宿主读取形态与查看器声明不一致');
  });

  it('空文件 / 纯空白 → 空态（0 字符），不留空白盒', async () => {
    await renderDirect({ bytes: textBytes('') });
    expect(textOf('.pp-viewer-empty')).toContain('笔记本为空（0 字符）');
    await rerender({ bytes: textBytes('   \n  \n') });
    expect(textOf('.pp-viewer-empty')).toContain('笔记本为空（0 字符）');
  });

  it('坏 JSON → 一行可读错误（带解析器原话 + 文件路径），且**没有 JSON 兜底**', async () => {
    await renderDirect({ bytes: textBytes('{ "cells": [ }') });
    const err = textOf('.pp-viewer-error');
    expect(err).toContain('不是有效的 ipynb JSON');
    expect(err).toContain('D:/nb/样张.ipynb');
    expect(container.querySelector('.pp-json')).toBeNull();
    expect(container.querySelector('.pp-viewer-ipynb')).toBeNull();
  });

  it('cells 不是数组 → 可读错误（列出顶层键——错误即导航）', async () => {
    await renderDirect({ bytes: textBytes(JSON.stringify({ cells: {}, nbformat: 4, metadata: {} })) });
    const err = textOf('.pp-viewer-error');
    expect(err).toContain('没有 cells 数组');
    expect(err).toContain('顶层键');
    expect(err).toContain('nbformat');
    expect(container.querySelector('.pp-json')).toBeNull();
  });

  it('行窗口满（> 6000 行）→ 不解析、明说可能被腰斩（不静默出半份）', async () => {
    const long = `${'\n'.repeat(IPYNB_LINE_CAP)}x`;
    const parsed = parseNotebook(long);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toContain(`文件超过查看器行窗口 ${IPYNB_LINE_CAP} 行`);
    await renderDirect({ bytes: textBytes(long) });
    expect(textOf('.pp-viewer-error')).toContain(`文件超过查看器行窗口 ${IPYNB_LINE_CAP} 行`);
    expect(container.querySelector('.pp-viewer-ipynb')).toBeNull();
  });

  it('cells 是空数组 → 空态（不是「空白盒」，也不是 JSON 倾倒）', async () => {
    await renderDirect({ bytes: textBytes(notebookText([])) });
    expect(textOf('.pp-viewer-empty')).toContain('笔记本里没有单元格');
  });

  it('顶层不是对象（JSON 合法但是数组）→ 可读错误', async () => {
    await renderDirect({ bytes: textBytes('[]') });
    expect(textOf('.pp-viewer-error')).toContain('顶层不是对象');
  });
});

/* ── ⑤ 宿主路径（产物内直挂 + 行窗口读取） ───────────────────────── */

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

describe('笔记本查看器 · 宿主路径（P3 · B11）', () => {
  it('宿主桥 `loadViewer` 真取件 + `fs_cap read` 行窗口（limit = readLines + 1）', async () => {
    const temp: ViewerDef = {
      id: 'test-ipynb-host',
      exts: ['zzipynb'],
      needsBytes: true,
      bytesKind: 'text',
      readLines: IPYNB_LINE_CAP,
      component: IpyNbViewer,
    };
    const dispose = viewerRegistry.register(temp);
    vi.mocked(typedRpc).mockResolvedValue(JSON.stringify({ path: 'D:/nb/a.zzipynb', content: notebookText() }));
    try {
      await withHostSurface(async () => {
        const Comp = resolveAssetBlock('file', 'media');
        expect(Comp).toBeTruthy();
        root = createRoot(container);
        await act(async () => {
          root?.render(
            createElement(Comp as ComponentType<{ block: SourcedBlock }>, {
              block: mediaBlock({ filePath: 'D:/nb/a.zzipynb', ext: 'zzipynb', label: '样张.ipynb' }),
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
      file_path: 'D:/nb/a.zzipynb',
      limit: IPYNB_LINE_CAP + 1,
      is_agent: false,
    });
    expect(container.querySelector('.pp-viewer')).not.toBeNull();
    expect(textOf('.pp-viewer-ipynb-count')).toBe('共 3 个单元格');
    expect(container.querySelector('.pp-viewer-ipynb-cell--markdown .pp-md-h1')?.textContent).toBe('实验记录');
  });

  it('取件键不存在 → 宿主出「重查看器装载失败」可读错误（登记面的降级链仍成立）', async () => {
    const temp: ViewerDef = {
      id: 'test-ipynb-missing',
      exts: ['zzipynb2'],
      needsBytes: true,
      bytesKind: 'text',
      readLines: 100,
      heavy: '不存在的笔记本查看器',
    };
    const dispose = viewerRegistry.register(temp);
    vi.mocked(typedRpc).mockResolvedValue(JSON.stringify({ path: 'D:/nb/a.zzipynb2', content: notebookText() }));
    try {
      await withHostSurface(async () => {
        const Comp = resolveAssetBlock('file', 'media');
        root = createRoot(container);
        await act(async () => {
          root?.render(
            createElement(Comp as ComponentType<{ block: SourcedBlock }>, {
              block: mediaBlock({ filePath: 'D:/nb/a.zzipynb2', ext: 'zzipynb2', label: '临时.ipynb' }),
            }),
          );
        });
        await settle(3);
      });
    } finally {
      dispose();
    }
    expect(textOf('.pp-viewer-error')).toContain('重查看器「不存在的笔记本查看器」装载失败');
  });
});
