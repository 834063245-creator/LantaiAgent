// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 文卷窗内纯函数回归（窗内容不在 src 图里，单测直接 import 插件目录的 ESM）。

import { describe, expect, it } from 'vitest';
import {
  basename,
  countText,
  dirname,
  docKindOf,
  draftFileName,
  extractOutline,
  fuzzyScore,
  hashText,
  isDocumentName,
  isMarkdownName,
  isPluginInternalName,
  isSafeRelPath,
  languageOf,
  normalizeDocName,
  resolveLocalHref,
  splitFrontmatter,
} from '../../examples/plugins/md-editor/app/js/pure.js';

describe('文卷纯函数', () => {
  it('路径：basename/dirname 同时认 / 与 \\', () => {
    expect(basename('a/b/c.md')).toBe('c.md');
    expect(basename('C:\\x\\y.md')).toBe('y.md');
    expect(dirname('a/b/c.md')).toBe('a/b');
    expect(dirname('c.md')).toBe('');
  });

  it('相对路径围栏：拒绝回溯/盘符/反斜杠/空段', () => {
    expect(isSafeRelPath('a/b.md')).toBe(true);
    expect(isSafeRelPath('../x.md')).toBe(false);
    expect(isSafeRelPath('/x.md')).toBe(false);
    expect(isSafeRelPath('a\\b.md')).toBe(false);
    expect(isSafeRelPath('C:/x.md')).toBe(false);
    expect(isSafeRelPath('a//b.md')).toBe(false);
  });

  it('新建文档名：非法字符归一、补 .md、空名拒绝', () => {
    expect(normalizeDocName('  hello  ')).toBe('hello.md');
    expect(normalizeDocName('a/b:c*?.md')).toBe('a-b-c--.md');
    expect(normalizeDocName('   ')).toBeNull();
    expect(normalizeDocName('...')).toBeNull();
  });

  it('草稿键稳定且按路径区分', () => {
    expect(draftFileName('local', 'a.md')).toBe(draftFileName('local', 'a.md'));
    expect(draftFileName('local', 'a.md')).not.toBe(draftFileName('local', 'b.md'));
    expect(draftFileName('local', 'a.md')).not.toBe(draftFileName('host', 'a.md'));
    expect(hashText('')).toHaveLength(8);
  });

  it('frontmatter：只认首块，字段按字面', () => {
    const split = splitFrontmatter('---\ntitle: 测试\nstatus: draft\n---\n# 标题\n正文');
    expect(split.frontmatter).toBe('title: 测试\nstatus: draft');
    expect(split.fields).toEqual([
      { key: 'title', value: '测试' },
      { key: 'status', value: 'draft' },
    ]);
    expect(split.bodyLineOffset).toBe(4);
    expect(split.body.startsWith('# 标题')).toBe(true);
    expect(splitFrontmatter('# 无 frontmatter').bodyLineOffset).toBe(0);
  });

  it('大纲：ATX + Setext，跳过围栏代码块，行号对原文', () => {
    const outline = extractOutline(
      ['---', 'title: x', '---', '# 一级', '```', '## 不是标题', '```', '## 二级', '副标题', '---'].join('\n'),
    );
    expect(outline.map((item) => [item.level, item.text, item.line])).toEqual([
      [1, '一级', 4],
      [2, '二级', 8],
      [2, '副标题', 9],
    ]);
  });

  it('字数：CJK 逐字、拉丁按词', () => {
    expect(countText('中文 abc def').words).toBe(4);
    expect(countText('中文 abc def').chars).toBe(2 + 3 + 3);
    expect(countText('').lines).toBe(0);
  });

  it('相对链接：按当前文档目录解析，越界拒绝', () => {
    expect(resolveLocalHref('sub/a.md#x', 'docs/b.md')).toEqual({ external: false, path: 'docs/sub/a.md' });
    expect(resolveLocalHref('../a.md', 'docs/b.md')).toEqual({ external: false, path: 'a.md' });
    expect(resolveLocalHref('../../x.md', 'docs/b.md')).toBeNull();
    expect(resolveLocalHref('https://example.com/a', 'docs/b.md')).toEqual({
      external: true,
      href: 'https://example.com/a',
    });
    expect(resolveLocalHref('#anchor', 'docs/b.md')).toBeNull();
  });

  it('模糊匹配：子序列命中、basename 加权、无命中 -1', () => {
    expect(fuzzyScore('abc', 'a/b/c.md')).toBeGreaterThanOrEqual(0);
    expect(fuzzyScore('zzz', 'a/b/c.md')).toBe(-1);
    expect(fuzzyScore('', 'anything')).toBe(1);
    expect(fuzzyScore('文卷', 'docs/文卷.md')).toBeGreaterThan(fuzzyScore('文卷', 'docs/x文y卷.md'));
  });

  it('文档分类：Markdown / 代码 / 文本；二进制拒绝', () => {
    expect(docKindOf('a.MD')).toEqual({ kind: 'markdown', language: 'markdown' });
    expect(docKindOf('a.ts')).toEqual({ kind: 'code', language: 'typescript' });
    expect(docKindOf('a.json')).toEqual({ kind: 'code', language: 'json' });
    expect(docKindOf('a.txt')).toEqual({ kind: 'text', language: 'plain' });
    expect(docKindOf('Dockerfile')).toEqual({ kind: 'code', language: 'dockerfile' });
    expect(docKindOf('README')).toEqual({ kind: 'text', language: 'plain' });
    expect(isDocumentName('a.json')).toBe(true);
    expect(isDocumentName('a.png')).toBe(false);
    expect(isDocumentName('a.bin')).toBe(false);
    expect(isMarkdownName('a.md')).toBe(true);
    expect(isMarkdownName('a.ts')).toBe(false);
    expect(languageOf('a.tsx')).toBe('tsx');
    expect(languageOf('a.rs')).toBe('rust');
    expect(isPluginInternalName('state.json')).toBe(true);
    expect(isPluginInternalName('drafts/a.md')).toBe(true);
    expect(isPluginInternalName('docs/a.json')).toBe(false);
  });
});
