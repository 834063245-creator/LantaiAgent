// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 架阁的可达性与清单口径（v66 收尾批，2026-11-21 实机两条反馈）：
//
// ① 「架阁只在首页了吗」——浮层搬到 App 根（全局）之后，纸壳那枚字件被我一起删了，
//    于是纸开着时反而没有门。判据：**两处按钮 + 一条命令**各自在场。
// ② 「软件级插件里怎么还有书脊和案卷」——它们 frame:'self'（家具），生命周期挂在纸上，
//    列进架阁 = 让用户在没有工作区的首页把它点开，出来一条空侧栏（状态 bug 不只是观感）。

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('架阁入口三处（v66）', () => {
  it('纸壳顶部浮件有架阁字件（纸开着时的门）', () => {
    const paper = read('plugins/builtin/paper-shell/PaperPanel.tsx');
    expect(paper, '纸壳没有架阁按钮——纸开着时开不出架阁').toContain('useShelfStore.getState().openShelf()');
  });

  it('案卷首页顶栏有架阁字件（纸关着时的门）', () => {
    const home = read('plugins/builtin/sessions-home/SessionsHome.tsx');
    expect(home, '首页没有架阁按钮').toContain('useShelfStore.getState().openShelf()');
  });

  it('命令 shelf/open 在册（键盘/斜杠在任意界面状态可达）', () => {
    const idx = read('plugins/builtin/shelf-domain/index.tsx');
    expect(idx).toContain("id: 'shelf/open'");
    expect(idx).toContain("slash: '/shelf'");
    expect(idx).toContain('useShelfStore.getState().openShelf()');
  });
});

describe('架阁软件页的口径（v66）', () => {
  it("家具（frame:'self'）不进架阁", () => {
    const shelf = read('plugins/builtin/shelf-domain/ShelfOverlay.tsx');
    expect(shelf, '架阁清单缺 frame !== self 过滤——书脊/案卷会混进软件页').toContain("d.frame !== 'self'");
  });

  it("书脊与案卷确实声明了 frame:'self'（过滤的前提在册）", () => {
    const nav = read('plugins/builtin/canvas-nav/index.ts');
    expect([...nav.matchAll(/frame: 'self'/g)].length, '书脊 + 案卷各一条').toBe(2);
  });
});
