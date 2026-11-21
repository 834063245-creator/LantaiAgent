// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 控制台的版式契约（2026-11-21 §7.2 欠账 ④⑤）：
//   ④ 窄窗双栏降级：断点必须落在**容器宽度**（设置页只占面板的一部分，窗口宽度不是
//      有效信号）——`.pp-body` 是 container-type 的落点，两个 @container 断点分别把
//      「模型双列」和「列表 + 详情双栏」降成单列；
//   ⑤ 视觉/信息结构基线：本仓没有截图基线（无 playwright/puppeteer），
//      像素级回归暂缺；这里守住**可用结构**——分区锚点有跳转留白、粘顶导航有底、
//      双列有最小宽度护栏（minmax(0, …)，长模型 id 不撑破列）。
// 说明：像素截图基线仍未做（需浏览器 harness，见 handoff §7.2 ⑤ 的剩余欠账）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONSOLE_DIR = join(__dirname, '..', '..', 'src', 'plugins', 'builtin', 'settings-domain');
/** 基座 + IA 分片（2026-11-21 起分片；层叠序 = ProviderPage 的 import 序）。 */
const CONSOLE_CSS = ['provider-console.css', 'provider-console-ia.css']
  .map((name) => readFileSync(join(CONSOLE_DIR, name), 'utf8'))
  .join('\n');

/** 取某个 @container 断点块里的规则文本（块内没有嵌套大括号，够用且不引 CSS 解析器）。 */
function containerBlock(maxWidth: number): string {
  const start = CONSOLE_CSS.indexOf(`@container (max-width: ${maxWidth}px)`);
  if (start < 0) return '';
  const open = CONSOLE_CSS.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < CONSOLE_CSS.length; i += 1) {
    if (CONSOLE_CSS[i] === '{') depth += 1;
    else if (CONSOLE_CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CONSOLE_CSS.slice(open, i + 1);
    }
  }
  return '';
}

describe('Provider 控制台版式契约', () => {
  it('版式容器是 container-type: inline-size（断点看容器，不看窗口）', () => {
    expect(CONSOLE_CSS).toMatch(/\.pp-console-body\s*\{[^}]*container-type:\s*inline-size/);
  });

  it('窄容器（≤880px）：模型「可用模型 / 参数」双列降成单列', () => {
    const block = containerBlock(880);
    expect(block).toContain('.pp-model-work');
    expect(block).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('更窄（≤720px）：「列表 + 详情」双栏降成单栏，且详情区不再套第二层滚动', () => {
    const block = containerBlock(720);
    expect(block).toContain('.pp-split');
    expect(block).toMatch(/\.pp-split\s*\{[^}]*flex-direction:\s*column/);
    expect(block).toMatch(/\.pp-console\s*\{[^}]*overflow-y:\s*visible/);
    // 粘顶导航在单栏里取消粘顶（否则会压住整页内容）
    expect(block).toMatch(/\.pp-sec-nav\s*\{[^}]*position:\s*static/);
  });

  it('分区锚点留出粘顶导航的高度（跳转不把标题滚到导航底下）', () => {
    expect(CONSOLE_CSS).toMatch(/\.pp-sec\s*\{[^}]*scroll-margin-top:\s*\d+px/);
  });

  it('模型双列用 minmax(0, …) 护栏（长模型 id 不撑破列）', () => {
    expect(CONSOLE_CSS).toMatch(
      /\.pp-model-work\s*\{[^}]*grid-template-columns:\s*minmax\(0,[^)]+\)\s+minmax\(0,[^)]+\)/,
    );
  });

  it('分区导航有粘顶与焦点环（键盘用户看得见自己在哪）', () => {
    expect(CONSOLE_CSS).toMatch(/\.pp-sec-nav\s*\{[^}]*position:\s*sticky/);
    expect(CONSOLE_CSS).toMatch(/\.pp-sec-jump:focus-visible\s*\{[^}]*outline:/);
  });
});
