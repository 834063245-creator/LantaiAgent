// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 架阁 · 模态法（2026-11-24 全量迭代）——设计规格 §11「模态档」的机器可读守护。
//
// 为什么要有这一条：架阁此前是唯一没有设计规格章节的主界面面，实测同时踩了
// ① 遮罩 16%（法度 38%）、② 菜单影（模态应压印）、③ z 400（在插件窗 460 之下，
// 打不开「门」）、④ 无入场动效。这四条都是**看不出来但一改就破**的判据，
// 写成断言比写在注释里可靠。改法度 = 同批改本文件与设计规格。
//
// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

const CSS = read('plugins/builtin/shelf-domain/shelf.css');
const TOKENS = read('app/tokens.css');
const OVERLAY = read('plugins/builtin/shelf-domain/ShelfOverlay.tsx');

describe('架阁 · 模态法', () => {
  it('遮罩 = --veil（模态必配 veil），入场走 --m-ink 的 veil-in', () => {
    expect(CSS).toMatch(/\.shf-veil\s*\{[^}]*background:\s*var\(--veil\)/);
    expect(CSS).toMatch(/\.shf-veil\s*\{[^}]*animation:\s*veil-in var\(--m-ink\)/);
  });

  it('框体 = 固定册页 880 × 640（最少宽度/高度双兜底），头线 + 压印族投影', () => {
    expect(CSS, '宽度没走 92vw 兜底').toMatch(/\.shf-shelf\s*\{[^}]*width:\s*min\(880px,\s*92vw\)/);
    expect(CSS, '高度没走 82vh 兜底').toMatch(/\.shf-shelf\s*\{[^}]*height:\s*min\(640px,\s*82vh\)/);
    expect(CSS, '缺头线（浮层菜单书眉顶缘）').toMatch(/\.shf-shelf\s*\{[^}]*border-top:\s*var\(--rule-head\)/);
    expect(CSS, '模态用了菜单影而不是压印族').toMatch(/\.shf-shelf\s*\{[^}]*box-shadow:\s*var\(--elev-raise\)/);
    expect(CSS).toMatch(/\.shf-shelf\s*\{[^}]*animation:\s*pop-down var\(--m-ink\)/);
  });

  it('层级：架阁 485 > 插件窗 460 / 提示 480，且 < 牒卡 500 / 命令面板 510', () => {
    expect(CSS, '架阁 z 没走 token（带 485 fallback 给旧 exe）').toMatch(
      /\.shf-veil\s*\{[^}]*z-index:\s*var\(--z-shelf-modal,\s*485\)/,
    );
    const z = (name: string, src = TOKENS): number => {
      const m = new RegExp(`--${name}:\\s*(\\d+)`).exec(src);
      expect(m, `token --${name} 不在册`).not.toBeNull();
      return Number((m as RegExpExecArray)[1]);
    };
    expect(z('z-shelf-modal')).toBe(485);
    expect(z('z-shelf-modal')).toBeGreaterThan(z('z-plugin-window'));
    expect(z('z-shelf-modal')).toBeGreaterThan(z('z-tip'));
    expect(z('z-shelf-modal')).toBeLessThan(z('z-prompt'));
    expect(z('z-shelf-modal')).toBeLessThan(z('z-palette'));
    expect(TOKENS, '旧名 --z-shelf 仍在（那枚 token 是牒卡的，名不副实）').not.toMatch(/--z-shelf:\s*\d/);
  });

  it('交互原语：焦点圈定 / 外点关闭 / Esc 都走全库同一份实现', () => {
    expect(OVERLAY, '缺焦点圈定').toContain('mountDialogFocus');
    expect(OVERLAY, '缺外点关闭原语').toContain('useOutsideClose');
    expect(OVERLAY, '缺 Esc 原语').toContain('useDialogEscape');
    expect(OVERLAY, '自写 document keydown 关浮层').not.toMatch(/document\.addEventListener\(\s*'keydown'/);
  });

  it('类名分家：产物不再用旧前缀（旧壳 bundle 里那批规则已编译，删不掉只能换名）', () => {
    expect(CSS, 'CSS 里还有旧前缀').not.toMatch(/\.pp-shelf-/);
    expect(OVERLAY, '组件里还有旧前缀').not.toContain('pp-shelf-');
  });

  it('两页口径 = 器物 / 卡片（2026-11-24 用户拍板）', () => {
    expect(OVERLAY).toMatch(/PAGE_LABEL = \{\s*app: '器物',\s*card: '卡片'\s*\}/);
  });
});
