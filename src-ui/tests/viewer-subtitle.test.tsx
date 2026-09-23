// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-subtitle — 字幕查看器（渲染面补全 B13，2026-09-23）：
//   ① 认领表 = 宿主层分类表（srt / vtt ↔ 'subtitle' 类）；
//   ② srt 解析：序号 + 起止 + 文本进时间轴表，读数 = 条数 + 总时长（末条结束）；
//   ③ vtt 解析：`WEBVTT` 头与 `NOTE` 块跳过不报错，点号毫秒形态收得下；
//   ④ **坏块不静默**：计数 + 一行「N 块无法解析（已跳过）」，其余照常显示；
//   ⑤ 行窗口截断：吸顶横幅说清「只显示前 N 行」，被切断的残块不算坏块；
//   ⑥ 失败面：读口坏响应 / 空文件都给可读文案（不空白、不 JSON 兜底）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { VIEWER_SUBTITLE_EXTS, viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
import { subtitleViewer } from '../src/plugins/builtin/renderers/viewers/subtitle';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/** 读口成功响应（`fs_cap read` 的文本结局：{path, content}）。 */
function readOk(content: string): string {
  return JSON.stringify({ path: 'D:/a.srt', content });
}

/** 注册自带 + 用完摘除：主编排批次把本查看器加进 `viewers/index.ts` 后，
 *  这里不因重名再注册（装载期重名是硬拒绝，不是可忽略的重复）。 */
function withViewerRegistered(): () => void {
  if (viewerRegistry.get(subtitleViewer.id)) return () => {};
  return viewerRegistry.register(subtitleViewer);
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

/** 时间轴表的数据行（表头不在 tbody 里）。 */
function rows(container: HTMLElement): string[][] {
  return [...container.querySelectorAll('.pp-viewer-sub-table tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''),
  );
}

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  '第一句字幕',
  '',
  '2',
  '00:00:04,500 --> 00:00:06,000',
  '第二句',
  '换行的第二行',
  '',
].join('\n');

const VTT = [
  'WEBVTT',
  '',
  'NOTE 这是一段注释，不是字幕',
  '注释的第二行',
  '',
  'cue-1',
  '00:00:02.000 --> 00:00:03.500',
  '点号毫秒形态',
  '',
].join('\n');

const MIXED = [
  '1',
  '00:00:01,000 --> 00:00:02,000',
  '好块',
  '',
  '这不是时间轴',
  '也不是',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,000',
  '第二个好块',
].join('\n');

describe('字幕查看器 · 认领面（B13）', () => {
  it('认领表就是宿主层分类表（srt / vtt 全在 subtitle 类）', () => {
    expect([...subtitleViewer.exts]).toEqual([...VIEWER_SUBTITLE_EXTS]);
    expect([...subtitleViewer.exts]).toEqual(['srt', 'vtt']);
    for (const ext of VIEWER_SUBTITLE_EXTS) expect(viewerClassOf(ext), ext).toBe('subtitle');
  });

  it('文本读取形态：bytesKind text + 行窗口 readLines（不整份进 IPC）', async () => {
    expect(subtitleViewer.id).toBe('subtitle');
    expect(subtitleViewer.bytesKind).toBe('text');
    expect(subtitleViewer.readLines).toBe(4000);
    await withRenderers(async () => {
      for (const ext of subtitleViewer.exts) expect(viewerRegistry.resolve(ext)?.id, ext).toBe('subtitle');
    });
  });

  it('本查看器不认领别类的扩展名（认领表逐字 = 分类表）', () => {
    for (const ext of ['eml', 'ttf', 'pdf', 'md', 'csv', 'json']) {
      expect(subtitleViewer.exts.includes(ext), ext).toBe(false);
    }
  });
});

describe('字幕查看器 · 解析与渲染（B13）', () => {
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

  async function renderSubtitle(content: string, payload?: Record<string, unknown>): Promise<void> {
    vi.mocked(typedRpc).mockResolvedValue(readOk(content));
    const Comp = resolveAssetBlock('file', 'media')!;
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(Comp, { block: mediaBlock(payload ?? { filePath: 'D:/a.srt', ext: 'srt', label: 'a.srt' }) }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('srt：行窗口读（limit = readLines + 1）+ 时间轴表 + 条数/总时长读数', async () => {
    await withRenderers(async () => {
      await renderSubtitle(SRT);
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read',
        file_path: 'D:/a.srt',
        limit: 4001,
        is_agent: false,
      });
      expect(rows(container)).toEqual([
        ['1', '00:00:01.000', '00:00:04.000', '第一句字幕'],
        ['2', '00:00:04.500', '00:00:06.000', '第二句\n换行的第二行'],
      ]);
      expect(container.querySelector('.pp-viewer-sub-meta')?.textContent).toBe('共 2 条 · 总时长 00:00:06.000');
      expect(container.querySelector('.pp-viewer-note')).toBeNull(); // 无坏块 ⇒ 无提示
    });
  });

  it('vtt：WEBVTT 头与 NOTE 块跳过不报错，点号毫秒形态照收（cue id 当序号）', async () => {
    await withRenderers(async () => {
      await renderSubtitle(VTT, { filePath: 'D:/a.vtt', ext: 'vtt', label: 'a.vtt' });
      expect(rows(container)).toEqual([['cue-1', '00:00:02.000', '00:00:03.500', '点号毫秒形态']]);
      expect(container.querySelector('.pp-viewer-note')).toBeNull();
      expect(container.textContent).not.toContain('WEBVTT');
      expect(container.textContent).not.toContain('这是一段注释');
      expect(container.querySelector('.pp-viewer-sub-meta')?.textContent).toBe('共 1 条 · 总时长 00:00:03.500');
    });
  });

  it('坏块不静默：计数 + 一行「1 块无法解析（已跳过）」，好块照常显示', async () => {
    await withRenderers(async () => {
      await renderSubtitle(MIXED);
      const note = container.querySelector('.pp-viewer-note')?.textContent ?? '';
      expect(note).toContain('1 块无法解析（已跳过）');
      expect(rows(container).map((r) => r[3])).toEqual(['好块', '第二个好块']);
      expect(container.querySelector('.pp-viewer-sub-meta')?.textContent).toBe('共 2 条 · 总时长 00:00:04.000');
    });
  });

  it('时间码倒序：有合法时间轴行 ⇒ 不算坏块，按原值照显（不吞行）', async () => {
    await withRenderers(async () => {
      await renderSubtitle(['1', '00:00:09,000 --> 00:00:03,000', '倒序块', ''].join('\n'));
      expect(rows(container)).toEqual([['1', '00:00:09.000', '00:00:03.000', '倒序块']]);
    });
  });

  it('行窗口截断：吸顶横幅说清；被切断的残块**不算**坏块', async () => {
    // 每条 6 行 × 700 条 = 4200 行 > 4000 行窗口；窗口里最后一条被切掉尾部
    const long = Array.from(
      { length: 700 },
      (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:02,000\n第 ${i + 1} 句\n第二行\n第三行\n`,
    ).join('\n');
    await withRenderers(async () => {
      await renderSubtitle(long);
      const notes = [...container.querySelectorAll('.pp-viewer-note')].map((n) => n.textContent ?? '');
      expect(notes.length).toBe(1);
      expect(notes[0]).toContain('已截断：只显示前 4000 行');
      expect(rows(container).length).toBe(666);
      expect(container.querySelector('.pp-viewer-sub-meta')?.textContent).toBe('共 666 条 · 总时长 00:00:02.000');
    });
  });

  it('截断切在块中间且窗口内无完整块 ⇒ 说清是截断（不谎报「没有时间轴块」）', async () => {
    const oneBlock = [
      '1',
      '00:00:01,000 --> 00:00:02,000',
      ...Array.from({ length: 4200 }, (_, i) => `行 ${i + 1}`),
    ].join('\n');
    await withRenderers(async () => {
      await renderSubtitle(oneBlock);
      const empty = container.querySelector('.pp-viewer-empty')?.textContent ?? '';
      expect(empty).toContain('窗口内没有完整的时间轴块');
      expect(empty).toContain('已截断：只显示前 4000 行');
    });
  });

  it('全是坏块 ⇒ 空态说清「未解析到时间轴块（N 块无法解析）」，不空白', async () => {
    await withRenderers(async () => {
      await renderSubtitle('只有文字没有时间轴\n\n第二块也没有');
      const empty = container.querySelector('.pp-viewer-empty')?.textContent ?? '';
      expect(empty).toContain('未解析到时间轴块');
      expect(empty).toContain('2 块无法解析');
      expect(container.querySelector('.pp-viewer-sub-table')).toBeNull();
    });
  });

  it('空文件 ⇒ 明说「字幕为空」，不留空白盒', async () => {
    await withRenderers(async () => {
      await renderSubtitle('');
      expect(container.querySelector('.pp-viewer-empty')?.textContent).toContain('字幕为空');
      expect(container.querySelector('.pp-viewer-sub-table')).toBeNull();
    });
  });

  it('读口响应不是 JSON ⇒ 可读错误（带前 120 字符），不 JSON 兜底', async () => {
    vi.mocked(typedRpc).mockResolvedValue('<html>not json</html>');
    await withRenderers(async () => {
      const Comp = resolveAssetBlock('file', 'media')!;
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(Comp, { block: mediaBlock({ filePath: 'D:/a.srt', ext: 'srt', label: 'a.srt' }) }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      const line = container.querySelector('.pp-media-loading')?.textContent ?? '';
      expect(line).toContain('无法解析为 JSON');
      expect(line).toContain('<html>not json</html>');
    });
  });
});
