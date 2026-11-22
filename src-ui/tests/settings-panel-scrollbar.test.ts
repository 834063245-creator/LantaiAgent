// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置面板内容滚动条守卫（2026-11-22，用户报「插件页是不是应该有个滚动条」）。
// 病灶：插件页内容高 6800px+，旧条只有 4px 宽且拇指用 --line-soft（≈16% alpha），
// 实际渲染几乎不可见——页面读作被裁断，也没有可抓的滚动目标。
// jsdom 无布局引擎，故同 settings-panel-field-grid.test.ts 先例钉源码形；
// 真机像素走 WebView2/Chromium 验证。

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS_PATH = join(__dirname, '..', 'src', 'plugins', 'builtin', 'settings-domain', 'settings-panel.css');
const CSS = readFileSync(CSS_PATH, 'utf8');

/** 规则面（选择器 → 规则体）：去注释后逐条取块——本 CSS 无嵌套规则。 */
function rules(): Array<{ selector: string; body: string }> {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

function ruleBody(selector: string): string {
  return rules().find((r) => r.selector === selector)?.body ?? '';
}

describe('设置面板内容滚动条', () => {
  it('.sp-content 是滚动容器：含边界、预留书口、可纵向滚动', () => {
    const body = ruleBody('.sp-content');
    expect(body).toMatch(/overflow-y:\s*auto\s*;/);
    expect(body).toMatch(/overscroll-behavior:\s*contain\s*;/);
    expect(body).toMatch(/scrollbar-gutter:\s*stable\s*;/);
  });

  it('滚动条可见：12px 墨杆槽 + 弱规线轨道 + hover/active 加深', () => {
    const bar = ruleBody('.sp-content::-webkit-scrollbar');
    const width = Number(bar.match(/width:\s*(\d+)px/)?.[1]);
    expect(width, '旧案 4px 在 6800px 长表上不可见；槽宽至少 8px').toBeGreaterThanOrEqual(8);

    const track = ruleBody('.sp-content::-webkit-scrollbar-track');
    expect(track, '轨道不能透明——要留一根纸面书口规线').toContain('var(--line-soft)');
    expect(track).toContain('linear-gradient');

    const thumb = ruleBody('.sp-content::-webkit-scrollbar-thumb');
    expect(thumb, '拇指改用墨阶，不再用近乎透明的 --line-soft').toContain('var(--ink-3)');
    expect(thumb).toContain('background-clip: padding-box');
    expect(thumb).toContain('border: 3px solid transparent');
    expect(ruleBody('.sp-content::-webkit-scrollbar-thumb:hover')).toContain('var(--ink-2)');
    expect(ruleBody('.sp-content::-webkit-scrollbar-thumb:active')).toContain('var(--ink-1)');
  });
});
