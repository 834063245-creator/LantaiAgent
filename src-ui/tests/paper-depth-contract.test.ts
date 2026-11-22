// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 画布海拔 · 深度契约（B5，2026-11-22）：防回潮，不测像素。
//
// 钉四件事：
//   ① 影配方唯一（--elev-shadow 只在 paper-elev.css 定义）；
//   ② 坞不接海拔（2026-11-22 用户「坞不要动」——连 --h 都不许有）；
//   ③ 样式表不许写死 --h（唯一例外 = 拿纸过冲的三帧关键帧，且与模型对拍）；
//   ④ 流内排印件不挂 pp-elev（§11「万物皆浮」判例的回归位）。
//
// 带序/全带 z 的数值对拍在 tests/paper-elevation.test.ts；本文件只管"归属"。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ELEVATION } from '../src/paper/elevation';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const SHELL = 'src/plugins/builtin/paper-shell';
const ELEV_CSS = read(SHELL + '/paper-elev.css');
const PAPER_CSS = [
  'paper-base.css',
  'paper-inline.css',
  'paper-ops.css',
  'paper-elev.css',
  'paper-toc.css',
  'draft-sheet.css',
  'paper-composer.css',
  'paper-motion.css',
  'paper-folio.css',
].map((f) => read(SHELL + '/' + f));
const ALL_CANVAS_CSS = [...PAPER_CSS, read('src/plugins/builtin/paper-minimap/minimap.css')].join('\n');
const PANEL_TSX = read(SHELL + '/PaperPanel.tsx');
const DRAFT_TSX = read(SHELL + '/DraftSheet.tsx');
const TOC_TSX = read('src/plugins/builtin/compose-dock/TocStrip.tsx');
const MINIMAP_TSX = read('src/plugins/builtin/paper-minimap/MinimapView.tsx');

describe('画布海拔契约（B5）', () => {
  it('影配方唯一：--elev-shadow 全画布只有一处定义（paper-elev.css）', () => {
    const defs = [...ALL_CANVAS_CSS.matchAll(/--elev-shadow\s*:/g)];
    expect(defs).toHaveLength(1);
    expect(ELEV_CSS).toContain('--elev-shadow:');
  });

  it('坞不接海拔：composer 无 pp-elev / --h / --elev-shadow，配方不选它', () => {
    const composer = read(SHELL + '/paper-composer.css');
    expect(composer).not.toContain('pp-elev');
    expect(composer).not.toMatch(/--h\s*:/);
    expect(composer).not.toContain('--elev-shadow');
    expect(ELEV_CSS).not.toMatch(/\.pp-composer[^{]*\{/);
    expect(PANEL_TSX).not.toContain('pp-composer pp-elev');
    expect(PANEL_TSX).not.toContain('pp-composer-slot pp-elev');
  });

  it('样式表不写死 --h（唯一例外 = 拿纸过冲三帧，且与模型同值）', () => {
    const hits = [...ALL_CANVAS_CSS.matchAll(/^\s*--h\s*:\s*([^;]+);/gm)].map((m) => m[1].trim());
    const allowed = new Set([
      String(ELEVATION.sheet.height),
      String(ELEVATION.sheet.lifted),
      String(ELEVATION.sheet.active),
    ]);
    expect(hits.every((v) => allowed.has(v))).toBe(true);
  });

  it('流内排印件不挂 pp-elev：带海拔的只有待题纸 / 纸片件 / 架件', () => {
    expect(PANEL_TSX).toContain('pp-pinned pp-elev');
    expect(PANEL_TSX).toContain('pp-strip pp-elev');
    expect(PANEL_TSX).toContain('pp-chrome pp-elev');
    expect(DRAFT_TSX).toContain('pp-elev');
    expect(TOC_TSX).toContain('pp-toc pp-elev');
    expect(MINIMAP_TSX).toContain('pp-minimap pp-elev');
    // 流块那一条 className（pp-block pp-… 且不带 pp-pinned）不许出现 pp-elev
    const flowElev = /pp-block pp-\$\{b\.kind\}(?! pp-pinned)[^\n]*pp-elev/.exec(PANEL_TSX);
    expect(flowElev).toBeNull();
  });
});
