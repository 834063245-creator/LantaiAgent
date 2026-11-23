// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// @vitest-environment jsdom

// 文卷预览渲染契约：标题锚点行号、GFM 任务列表、HTML 消毒。
// vendor 是预构建 ESM（CodeMirror + markdown-it + DOMPurify），这里只测
// renderMarkdown 的对外行为——内核细节不重复测。

import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../examples/plugins/md-editor/app/vendor/lantai-editor.js';

describe('文卷预览渲染', () => {
  it('frontmatter 剥掉后，标题锚点仍按原文行号', () => {
    const html = renderMarkdown('# 一级\n\n正文\n', 3);
    expect(html).toContain('id="md-h-4"');
    expect(html).toContain('data-line="4"');
    expect(html).toContain('>一级</h1>');
  });

  it('GFM 任务列表与表格', () => {
    const html = renderMarkdown('- [ ] 待办\n- [x] 已办\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<table>');
  });

  it('原始 HTML 中的脚本被消毒', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n# 安全\n');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('安全');
  });

  it('相对图片不伪装成可加载资源', () => {
    const html = renderMarkdown('![图](images/a.png)\n');
    expect(html).toContain('md-img-missing');
    expect(html).not.toContain('<img');
  });
});
