// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 启动封面（2026-11-05 冷启动 UX 批）——用户报「启动后首页有一个瞬间毫无排版」。
// 两个真实空窗：① 产物 CSS 是运行时注入的 <link>（sessions-home 注册视图与注入样式
// 同拍，React 下一帧就画首页 ⇒ 先出一帧没有 home.css）；② MiSans/Noto Mono 都是
// font-display: swap。封面必须在 index.html 里内联（先于一切外部 CSS/字体），并在
// 揭幕前等到「首页 DOM + 样式表 + 字体」。本用例按这两条钉死，另钉淡出镜像与兜底。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const mainSrc = readFileSync(path.join(ROOT, 'src', 'main.ts'), 'utf8');
const coverSrc = readFileSync(path.join(ROOT, 'src', 'app', 'boot-cover.ts'), 'utf8');
const tauriConf = readFileSync(path.resolve(ROOT, '..', 'src-tauri', 'tauri.conf.json'), 'utf8');

describe('启动封面：首帧即纸（内联，不依赖任何外部资源）', () => {
  it('index.html 自带封面色与节点（先于外部 CSS / 字体 / JS）', () => {
    expect(html).toContain('id="boot-cover"');
    // 纸色与窗底色各出现一次：封面底 + html/body 首帧底
    expect([...html.matchAll(/#ece7dc/g)].length).toBeGreaterThanOrEqual(2);
    // 封面正文只用系统字体栈（不排 MiSans——那正是要等的字体）
    expect(html).toMatch(/#boot-cover \.bc-note \{[\s\S]*?monospace/);
    expect(html).not.toMatch(/#boot-cover \.bc-note \{[\s\S]*?MiSans/);
    expect(html).toContain('src="/favicon.png"');
  });

  it('绝对兜底：主脚本没跑到 armBootCover 就炸，封面最多留 8s（白屏事故纪律）', () => {
    expect(html).toContain('}, 8000);');
    expect(html).toContain('removeChild(cover)');
    expect(html.indexOf('removeChild(cover)')).toBeGreaterThan(html.indexOf('id="app-root"'));
  });

  it('窗口底色同批钉成纸色（HTML 之前的白帧也不许出现）', () => {
    expect(tauriConf).toContain('"backgroundColor": "#ece7dc"');
  });
});

describe('启动封面：揭幕时机（首页 DOM + 样式表 + 字体）', () => {
  it('main.ts 在首次 render 之后 arm，恢复面先揭幕', () => {
    expect(mainSrc).toContain('armBootCover()');
    expect(mainSrc.indexOf('armBootCover()')).toBeGreaterThan(mainSrc.indexOf('reactRoot.render(createElement(App))'));
    const recovery = mainSrc.slice(mainSrc.indexOf('function showRecovery'));
    expect(recovery.indexOf('dismissBootCover()')).toBeGreaterThan(-1);
    expect(recovery.indexOf('dismissBootCover()')).toBeLessThan(recovery.indexOf('reactRoot.render('));
  });

  it('三件齐才揭幕：首页带样式画出来 / 不在等旁的产品 CSS / 两套字体', () => {
    expect(coverSrc).toContain('#app-root .sh-root');
    expect(coverSrc).toContain('getComputedStyle(root).position');
    // 判据刻意不是「等全部样式表」——产物 CSS 共 11MB，paper-shell 的 4.6MB 与首页首帧无关
    expect(coverSrc).not.toContain('link[rel="stylesheet"]');
    expect(coverSrc).toContain('MiSans');
    expect(coverSrc).toContain('Noto Sans Mono CJK SC');
  });

  it('预算在册：最短停留 320ms / 字体 1200ms / 总预算 2500ms', () => {
    expect(coverSrc).toContain('MIN_MS = 320');
    expect(coverSrc).toContain('FONT_BUDGET_MS = 1_200');
    expect(coverSrc).toContain('REVEAL_BUDGET_MS = 2_500');
  });

  it('淡出时长与 index.html 的 transition 同值（跨语言镜像）', () => {
    const tsMs = /BOOT_COVER_FADE_MS = (\d+);/.exec(coverSrc);
    const cssMs = /#boot-cover\.is-out \{[\s\S]*?opacity (\d+)ms/.exec(html);
    expect(tsMs, '缺 BOOT_COVER_FADE_MS').not.toBeNull();
    expect(cssMs, '缺 #boot-cover.is-out 的淡出').not.toBeNull();
    expect(Number((tsMs as RegExpExecArray)[1])).toBe(Number((cssMs as RegExpExecArray)[1]));
  });
});

describe('dismissBootCover：幂等揭幕', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.innerHTML = '<div id="boot-cover"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('加 is-out → 淡出窗后摘节点；重复调用不叠加', async () => {
    const { dismissBootCover, BOOT_COVER_FADE_MS } = await import('../src/app/boot-cover');
    dismissBootCover();
    expect(document.getElementById('boot-cover')?.classList.contains('is-out')).toBe(true);
    dismissBootCover();
    vi.advanceTimersByTime(BOOT_COVER_FADE_MS - 1);
    expect(document.getElementById('boot-cover')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.getElementById('boot-cover')).toBeNull();
  });

  it('封面缺席 = no-op（恢复面 / 测试环境）', async () => {
    document.body.innerHTML = '';
    const { dismissBootCover } = await import('../src/app/boot-cover');
    expect(() => dismissBootCover()).not.toThrow();
  });
});
