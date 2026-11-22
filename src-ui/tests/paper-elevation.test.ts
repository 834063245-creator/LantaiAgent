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
import { BAND_ORDER, ELEVATION, heightOf, zOf } from '../src/paper/elevation';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const ELEV_CSS = read('src/plugins/builtin/paper-shell/paper-elev.css');
const TOC_CSS = read('src/plugins/builtin/paper-shell/paper-toc.css');
const MINIMAP_CSS = read('src/plugins/builtin/paper-minimap/minimap.css');
const TOC_TSX = read('src/plugins/builtin/compose-dock/TocStrip.tsx');
const MINIMAP_TSX = read('src/plugins/builtin/paper-minimap/MinimapView.tsx');

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

  it('P3a：活跃纸浮到纸带顶——只取 0/1 两档，不动其它层', () => {
    expect(ELEV_CSS).toMatch(/\.pp-region \{\s*z-index: 0;/);
    expect(ELEV_CSS).toMatch(/\.pp-region-active \{\s*z-index: 1;/);
    // 本文件只有这两条 z（窗光/钉块/家具/坞/小地图的 z 是 P3b 全带重排的事）
    expect((ELEV_CSS.match(/z-index:/g) ?? []).length).toBe(2);
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
