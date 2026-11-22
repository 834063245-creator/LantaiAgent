// SPDX-License-Identifier: MIT

// 光引擎（2026-11-22）——真源 paper/light.ts + paper/light-scenes.ts 的行为考官。
//
// 用户 2026-11-22 的原话定下了这一层的目标：
//   「我要的是一个能做很多种不同光影的底层支持」
// 所以本文件不只考"某个效果好不好看"，更要考**能力边界**：
//   第 1 组：场景表是数据 —— 加一种光影只加数据，渲染代码里不许出现具体场景
//   第 2 组：三种遮光物都能做出自己的形状（窗格 / 百叶 / 树影）
//   第 3 组：影子必须比房间**更沉**（只挡直射光会做出"比房间还亮的影子"，那是假的）
//   第 4 组：两向护栏 —— 任何场景暗不破 4.5:1、亮也不破（这是"能随意加场景"的前提）
//   第 5 组：层契约与参照系（视口一套、不是每卷一盏）

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contrastFloor,
  contrastRatio,
  contrastWithGlow,
  INK_RGB,
  MIN_CONTRAST,
  occluderOpen,
  PAPER_RGB,
  relativeLuminance,
  renderScene,
  type Scene,
} from '../src/paper/light';
import { DEFAULT_SCENE, SCENE_IDS, SCENES } from '../src/paper/light-scenes';
import { readPanelCss } from './helpers/panel-css';

const SRC = join(__dirname, '..', 'src');
const VIEWPORT = { width: 1920, height: 1080 };
const scenes: Scene[] = SCENE_IDS.map((id) => SCENES[id]);

/**
 * 数亮块（run）。ignoreEdges = 跳过贴着头尾的那一段——遮光物边界上的半个格子
 * 会因为"只盖住一半"而落在阈值两侧，被误数成额外的一格。
 */
function countRuns(values: number[], threshold: number, ignoreEdges = false): number {
  let count = 0;
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    const bright = i < values.length && values[i] > threshold;
    if (bright && start < 0) start = i;
    if (!bright && start >= 0) {
      const touchesEdge = start === 0 || i === values.length;
      if (!(ignoreEdges && touchesEdge)) count++;
      start = -1;
    }
  }
  return count;
}

function rowOf(k: Float32Array, cols: number, rows: number, y: number): number[] {
  const row = Math.max(0, Math.min(rows - 1, Math.round(y * rows)));
  return Array.from({ length: cols }, (_, c) => k[row * cols + c]);
}

function columnOf(k: Float32Array, cols: number, rows: number, x: number): number[] {
  const col = Math.max(0, Math.min(cols - 1, Math.round(x * cols)));
  return Array.from({ length: rows }, (_, r) => k[r * cols + col]);
}

describe('场景表是数据：加一种光影 = 加一段数据', () => {
  it('至少五种场景，id 与键一致，字段齐全', () => {
    expect(scenes.length).toBeGreaterThanOrEqual(5);
    for (const id of SCENE_IDS) {
      const scene = SCENES[id];
      expect(scene.id).toBe(id);
      expect(scene.name.length).toBeGreaterThan(0);
      expect(scene.room.level).toBeGreaterThan(0);
      expect(scene.room.level).toBeLessThanOrEqual(1);
      expect(Array.isArray(scene.sources)).toBe(true);
    }
  });

  it('渲染代码里不出现任何具体场景 id（数据与代码分离）', () => {
    const engine = readFileSync(join(SRC, 'paper', 'light.ts'), 'utf8');
    for (const id of SCENE_IDS) {
      expect(engine).not.toContain(id);
    }
  });

  it('每个场景都能渲染出一帧合法的光（RGBA 长度 / alpha / k 范围）', () => {
    for (const scene of scenes) {
      const frame = renderScene(scene, VIEWPORT, { cols: 72 });
      expect(frame.multiply.length).toBe(frame.cols * frame.rows * 4);
      for (let i = 3; i < frame.multiply.length; i += 4) expect(frame.multiply[i]).toBe(255);
      for (const k of frame.k) {
        expect(k).toBeGreaterThanOrEqual(frame.floor - 1e-6);
        expect(k).toBeLessThanOrEqual(1 + 1e-6);
      }
      expect(frame.glow === null).toBe(!scene.glow);
    }
  });

  it('出厂场景在表里', () => {
    expect(SCENES[DEFAULT_SCENE]).toBeDefined();
  });
});

describe('三种遮光物各自成形状', () => {
  const cols = 144;

  it('窗格：横向 3 格、纵向 2 格', () => {
    const frame = renderScene(SCENES['morning-window'], VIEWPORT, { cols });
    // 上排窗格中线（避开中间横棂）与左列窗格中线（避开中间竖棂）
    const rowK = rowOf(frame.k, frame.cols, frame.rows, 0.44 - 0.8 * 0.25);
    expect(countRuns(rowK, 0.97)).toBe(3);
    const colK = columnOf(frame.k, frame.cols, frame.rows, 0.5 - 0.66 / 3);
    expect(countRuns(colK, 0.97)).toBe(2);
  });

  it('百叶：纵向 14 条', () => {
    const frame = renderScene(SCENES['afternoon-blinds'], VIEWPORT, { cols });
    const colK = columnOf(frame.k, frame.cols, frame.rows, 0.5);
    expect(countRuns(colK, 0.9, true)).toBe(14); // 忽略窗口上下边界上的半个格子
  });

  it('树影：斑驳且不成规则条纹（亮块远多于窗格/百叶的条数）', () => {
    const frame = renderScene(SCENES['dappled-tree'], VIEWPORT, { cols });
    const rowK = rowOf(frame.k, frame.cols, frame.rows, 0.46);
    expect(countRuns(rowK, 0.9)).toBeGreaterThan(6);
    const spread = Math.max(...frame.k) - Math.min(...frame.k);
    expect(spread).toBeGreaterThan(0.04);
  });

  it('阴天：没有直射光就没有形状（全片均匀）', () => {
    const frame = renderScene(SCENES.overcast, VIEWPORT, { cols });
    const spread = Math.max(...frame.k) - Math.min(...frame.k);
    expect(spread).toBeLessThan(0.01);
  });

  it('遮光物自身的几何：格心 open≈1、窗棂 open≈0、窗口外 inside=0', () => {
    const pane = SCENES['morning-window'].sources[0].occluders?.[0];
    expect(pane).toBeDefined();
    if (!pane) return;
    // 格心：横向一格的中间、纵向偏上四分之一（避开中间的横棂与竖棂）
    const paneCenter = occluderOpen(pane, 1920, 1080, 960 - (0.66 * 1920) / 3, 0.44 * 1080 - (0.8 * 1080) / 4);
    expect(paneCenter.inside).toBeGreaterThan(0.9);
    expect(paneCenter.open).toBeGreaterThan(0.95);
    // 十字窗棂交点：在覆盖范围内，但开阔度很低
    const cross = occluderOpen(pane, 1920, 1080, 960, 0.44 * 1080);
    expect(cross.inside).toBeGreaterThan(0.9);
    expect(cross.open).toBeLessThan(0.2);
    // 窗口之外：inside = 0（那里没有影子，只有房间光）
    expect(occluderOpen(pane, 1920, 1080, 40, 40).inside).toBe(0);
  });
});

describe('影子比房间更沉：shade 这一项必须在起作用', () => {
  it('窗棂上的纸比"没被阳光照到的房间"更暗（否则看起来像浅色条纹，不像影）', () => {
    const frame = renderScene(SCENES['morning-window'], VIEWPORT);
    const cornerK = frame.k[Math.round(0.02 * frame.rows) * frame.cols + Math.round(0.02 * frame.cols)] as number; // 房间
    const rowK = rowOf(frame.k, frame.cols, frame.rows, 0.44 - 0.8 * 0.25); // 上排窗格那一行
    expect(Math.max(...rowK)).toBeGreaterThan(0.98); // 格心 = 纸的本色
    expect(Math.min(...rowK)).toBeLessThan(cornerK - 0.08); // 窗棂的影比房间更沉
  });
});

describe('两向护栏：任何场景都不会把字做糊', () => {
  it('每个场景的最暗处都保住 4.5:1', () => {
    const floor = contrastFloor(PAPER_RGB, INK_RGB, MIN_CONTRAST);
    for (const scene of scenes) {
      const frame = renderScene(scene, VIEWPORT);
      const darkest = Math.min(...frame.k);
      expect(darkest).toBeGreaterThanOrEqual(floor - 1e-6);
      const scale = (rgb: readonly [number, number, number], k: number) =>
        [rgb[0] * k, rgb[1] * k, rgb[2] * k] as const;
      expect(contrastRatio(scale(PAPER_RGB, darkest), scale(INK_RGB, darkest))).toBeGreaterThanOrEqual(
        MIN_CONTRAST - 1e-6,
      );
    }
  });

  it('有 glow 的场景：加色之后最亮处仍 ≥ 4.5:1', () => {
    const nightScene = SCENES['night-lamp'];
    const frame = renderScene(nightScene, VIEWPORT);
    expect(frame.glow).not.toBeNull();
    const brightestK = Math.max(...frame.k);
    const maxGlow = Math.max(...(frame.g ?? new Float32Array([0])));
    expect(maxGlow).toBeGreaterThan(0);
    const ratio = contrastWithGlow(brightestK, maxGlow, nightScene.glow?.tint ?? [1, 1, 1]);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST - 1e-6);
    expect(frame.glowCap).toBeGreaterThan(0);
  });

  it('场景把房间压得比护栏更狠时，被抬回护栏值', () => {
    const dark: Scene = { ...SCENES['night-lamp'], room: { level: 0.1, tint: [1, 1, 1] }, glow: undefined };
    const frame = renderScene(dark, VIEWPORT);
    expect(frame.dark).toBeCloseTo(frame.floor, 6);
    expect(Math.min(...frame.k)).toBeGreaterThanOrEqual(frame.floor - 1e-6);
  });

  it('加色越多对比越低（护栏的天花板是单调的）', () => {
    const low = contrastWithGlow(1, 0.1, [1, 0.9, 0.8]);
    const high = contrastWithGlow(1, 0.9, [1, 0.9, 0.8]);
    expect(high).toBeLessThan(low);
  });
});

describe('层契约：视口一套光影，不是每张纸一盏', () => {
  const panelCss = readPanelCss();
  const dir = join(SRC, 'plugins', 'builtin', 'paper-shell');
  const layerTsx = readFileSync(join(dir, 'LightLayer.tsx'), 'utf8');
  const panelTsx = readFileSync(join(dir, 'PaperPanel.tsx'), 'utf8');

  it('.pp-light：multiply（影子）· .pp-glow：screen（发亮）· 都在浮件之下', () => {
    const lightRule = /\.pp-light \{([^}]*)\}/.exec(panelCss)?.[1] ?? '';
    const glowRule = /\.pp-glow \{([^}]*)\}/.exec(panelCss)?.[1] ?? '';
    expect(lightRule).toContain('position: fixed');
    expect(lightRule).toContain('mix-blend-mode: multiply');
    expect(glowRule).toContain('position: fixed');
    expect(glowRule).toContain('mix-blend-mode: screen');
    for (const rule of [lightRule, glowRule]) {
      expect(rule).toContain('pointer-events: none');
      expect(rule).not.toContain('position: absolute');
      const z = Number(/z-index:\s*(\d+)/.exec(rule)?.[1]);
      expect(z).toBeGreaterThan(2);
      expect(z).toBeLessThan(30);
    }
  });

  it('全画布恰好挂一次 LightLayer，且不在卷循环里', () => {
    expect((panelTsx.match(/<LightLayer/g) ?? []).length).toBe(1);
    expect(panelTsx).not.toContain('LightLayer width=');
  });

  it('量的是视口 + 只监听窗口 resize + 静态（不进 rAF）', () => {
    expect(layerTsx).toContain('window.innerWidth');
    expect(layerTsx).toContain('window.innerHeight');
    expect(layerTsx).toContain("window.addEventListener('resize', paint)");
    expect(layerTsx).toContain("window.removeEventListener('resize', paint)");
    expect(layerTsx).not.toContain('requestAnimationFrame');
    expect(layerTsx).toContain('putImageData');
  });

  it('两个通道各一张 canvas（multiply 管影子、screen 管发光）', () => {
    expect(layerTsx).toContain('pp-light');
    expect(layerTsx).toContain('pp-glow');
  });

  it('纸/墨 token 镜像没漂', () => {
    const tokens = readFileSync(join(SRC, 'app', 'tokens.css'), 'utf8');
    expect(tokens).toContain('--paper: #ece7dc');
    expect(tokens).toContain('--ink-1: rgba(38, 34, 28,');
    expect(PAPER_RGB).toEqual([236, 231, 220]);
    expect(INK_RGB).toEqual([38, 34, 28]);
    expect(relativeLuminance(PAPER_RGB)).toBeGreaterThan(relativeLuminance(INK_RGB));
  });
});
