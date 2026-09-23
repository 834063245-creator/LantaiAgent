// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// mermaid-block — B6 用例（渲染面补全 P2，2026-09-23）。**优先真解析**：mermaid@12 在 jsdom 下
// 能真跑，唯一缺口 = `SVGElement.getBBox`（mermaid 量文字用，jsdom 不实现），本文件补一个量尺桩
// ——生产 WebView2 原生有，不是产品缺陷；token 注入**真 tokens.css**（jsdom 的 getComputedStyle
// 解 stylesheet 里的自定义属性），故「主题跟随纸面墨阶」是对真源取值对账，不是自证。
// 覆盖（编号即下文体）：
//   ① 合法 flowchart 真出 svg（回落体退场、不留临时渲染节点） ② 主题 = 墨阶真值（无 base 默认亮彩）
//   ③ 语法错误 → 一行「图渲染失败：<真报错>」+ 回落体、不出图  ④ 第二图族（序列图）同样真出图
//   ⑤ 空 code →「代码块为空」+ 回落（同一降级路，不另立空态） ⑥ 源码超长 → 当场回落
//   ⑦ 墨阶 token 不可读 → 不出图（宁可回落也不出默认配色）    ⑧ 渲染中出回落体（不空白、不占位行）
//   ⑨ 同码重挂走缓存同步出图（不撞 DOM id）                   ⑩ 懒分片装载失败 → 同款降级
//   ⑪ 分片判据（源码面：mermaid 只有动态 import）             ⑫ 入口 chunk 不含 mermaid 运行时（dist 在场才查）
//   ⑬ mermaid-block.css 零裸色值 / 注释只用块注释
// **唯一 mock 的一层 = ⑩**（`vi.doMock('mermaid', 工厂抛错)` 模拟「分片拉不到」——动态 import 被拒
// 这条在 jsdom 里没法自然发生，且只影响该用例新起的模块实例）；其余全走真模块真解析。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import MermaidBlock from '../src/app/paper/mermaid-block';

const TOKENS_CSS = resolve(__dirname, '../src/app/tokens.css');
const VIEWER_CSS = resolve(__dirname, '../src/app/paper/mermaid-block.css');
const VIEWER_TSX = resolve(__dirname, '../src/app/paper/mermaid-block.tsx');
const DIST_HTML = resolve(__dirname, '../dist/index.html');
const TOKEN_STYLE_ID = 'pp-test-tokens';

/** 纸面 token 现读（与组件同一条路：stylesheet → computed）。 */
function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 用例里的纸面 token 样式（beforeAll 注入；⑦ 的 token 缺失用例临时摘除）。 */
function tokensStyle(): HTMLStyleElement {
  const existing = document.getElementById(TOKEN_STYLE_ID);
  if (existing !== null) return existing as HTMLStyleElement;
  const made = document.createElement('style');
  made.id = TOKEN_STYLE_ID;
  made.textContent = readFileSync(TOKENS_CSS, 'utf8');
  document.head.appendChild(made);
  return made;
}

/** 回落体桩：与父层传入的形状同源（原代码块）。 */
function fallbackOf(code: string): ReactNode {
  return <pre className="pp-md-code">{code}</pre>;
}

const mounted: Array<{ el: HTMLDivElement; root: Root }> = [];

/** 挂载一块（每次新容器——同屏多块 / 重挂都要能测）。 */
async function renderBlock(code: string, Comp = MermaidBlock): Promise<HTMLDivElement> {
  const el = document.createElement('div');
  el.style.setProperty('--pp-type-mono-size', '12.5px'); // 模拟 injectPaperTokens 的 .pp-root inline 注入
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push({ el, root });
  await act(async () => {
    root.render(createElement(Comp, { code, fallback: fallbackOf(code) }));
  });
  return el;
}

/** 等状态落地（轮询到点即回；超时**带现场**报错，不静默空等）。 */
async function waitState(el: HTMLElement, state: 'ok' | 'fail' | 'pending', ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (el.querySelector(`.pp-mermaid[data-mermaid-state="${state}"]`) === null) {
    if (Date.now() - t0 > ms) {
      const now = el.querySelector('.pp-mermaid')?.getAttribute('data-mermaid-state');
      throw new Error(`等 mermaid 状态「${state}」超时（当前：${now ?? '未挂载'}）`);
    }
    await act(async () => {
      await new Promise((done) => setTimeout(done, 25));
    });
  }
}

const stateOf = (el: HTMLElement): string | null =>
  el.querySelector('.pp-mermaid')?.getAttribute('data-mermaid-state') ?? null;
const errorLineOf = (el: HTMLElement): string => el.querySelector('.pp-mermaid-error')?.textContent ?? '';
const figureHtmlOf = (el: HTMLElement): string => el.querySelector('.pp-mermaid-figure')?.innerHTML ?? '';

beforeAll(async () => {
  const proto = globalThis.SVGElement?.prototype as { getBBox?: () => unknown } | undefined;
  if (proto && typeof proto.getBBox !== 'function') {
    proto.getBBox = () => ({ x: 0, y: 0, width: 120, height: 24 }); // jsdom 缺的量尺（生产原生有）
  }
  tokensStyle();
  expect(tokenValue('--ink-1'), 'tokens.css 没解析出 --ink-1 = 用例环境失灵（不是产品 bug），主题对账无意义').not.toBe(
    '',
  );
  await import('mermaid'); // 懒分片预热：真解析的第一笔开销落在 beforeAll，不进用例计时
}, 120_000);

beforeEach(() => {
  tokensStyle(); // ⑦ 摘过样式就补回（用例之间互不污染）
});

afterEach(async () => {
  while (mounted.length > 0) {
    const m = mounted.pop();
    if (!m) break;
    await act(async () => {
      m.root.unmount();
    });
    m.el.remove();
  }
});

describe('mermaid-block · 真解析（B6）', () => {
  it('① 合法 flowchart → 真解析出 svg（state=ok，回落体退场，不留临时渲染节点）', async () => {
    const el = await renderBlock('flowchart TD\n  A[起点] --> B{判定}\n  B -->|是| C[终点]');
    await waitState(el, 'ok');
    expect(el.querySelector('.pp-mermaid-figure svg')).not.toBeNull();
    expect(figureHtmlOf(el)).toContain('起点'); // 真解析的证据：标签进了图
    expect(el.querySelector('.pp-mermaid-error')).toBeNull();
    expect(el.querySelector('.pp-mermaid-fallback')).toBeNull();
    expect(document.querySelector('body > div[id^="dpp-mermaid"]')).toBeNull();
  }, 30_000);

  it('② 主题取纸面墨阶：svg 取色 = tokens.css 真值，且无 mermaid 默认配色', async () => {
    const el = await renderBlock('flowchart LR\n  X[甲] --> Y[乙]');
    await waitState(el, 'ok');
    // jsdom 的 computed 值会把空格挤掉（rgba(38,34,28,0.94)）——两侧同法挤压后逐字对账
    const squeeze = (s: string): string => s.replace(/\s+/g, '');
    const html = squeeze(figureHtmlOf(el));
    const ink1 = squeeze(tokenValue('--ink-1'));
    expect(ink1).toBe('rgba(38,34,28,0.94)'); // 真源读数（不是本文件自造的值）
    expect(html).toContain(ink1); // 字色 = 正文墨
    expect(html).toContain(squeeze(tokenValue('--paper-deep'))); // 节点底 = 深纸
    // base 主题的默认亮彩一律不该出现（出现 = 主题没接管）
    expect(html).not.toMatch(/#ececff|#ffffde/i);
  }, 30_000);

  it('③ 语法错误 → 一行「图渲染失败：<真报错原文>」+ 回落体在场、不出图、无临时节点', async () => {
    const broken = 'flowchart TD\n  A[起点] --> ';
    const el = await renderBlock(broken);
    await waitState(el, 'fail');
    const line = errorLineOf(el);
    expect(line.startsWith('图渲染失败：')).toBe(true);
    expect(line).toContain('Parse error on line 3'); // mermaid 真报错（非兜底话术）
    expect(line).not.toContain('\n'); // 多行报错收成一行
    expect(el.querySelector('.pp-mermaid-fallback')?.textContent).toContain('A[起点] -->'); // 原代码块在场
    expect(el.querySelector('.pp-mermaid-figure')).toBeNull();
    expect(document.querySelector('body > div[id^="dpp-mermaid"]')).toBeNull(); // suppressErrorRendering 生效
  }, 30_000);

  it('④ 第二图族（序列图）同样真出图——不是只认 flowchart', async () => {
    const el = await renderBlock('sequenceDiagram\n  Alice->>Bob: 你好');
    await waitState(el, 'ok');
    expect(figureHtmlOf(el)).toContain('aria-roledescription');
  }, 30_000);
});

describe('mermaid-block · 降级与护栏（B6）', () => {
  it('⑤ 空 code → 判「代码块为空」（同一降级路，不另立空态）+ 回落体，不进防抖窗', async () => {
    const el = await renderBlock('   \n  ');
    expect(stateOf(el)).toBe('fail'); // 同步出错误态（无需等防抖窗）
    expect(errorLineOf(el)).toContain('图渲染失败：代码块为空');
    expect(el.querySelector('.pp-mermaid-fallback')?.textContent).toBe('   \n  ');
  });

  it('⑥ 源码超长 → 当场回落（不让超长围栏上主线程）', async () => {
    const huge = `flowchart TD\n${'  A --> B\n'.repeat(4000)}`;
    const el = await renderBlock(huge);
    expect(stateOf(el)).toBe('fail');
    expect(errorLineOf(el)).toContain('图源码过长');
    expect(el.querySelector('.pp-mermaid-fallback')).not.toBeNull();
  });

  it('⑦ 纸面墨阶 token 不可读 → 不出图（宁可回落也不出默认配色）', async () => {
    tokensStyle().remove();
    try {
      const el = await renderBlock('flowchart LR\n  K[甲] --> L[乙]');
      await waitState(el, 'fail');
      expect(errorLineOf(el)).toContain('纸面墨阶 token 不可读');
      expect(el.querySelector('.pp-mermaid-figure')).toBeNull();
      expect(el.querySelector('.pp-mermaid-fallback')).not.toBeNull();
    } finally {
      tokensStyle(); // 补回（在 afterEach 之前，避免污染后续用例）
    }
  }, 30_000);

  it('⑧ 渲染中（防抖窗内）出回落体——不空白、不占位行；落地后换图', async () => {
    const el = await renderBlock('flowchart LR\n  P[甲] --> Q[乙]');
    expect(stateOf(el)).toBe('pending');
    expect(el.querySelector('.pp-mermaid-fallback')?.textContent).toContain('P[甲]');
    expect(el.querySelector('.pp-mermaid-error')).toBeNull();
    await waitState(el, 'ok');
    expect(el.querySelector('.pp-mermaid-fallback')).toBeNull();
  }, 30_000);

  it('⑨ 同码重挂 → 缓存命中同步出图；同码两块各持唯一 DOM id', async () => {
    const code = 'flowchart LR\n  M[壹] --> N[贰]';
    const first = await renderBlock(code);
    await waitState(first, 'ok');
    const second = await renderBlock(code);
    expect(stateOf(second)).toBe('ok'); // 无等待（防抖窗都没进）
    expect(second.querySelector('svg')).not.toBeNull();
    const ids = [...document.querySelectorAll('.pp-mermaid [id]')].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // 重贴标签：不撞 id
  }, 30_000);
});

describe('mermaid-block · 装载与分片纪律（B6）', () => {
  it('⑩ 懒分片装载失败 → 同款错误行 + 回落体（新模块实例 × 动态 mock 工厂抛错）', async () => {
    // 分片拉不到 = 动态 import 拒绝。vi.mock 的工厂结果会被缓存（翻 flag 不重跑），故这里用
    // 非提升的 vi.doMock：它在**下一次** import 生效，且只影响本用例新起的模块实例。
    vi.resetModules();
    vi.doMock('mermaid', () => {
      throw new Error('模拟分片装载失败：Failed to fetch dynamically imported module');
    });
    try {
      const fresh = (await import('../src/app/paper/mermaid-block')).default;
      const el = await renderBlock('flowchart LR\n  S[甲] --> T[乙]', fresh);
      await waitState(el, 'fail');
      const line = errorLineOf(el);
      expect(line.startsWith('图渲染失败：')).toBe(true);
      // 原因是**模块层真报错**，不是本件的兜底话术：readableError 拿不到 message 时才会退成
      // 「未知错误」。vitest 会把工厂抛错包一层 env 前缀（真机是浏览器的
      // 「Failed to fetch dynamically imported module」），故此处只钉「原因非空且非兜底」，
      // 不对 env 前缀字样下断言（那会随测试框架版本漂）。
      expect(line).not.toContain('未知错误');
      expect(line.length).toBeGreaterThan('图渲染失败：'.length + 10);
      expect(el.querySelector('.pp-mermaid-fallback')).not.toBeNull();
      expect(el.querySelector('.pp-mermaid-figure')).toBeNull();
    } finally {
      vi.doUnmock('mermaid');
      vi.resetModules();
    }
  }, 30_000);

  it('⑪ 分片判据（源码面）：mermaid 只有动态 import，无静态值依赖', () => {
    const src = readFileSync(VIEWER_TSX, 'utf8');
    const staticValueImports = [...src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+'mermaid'/gm)].map((m) => m[0]);
    expect(staticValueImports, '静态 import mermaid 会把它并进入口 chunk（必须动态 import）').toEqual([]);
    expect(src).toContain("import('mermaid')");
  });
});

// 产物面守卫：dist 在场才查（仓库先例 face-deps-seal.test.ts:71 同形）。缺席即 skip，
// 并在用例名里写明——权威断言是包级的「入口 chunk 守卫」（本批共同项），此处只是本件自查。
const distPresent = existsSync(DIST_HTML);
const d = distPresent ? describe : describe.skip;

d('mermaid-block · 入口 chunk 守卫（dist 在场；缺席时本块整体跳过——先 build）', () => {
  it('⑫ 入口 chunk 不含 mermaid 运行时（分片判据：大依赖只在懒分片）', () => {
    const html = readFileSync(DIST_HTML, 'utf8');
    // 入口 = index.html 的 script src + modulepreload（静态依赖链的两种揭示方式，都要查）
    const entryScripts = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
    expect(entryScripts.length, 'index.html 没解析出入口脚本 = 守卫失灵').toBeGreaterThan(0);
    const offenders = entryScripts.filter((rel) =>
      readFileSync(join(resolve(__dirname, '../dist'), rel), 'utf8').includes('flowchart-v2'),
    );
    expect(offenders, `入口 chunk 里出现 mermaid 运行时（分片判据破）：${offenders.join(', ')}`).toEqual([]);
  }, 30_000);
});

describe('mermaid-block · 样式纪律（B6）', () => {
  it('⑬ mermaid-block.css 零裸色值、注释只用 /* */、色全走 token', () => {
    const css = readFileSync(VIEWER_CSS, 'utf8');
    expect(css.startsWith('/*'), 'CSS 文件头必须是 /* */（// 不是 CSS 注释）').toBe(true);
    const offenders: string[] = [];
    for (const decl of css.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
      const clean = decl.trim();
      if (!/^(color|background|border|box-shadow|fill|stroke|outline)/.test(clean)) continue;
      if (/#[0-9a-fA-F]{3,8}\b/.test(clean) || /\b(rgba?|hsla?)\(/.test(clean)) offenders.push(clean);
    }
    expect(offenders, `CSS 出现裸色值（应走 token）：\n${offenders.join('\n')}`).toEqual([]);
    expect(css).toContain('var(--fail)'); // 失败色单一真源
    expect(css).toContain('var(--f-mono)');
    expect(css).toContain('var(--pp-asset-viewer-boxH)'); // 高度上限走注入 token
  });
});
