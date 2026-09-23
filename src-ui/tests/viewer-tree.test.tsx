// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-tree — 结构化数据树查看器（P1 · B7 之一）：
//   ① 认领面：`VIEWER_TREE_EXTS` 六个扩展名逐个路由到 'tree'（认领表**就是**宿主层分类表）；
//   ② json：折叠树 + 类型徽记 + `[0]` 下标形态；默认展开 6 层、更深折叠且可点开；
//   ③ jsonl：**逐行独立根**——坏行单独出「第 N 行无法解析」，好行照常；
//   ④ yaml / toml / xml 三档各自解析成树（toml：基本表 + 行内数组；xml：元素 / @属性 / 文本）；
//   ⑤ toml **未支持特性不静默丢**：横幅点名 + 原文按行挂进「未支持的 TOML 特性」组；
//   ⑥ 失败面：坏 json / 坏 xml → 可读错误（解析器原话）+ 窗口内原文 mono 仍在（不空白、不 JSON 兜底）；
//   ⑦ 空输入 → 空态文案；节点数超上限 → 吸顶横幅说清只显示了多少。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { VIEWER_TREE_EXTS, viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
import { treeViewer } from '../src/plugins/builtin/renderers/viewers/tree';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/** 读口成功响应（`fs_cap read` 的文本结局：{path, content}）。 */
function readOk(content: string): string {
  return JSON.stringify({ path: 'D:/a.json', content });
}

/** 注册本查看器（出厂表收录后自动跳过——注册行事后再并进 `viewers/index.ts`）。 */
function ensureTreeRegistered(): () => void {
  if (viewerRegistry.get('tree')) return () => {};
  return viewerRegistry.register(treeViewer);
}

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  const disposeTree = ensureTreeRegistered();
  try {
    await fn();
  } finally {
    disposeTree();
    await f3.dispose();
    await f2.dispose();
    await f1.dispose();
  }
}

function mediaBlock(payload: unknown): SourcedBlock {
  return {
    ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
  };
}

interface Row {
  key: string;
  kind: string;
  value: string;
}

describe('结构化数据树查看器（B7）', () => {
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

  /** 当前渲染出的行（文档序；折叠掉的子树不在其中）。 */
  function rows(): Row[] {
    return [...container.querySelectorAll('.pp-viewer-tree-row')].map((row) => ({
      key: row.querySelector('.pp-viewer-tree-key')?.textContent ?? '',
      kind: row.querySelector('.pp-viewer-tree-kind')?.textContent ?? '',
      value: row.querySelector('.pp-viewer-tree-value')?.textContent ?? '',
    }));
  }

  function byKey(key: string): Row | undefined {
    return rows().find((row) => row.key === key);
  }

  function note(): string {
    return container.querySelector('.pp-viewer-note')?.textContent ?? '';
  }

  it('认领面：exts 就是宿主层分类表，六个扩展名逐个路由到 tree', async () => {
    await withRenderers(() => {
      expect(treeViewer.id).toBe('tree');
      expect(treeViewer.exts).toBe(VIEWER_TREE_EXTS);
      expect(treeViewer.bytesKind).toBe('text');
      expect(treeViewer.readLines).toBe(4000);
      expect(treeViewer.maxBytes).toBe(2 * 1024 * 1024);
      for (const ext of ['json', 'jsonl', 'yaml', 'yml', 'toml', 'xml']) {
        expect(VIEWER_TREE_EXTS, ext).toContain(ext);
        expect(viewerClassOf(ext), ext).toBe('tree');
        expect(viewerRegistry.resolve(ext)?.id, ext).toBe('tree');
      }
    });
  });

  it('json：折叠树（键名 + 类型徽记 + 值预览）+ 数组下标 [0] + 行窗口 limit = 4001', async () => {
    const body = JSON.stringify({ name: '兰台', n: 42, ok: true, none: null, tags: ['a', 'b'], nested: { deep: 1 } });
    vi.mocked(typedRpc).mockResolvedValue(readOk(body));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.json', ext: 'json', label: 'a.json' });
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read',
        file_path: 'D:/a.json',
        limit: 4001,
        is_agent: false,
      });
      expect(rows().map((r) => r.key)).toEqual([
        '$',
        'name',
        'n',
        'ok',
        'none',
        'tags',
        '[0]',
        '[1]',
        'nested',
        'deep',
      ]);
      expect(byKey('$')).toEqual({ key: '$', kind: 'object', value: '{ 6 项 }' });
      expect(byKey('tags')?.value).toBe('[ 2 项 ]');
      expect(byKey('[0]')?.value).toBe('"a"');
      expect(byKey('name')?.value).toBe('"兰台"');
      const kinds = new Set(rows().map((r) => r.kind));
      for (const kind of ['object', 'array', 'string', 'number', 'boolean', 'null']) {
        expect(kinds.has(kind), `缺类型徽记 ${kind}`).toBe(true);
      }
      expect(container.querySelector('.pp-viewer-note')).toBeNull(); // 未截断 → 无横幅
    });
  });

  it('默认展开 6 层、更深折叠；点一下折叠节点即展开（可交互）', async () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 8; i++) deep = { [`L${8 - i}`]: deep };
    vi.mocked(typedRpc).mockResolvedValue(readOk(JSON.stringify(deep)));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/deep.json', ext: 'json', label: 'deep.json' });
      const open = (): number => container.querySelectorAll('.pp-viewer-tree-toggle[aria-expanded="true"]').length;
      const closed = (): Element[] => [...container.querySelectorAll('.pp-viewer-tree-toggle[aria-expanded="false"]')];
      expect(open()).toBe(6); // 深度 0..5
      expect(closed().length).toBe(1); // 第 7 层（L3）折叠
      const before = rows().length;
      await act(async () => {
        (closed()[0] as HTMLButtonElement).click();
      });
      expect(open()).toBe(7);
      expect(rows().length).toBeGreaterThan(before); // 展开后多出 L2 行
      expect(byKey('L2')).not.toBeUndefined();
    });
  });

  it('jsonl：逐行独立根——坏行单独标出「第 N 行无法解析」，好行照常', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('{"a":1}\n{不是 JSON}\n{"b":[1,2]}\n'));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.jsonl', ext: 'jsonl', label: 'a.jsonl' });
      expect(rows().map((r) => r.key)).toEqual(['第 1 行', 'a', '第 2 行', '第 3 行', 'b', '[0]', '[1]']);
      expect(byKey('a')?.value).toBe('1');
      expect(byKey('第 3 行')?.value).toBe('{ 1 项 }');
      const err = container.querySelector('.pp-viewer-tree-error')?.textContent ?? '';
      expect(err).toContain('第 2 行无法解析');
      expect(container.textContent).toContain('{不是 JSON}'); // 坏行原文保留（不静默丢）
      expect(note()).toContain('1 行无法解析');
    });
  });

  it('yaml：解析成树（嵌套映射 / 序列 / 布尔）', async () => {
    const body = 'name: 兰台\nitems:\n  - id: 1\n    tag: a\n  - id: 2\n    tag: b\nenabled: true\n';
    vi.mocked(typedRpc).mockResolvedValue(readOk(body));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.yaml', ext: 'yaml', label: 'a.yaml' });
      expect(rows().map((r) => r.key)).toEqual([
        '$',
        'name',
        'items',
        '[0]',
        'id',
        'tag',
        '[1]',
        'id',
        'tag',
        'enabled',
      ]);
      expect(byKey('name')?.value).toBe('"兰台"');
      expect(byKey('id')?.value).toBe('1');
      expect(byKey('enabled')?.kind).toBe('boolean');
      expect(container.querySelector('.pp-viewer-tree-raw')).toBeNull();
    });
  });

  it('toml：基本表 + 行内数组 + [a.b] 表头，值型别正确', async () => {
    const body = [
      'title = "demo"',
      'count = 3',
      'ok = true',
      'tags = ["a", "b"]',
      '',
      '[server]',
      'host = "localhost"',
      'port = 8080',
      '',
      '[server.tls]',
      'on = false',
      '',
    ].join('\n');
    vi.mocked(typedRpc).mockResolvedValue(readOk(body));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.toml', ext: 'toml', label: 'a.toml' });
      expect(rows().map((r) => r.key)).toEqual([
        '$',
        'title',
        'count',
        'ok',
        'tags',
        '[0]',
        '[1]',
        'server',
        'host',
        'port',
        'tls',
        'on',
      ]);
      expect(byKey('title')?.value).toBe('"demo"');
      expect(byKey('count')?.kind).toBe('number');
      expect(byKey('ok')?.kind).toBe('boolean');
      expect(byKey('[1]')?.value).toBe('"b"');
      expect(byKey('server')?.kind).toBe('object');
      expect(byKey('port')?.value).toBe('8080');
      expect(byKey('tls')?.kind).toBe('object');
      expect(byKey('on')?.value).toBe('false');
      expect(container.querySelector('.pp-viewer-note')).toBeNull(); // 全解析 → 无横幅
    });
  });

  it('toml 未支持特性：横幅点名 + 原行挂进「未支持的 TOML 特性」组（不静默丢内容）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('a = 1\n[[arr]]\nx = 1\nwhen = 1979-05-27T07:32:00Z\n'));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.toml', ext: 'toml', label: 'a.toml' });
      expect(note()).toContain('未支持的 TOML 特性 3 处');
      expect(byKey('a')?.value).toBe('1'); // 支持的部分照常进树
      expect(byKey('未支持的 TOML 特性')?.kind).toBe('error');
      const errs = [...container.querySelectorAll('.pp-viewer-tree-error')].map((el) => el.textContent ?? '');
      expect(errs.join('\n')).toContain('数组表');
      expect(errs.join('\n')).toContain('日期时间');
      expect(errs.join('\n')).toContain('归属无法确定'); // 未支持表头之后不把键静默塞进上一张表
      const text = container.textContent ?? '';
      expect(text).toContain('[[arr]]'); // 原行保留（不静默丢）
      expect(text).toContain('1979-05-27T07:32:00Z');
      expect(byKey('x')).toBeUndefined(); // 未支持行的键不进树（它挂在未支持组里）
    });
  });

  it('xml：元素 / @属性 / 文本进树', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('<note id="1" lang="zh"><to>兰台</to><body>hi</body></note>'));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.xml', ext: 'xml', label: 'a.xml' });
      expect(rows().map((r) => r.key)).toEqual(['note', '@id', '@lang', 'to', 'body']);
      expect(byKey('note')?.kind).toBe('object');
      expect(byKey('@id')?.value).toBe('"1"');
      expect(byKey('@lang')?.kind).toBe('string');
      expect(byKey('to')?.value).toBe('"兰台"');
      expect(byKey('body')?.kind).toBe('string');
    });
  });

  it('坏 json → 可读错误（解析器原话）+ 窗口内原文 mono 仍在（不空白、不 JSON 兜底）', async () => {
    const body = '{ "a": 1, }';
    vi.mocked(typedRpc).mockResolvedValue(readOk(body));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/bad.json', ext: 'json', label: 'bad.json' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('JSON 解析失败');
      expect(err).toMatch(/position|token|Expected|Unexpected/i); // 带位置信息的解析器原话
      expect(container.querySelector('.pp-viewer-tree-raw')?.textContent).toBe(body);
      expect(container.querySelector('.pp-viewer-tree-row')).toBeNull(); // 不出半截树
    });
  });

  it('坏 xml → parsererror 折成可读错误 + 原文仍在', async () => {
    const body = '<a><b></a>';
    vi.mocked(typedRpc).mockResolvedValue(readOk(body));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/bad.xml', ext: 'xml', label: 'bad.xml' });
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('XML 解析失败');
      expect(container.querySelector('.pp-viewer-tree-raw')?.textContent).toBe(body);
    });
  });

  it('空输入 → 空态文案（不空白、不炸）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(''));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/empty.json', ext: 'json', label: 'empty.json' });
      expect(container.querySelector('.pp-viewer-empty')?.textContent).toContain('文件为空');
      expect(container.querySelector('.pp-viewer-tree')).toBeNull();
      expect(container.querySelector('.pp-media-file')).toBeNull(); // 不退化成文件壳
    });
  });

  it('节点数超上限 → 吸顶横幅说清只显示了多少（截断不静默）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(JSON.stringify({ items: Array.from({ length: 2100 }, (_, i) => i) })));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/big.json', ext: 'json', label: 'big.json' });
      expect(note()).toContain('只显示前 2000 个节点');
      expect(note()).toContain('共 2102 个');
      expect(rows().length).toBeLessThanOrEqual(2000);
    });
  });
});
