// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 画布海拔（物理层次）守护：docs/plans/paper-shell/canvas-depth-plan.md
//
// 两件事各钉一半：
//   ① 模型表（paper/elevation.ts）：带序不许倒挂、带内 index 不许顶穿下一带；
//   ② 画法（paper-elev.css 与两个架件）：只有一处影配方、坞不挂、消费者真的读了 --h。
// 「流内排印件无影」是 §11 判例的回归位——任何把 .pp-elev 挂到 flow 块上的改动都必须在这里红。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BAND_ORDER, bumpOrder, ELEVATION, heightOf, syncOrder, zOf } from '../src/paper/elevation';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const ELEV_CSS = read('src/plugins/builtin/paper-shell/paper-elev.css');
const TOC_CSS = read('src/plugins/builtin/paper-shell/paper-toc.css');
const MINIMAP_CSS = read('src/plugins/builtin/paper-minimap/minimap.css');
const TOC_TSX = read('src/plugins/builtin/compose-dock/TocStrip.tsx');
const MINIMAP_TSX = read('src/plugins/builtin/paper-minimap/MinimapView.tsx');
const BASE_CSS = read('src/plugins/builtin/paper-shell/paper-base.css');
const PANEL_TSX = read('src/plugins/builtin/paper-shell/PaperPanel.tsx');
const DRAFT_TSX = read('src/plugins/builtin/paper-shell/DraftSheet.tsx');
const COMPOSER_CSS = read('src/plugins/builtin/paper-shell/paper-composer.css');
const PIN_CSS = read('src/plugins/builtin/paper-shell/paper-inline.css');
const OPS_CSS = read('src/plugins/builtin/paper-shell/paper-ops.css');
const MOTION_CSS = read('src/plugins/builtin/paper-shell/paper-motion.css');

/** 取某个选择器的声明块（首个匹配；够用：本文件里这些选择器各只出现一次成块）。 */
function ruleBody(css: string, sel: string): string {
  const i = css.indexOf(sel);
  if (i < 0) return '';
  const s = css.indexOf('{', i);
  const e = css.indexOf('}', s);
  return s < 0 || e < 0 ? '' : css.slice(s + 1, e);
}

describe('海拔表（paper/elevation.ts）', () => {
  it('带序严格递增，且带内 900 个位置不顶穿下一带', () => {
    for (let i = 0; i < BAND_ORDER.length; i++) {
      const band = ELEVATION[BAND_ORDER[i]];
      const next = BAND_ORDER[i + 1] ? ELEVATION[BAND_ORDER[i + 1]] : null;
      if (next) expect(next.z).toBeGreaterThan(band.z);
      // zOf 的最大档（899）必须仍在下一带之前
      if (next) expect(zOf(BAND_ORDER[i], 899)).toBeLessThan(next.z);
    }
  });

  it('高度不许为负，拿起档不许低于静置', () => {
    for (const id of BAND_ORDER) {
      const band = ELEVATION[id];
      expect(band.height).toBeGreaterThanOrEqual(0);
      expect(band.lifted).toBeGreaterThanOrEqual(band.height);
      expect(heightOf(id, true)).toBeGreaterThanOrEqual(heightOf(id, false));
    }
  });

  it('zOf：带底 + index，越界夹回（不把一张纸顶进别的带）', () => {
    expect(zOf('sheet')).toBe(ELEVATION.sheet.z);
    expect(zOf('sheet', 3)).toBe(ELEVATION.sheet.z + 3);
    expect(zOf('sheet', -5)).toBe(ELEVATION.sheet.z);
    expect(zOf('sheet', 10000)).toBe(ELEVATION.sheet.z + 899);
    expect(zOf('sheet', Number.NaN)).toBe(ELEVATION.sheet.z);
  });

  it('坞是"纸上的墨"：影配方不接它（2026-11-22 用户：坞不要动）', () => {
    expect(ELEV_CSS).not.toMatch(/\.pp-composer[^{]*\{/);
    expect(ELEV_CSS).not.toContain('--elev-dock');
  });
});

describe('影配方（paper-elev.css）', () => {
  it('只有一条配方，读 --h 与 --light-*（换灯 = 换四个数，不换规则）', () => {
    expect(ELEV_CSS).toContain('.pp-elev {');
    expect(ELEV_CSS).toContain('--elev-shadow:');
    expect(ELEV_CSS).toContain('var(--h, 0)');
    expect(ELEV_CSS).toContain('var(--light-dx');
    expect(ELEV_CSS).toContain('var(--light-dy');
    expect(ELEV_CSS).toContain('var(--light-soft');
    // 两层：贴地接触线 + 方向影（一层做不出「接触处最暗」）
    expect(ELEV_CSS).toContain('0 1px 0 rgba(38, 34, 28, 0.16)');
  });

  it('灯是固定设计常量（现制无场景系统）：--light-* 有一处缺省值', () => {
    expect(ELEV_CSS).toMatch(/--light-dx: 0\.62/);
    expect(ELEV_CSS).toMatch(/--light-dy: 0\.95/);
    expect(ELEV_CSS).toMatch(/--light-soft: 1/);
  });

  it('全带 z 一次归位（P3b，Q2-B）：环境 / 纸片件 / 覆盖层 / 架件 / 坞', () => {
    expect(ruleBody(BASE_CSS, '.pp-root::after {')).toContain('z-index: 3000');
    expect(ruleBody(PIN_CSS, '.pp-block.pp-pinned {')).toContain('z-index: 1000');
    expect(ruleBody(OPS_CSS, '.pp-strip {')).toContain('z-index: 1001');
    expect(ruleBody(OPS_CSS, '.pp-ink-layer {')).toContain('z-index: 998');
    expect(ruleBody(MOTION_CSS, '.pp-tether-layer {')).toContain('z-index: 3050');
    expect(ruleBody(OPS_CSS, '.pp-sel-ink {')).toContain('z-index: 3051');
    expect(ruleBody(OPS_CSS, '.pp-lift-mask {')).toContain('z-index: 3052');
    expect(ruleBody(TOC_CSS, '.pp-toc {')).toContain('z-index: 3100');
    expect(ruleBody(BASE_CSS, '.pp-chrome {')).toContain('z-index: 3101');
    expect(ruleBody(MINIMAP_CSS, '.pp-minimap {')).toContain('z-index: 3102');
    expect(ruleBody(COMPOSER_CSS, '.pp-composer-slot {')).toContain('z-index: 3200');
  });

  it('纸与待题纸的 z 不再写死在 CSS：内联 sheetZ / 纸带顶', () => {
    expect(ruleBody(BASE_CSS, '.pp-region {')).not.toContain('z-index');
    expect(ELEV_CSS).not.toContain('z-index');
    expect(PANEL_TSX).toContain('zIndex: sheetZ(r.sessionId)');
    expect(DRAFT_TSX).toContain("zIndex: zOf('sheet', 899)");
  });

  it('拿起次序：raise 移到队尾、同步保留既有序并追加新张（引用稳定）', () => {
    const base = ['1', '2'];
    expect(bumpOrder(base, '1')).toEqual(['2', '1']);
    expect(bumpOrder(base, '2')).toBe(base);
    expect(syncOrder(['1', '2'], ['2', '3'])).toEqual(['2', '3']);
    expect(syncOrder(base, ['1', '2'])).toBe(base);
  });
});

describe('纸与待题纸（B1，2026-11-22）', () => {
  it('纸的三档高度来自模型：静置/活跃/拖带都在 PaperPanel 读 ELEVATION', () => {
    expect(PANEL_TSX).toContain("'--h':");
    expect(PANEL_TSX).toContain('ELEVATION.sheet.height');
    expect(PANEL_TSX).toContain('ELEVATION.sheet.active');
    expect(PANEL_TSX).toContain('ELEVATION.sheet.lifted');
    expect(BASE_CSS).toContain('var(--elev-shadow)');
  });

  it('纸片件与顶浮件的高度也来自模型（5 / 12）', () => {
    expect(PANEL_TSX).toContain('ELEVATION.piece.height');
    expect(PANEL_TSX).toContain('ELEVATION.piece.lifted');
    expect(PANEL_TSX).toContain('ELEVATION.furniture.height');
    expect(PANEL_TSX).toContain('pp-chrome pp-elev');
    expect(BASE_CSS).toContain('var(--elev-shadow, var(--elev-raise))');
  });

  it('待题纸就是一张纸：pp-elev + --h = sheet.height（"新"靠 z 顶，不靠高度）', () => {
    expect(DRAFT_TSX).toContain('pp-elev');
    expect(DRAFT_TSX).toContain("'--h': ELEVATION.sheet.height");
  });

  it('拿纸过冲只动 --h，三帧与模型同源（@property 注册过）', () => {
    expect(ELEV_CSS).toContain('@property --h');
    const take = /@keyframes pp-region-take \{([\s\S]*?)\n\}/.exec(BASE_CSS)?.[1] ?? '';
    expect(take).toContain(`--h: ${ELEVATION.sheet.height}`);
    expect(take).toContain(`--h: ${ELEVATION.sheet.lifted}`);
    expect(take).toContain(`--h: ${ELEVATION.sheet.active}`);
    expect(take).not.toContain('box-shadow');
  });
});

describe('架件（目次带 + 小地图）', () => {
  it('目次带：pp-elev + 影落到纸上；--h 来自模型（不写死）', () => {
    expect(TOC_TSX).toContain('pp-toc pp-elev');
    expect(TOC_TSX).toContain("'--h': ELEVATION.furniture.height");
    expect(TOC_CSS).toContain('var(--elev-shadow');
  });

  it('小地图：pp-elev + 影落到纸上；--h 来自模型（不写死）', () => {
    expect(MINIMAP_TSX).toContain('pp-minimap pp-elev');
    expect(MINIMAP_TSX).toContain("'--h': ELEVATION.furniture.height");
    expect(MINIMAP_CSS).toContain('var(--elev-shadow');
  });
});
