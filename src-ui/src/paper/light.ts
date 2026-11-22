// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 光引擎（2026-11-22）：**不是某一个效果，是能做很多种光影的底层**。
//
// 三层结构，缺一层就会退化成"只能调一个旋钮"：
//   ① 光源（source）：太阳（平行光）/ 灯（点光带平方反比）
//   ② 遮光物（occluder）：窗格 / 百叶 / 树影斑驳 —— 光影的**形状**全在这里
//   ③ 房间（room）：没被直射光找到的地方有多亮、偏冷偏暖
// 一个"光影"= 这三层的一组数据（见 light-scenes.ts）。加一种新光影 = 加一段数据，
// 不改渲染代码。
//
// 遮光物挡两样东西（缺一样就假）：
//   · 直射光（pass）——窗棂挡住太阳 → 亮格与暗棂的分界
//   · 环境光（shade）——窗棂也挡住天光 → 影子比"没被太阳照到"更沉
//   只算前者的话，窗棂的"影子"比房间还亮，看起来像纸上的浅色条纹，不像影。
//
// 两个通道（物理事实，不是可选风格）：
//   · multiply：光在纸上照出**影子**（减色，只能变暗）→ 白天靠它
//   · screen：光本身**发亮**（加色，可以把纸提亮到超过本色）→ 夜里/灯下靠它
//   每个场景自己声明要不要发亮（glow），缺省不发 → 白天场景不会把纸洗白。
//
// 护栏（两向）：
//   · multiply 有下限：暗到跌破 4.5:1 就不许再暗（二分法解）
//   · screen 有上限：亮到跌破 4.5:1 就不许再亮（二分法解）
//   所以任何新场景都不可能把字做糊——这是"能随意加光影"的前提。
//
// 参照系：视口（2026-11-22 用户定）。一层画满窗口，纸在它下面滑过去。

/** sRGB 三通道，0..255 */
export type Rgb = readonly [number, number, number];
/** 乘数形态的三通道，0..1 */
export type Tint = readonly [number, number, number];

/** 归一化矩形（相对视口） */
export interface Area {
  /** 中心 x（0..1） */
  x: number;
  /** 中心 y（0..1） */
  y: number;
  /** 宽（0..1） */
  width: number;
  /** 高（0..1） */
  height: number;
}

/** 遮光物共有的字段 */
interface OccluderBase {
  area: Area;
  /** 边缘柔化 px */
  softness: number;
  /** 直射光透过率（0 = 全遮，1 = 全透） */
  pass: number;
  /** 环境光被挡掉多少（0 = 不挡，0.2 = 影子比房间暗两成）。影子之所以"沉"是这一项 */
  shade?: number;
}

/**
 * 遮光物：决定光影的**形状**。三种够用绝大多数场景，加新的只需在这里加一支 union。
 */
export type Occluder =
  /** 窗格：横竖窗棂切出的格子（晨光、午后、月窗都用它） */
  | (OccluderBase & {
      kind: 'pane';
      /** 横向格数 */
      columns: number;
      /** 纵向格数 */
      rows: number;
      /** 斜射剪切（0 = 正射） */
      skew: number;
    })
  /** 百叶：横向条带（午后斜窗、书房百叶） */
  | (OccluderBase & {
      kind: 'slats';
      /** 条数 */
      count: number;
      skew: number;
    })
  /** 树影：噪声斑驳（庭院、树荫） */
  | (OccluderBase & {
      kind: 'dapple';
      /** 斑块尺度（相对短边） */
      scale: number;
      /** 种子（同种子 = 同树影） */
      seed: number;
    });

/** 光源 */
export interface Source {
  kind: 'sun' | 'spot';
  /** 强度 0..1（1 = 直射处把纸照到本色） */
  strength: number;
  /** 光的颜色（乘数，0..1；偏暖 = 蓝通道小） */
  tint: Tint;
  occluders?: Occluder[];
  /** spot 专用：灯位（视口归一化）与灯高（视口高倍数） */
  x?: number;
  y?: number;
  height?: number;
  /** spot 专用：光束半角（度） */
  spread?: number;
}

/** 一个场景 = 一种光影 */
export interface Scene {
  id: string;
  name: string;
  /** 房间：没被直射光找到的地方 */
  room: { level: number; tint: Tint };
  sources: Source[];
  /** 加色通道（灯/月光才需要；白天场景缺省不发亮） */
  glow?: { level: number; tint: Tint };
  /** 护栏（缺省 4.5:1） */
  guard?: { minContrast?: number };
}

/** 渲染好的一帧光 */
export interface LightFrame {
  cols: number;
  rows: number;
  /** multiply 通道（RGBA）：光在纸上的影子 */
  multiply: Uint8ClampedArray;
  /** screen 通道（RGBA）；场景没有 glow 时为 null */
  glow: Uint8ClampedArray | null;
  /** 亮度系数（0..1，诊断与测试用） */
  k: Float32Array;
  /** 加色强度（0..1，诊断与测试用）；无 glow 时为 null */
  g: Float32Array | null;
  /** 实际采用的最暗系数（护栏抬过则更大） */
  dark: number;
  /** 护栏下限 */
  floor: number;
  /** 护栏上限（加色通道的最大允许强度） */
  glowCap: number;
}

/** 纸色（= tokens.css --paper #ece7dc；canvas 不吃 CSS var，字面量在此单点） */
export const PAPER_RGB: Rgb = [236, 231, 220];
/** 墨色（= tokens.css --ink-1 基色） */
export const INK_RGB: Rgb = [38, 34, 28];
/** 墨/纸对比硬下限（WCAG AA 正文线） */
export const MIN_CONTRAST = 4.5;
/** 场分辨率（列数；行按视口长宽比推） */
export const FIELD_COLS = 144;

/** WCAG 相对亮度 */
export function relativeLuminance(rgb: Rgb): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** 两色对比度（1..21） */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 整张纸乘 k 之后的对比度 */
function contrastAtScale(k: number, paper: Rgb, ink: Rgb): number {
  const scale = (rgb: Rgb): Rgb => [rgb[0] * k, rgb[1] * k, rgb[2] * k];
  return contrastRatio(scale(paper), scale(ink));
}

/**
 * multiply 通道的下限：保住 minRatio 的**最小**亮度系数。
 * 二分 40 步；原色都不达标返回 1（一点暗都不许加）。
 */
export function contrastFloor(paper: Rgb = PAPER_RGB, ink: Rgb = INK_RGB, minRatio: number = MIN_CONTRAST): number {
  const target = Math.min(minRatio, contrastRatio(paper, ink));
  if (contrastAtScale(1, paper, ink) < target) return 1;
  if (contrastAtScale(0, paper, ink) >= target) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (contrastAtScale(mid, paper, ink) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** CSS screen 混合（逐通道） */
function screenChannel(a: number, b: number): number {
  return 1 - (1 - a) * (1 - b);
}

/** 加色之后的纸/墨对比（tint 为 0..1 颜色，level 为强度 0..1） */
export function contrastWithGlow(
  k: number,
  level: number,
  tint: Tint,
  paper: Rgb = PAPER_RGB,
  ink: Rgb = INK_RGB,
): number {
  const blend = (rgb: Rgb): Rgb => [
    255 * screenChannel((rgb[0] / 255) * k, tint[0] * level),
    255 * screenChannel((rgb[1] / 255) * k, tint[1] * level),
    255 * screenChannel((rgb[2] / 255) * k, tint[2] * level),
  ];
  return contrastRatio(blend(paper), blend(ink));
}

/**
 * screen 通道的上限：在**最亮的那一点**加光加到对比跌破 minRatio 之前，
 * 最多还能加多少（0..1）。加色会同时抬纸和墨，但纸抬得多 → 对比下降，
 * 所以这个上限是硬约束，不是审美。
 */
export function glowCeiling(
  paper: Rgb = PAPER_RGB,
  ink: Rgb = INK_RGB,
  kAtBrightest = 1,
  tint: Tint = [1, 1, 1],
  minRatio: number = MIN_CONTRAST,
): number {
  const target = Math.min(minRatio, contrastRatio(paper, ink));
  const ok = (level: number): boolean => contrastWithGlow(kAtBrightest, level, tint, paper, ink) >= target;
  if (!ok(0)) return 0;
  if (ok(1)) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/* ── 形状工具 ── */

function clamp01(v: number): number {
  return v < 0 ? 0 : Math.min(v, 1);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(fx, fy);
    fx *= 2.03;
    fy *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

/**
 * 遮光物在某点的几何：inside = 是否落在遮光物覆盖范围内（0..1），
 * open = 开阔度（1 = 格心 / 条隙 / 叶隙，0 = 正压在遮光体上）。
 *
 * 两个都要：直射光按 open 被挡；环境光的"影子变沉"只能发生在 **inside 内**——
 * 窗口以外的房间没有影子，若把 shade 也乘到那儿，整间屋子会被均匀压暗（实测 bug）。
 */
export function occluderOpen(
  occluder: Occluder,
  width: number,
  height: number,
  x: number,
  y: number,
): { inside: number; open: number } {
  const soft = Math.max(0.5, occluder.softness);
  const cx = occluder.area.x * width;
  const cy = occluder.area.y * height;
  const w = Math.max(1, occluder.area.width * width);
  const h = Math.max(1, occluder.area.height * height);
  const skew = 'skew' in occluder ? occluder.skew : 0;
  const sx = x - (y - cy) * skew;
  const dx = sx - cx;
  const dy = y - cy;
  const across = smoothstep(-soft, soft, w / 2 - Math.abs(dx));
  const down = smoothstep(-soft, soft, h / 2 - Math.abs(dy));
  const inside = across * down;

  if (occluder.kind === 'pane') {
    const paneW = w / Math.max(1, occluder.columns);
    const paneH = h / Math.max(1, occluder.rows);
    const bar = Math.min(16, Math.max(4, 0.04 * Math.min(paneW, paneH)));
    const between = (offset: number, cell: number): number => {
      const t = offset / cell;
      return smoothstep(bar - soft, bar + soft, Math.abs(t - Math.round(t)) * cell);
    };
    const open = between(dx + w / 2, paneW) * between(dy + h / 2, paneH);
    return { inside, open };
  }

  if (occluder.kind === 'slats') {
    const pitch = h / Math.max(1, occluder.count);
    const phase = (((dy + h / 2) % pitch) + pitch) % pitch;
    const edge = Math.min(phase, pitch - phase);
    const thick = Math.max(0.5, (1 - clamp01(occluder.pass)) * pitch * 0.5);
    return { inside, open: smoothstep(thick - soft, thick + soft, edge) };
  }

  // dapple：噪声斑驳（叶隙）
  const scale = Math.max(2, occluder.scale * Math.min(w, h));
  const n = fbm((x + occluder.seed * 97) / scale, (y + occluder.seed * 61) / scale, 4);
  return { inside, open: smoothstep(0.42 - soft / scale, 0.62 + soft / scale, n) };
}

/** 点光在某点的衰减（灯正下方 = 1） */
export function spotFalloff(source: Source, width: number, height: number, x: number, y: number): number {
  const lx = (source.x ?? 0.5) * width;
  const ly = (source.y ?? 0) * height;
  const lz = Math.max(1, (source.height ?? 1) * height);
  const dx = x - lx;
  const dy = y - ly;
  const d = Math.max(1, Math.hypot(dx, dy, lz));
  const falloff = (lz / (d * d * d)) * lz * lz; // 灯正下方归一化到 1
  const half = Math.max(2, ((source.spread ?? 120) * Math.PI) / 360);
  const cone = smoothstep(Math.cos(half), Math.cos(half * 0.55), lz / d);
  return clamp01(falloff) * cone;
}

/** 场景 → 一帧光（multiply 通道 + 可选 screen 通道） */
export function renderScene(
  scene: Scene,
  viewport: { width: number; height: number },
  options: { cols?: number; paper?: Rgb; ink?: Rgb } = {},
): LightFrame {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const cols = Math.max(8, Math.round(options.cols ?? FIELD_COLS));
  const rows = Math.max(8, Math.round((cols * height) / width));
  const paper = options.paper ?? PAPER_RGB;
  const ink = options.ink ?? INK_RGB;
  const minContrast = scene.guard?.minContrast ?? MIN_CONTRAST;
  const floor = contrastFloor(paper, ink, minContrast);
  const roomLevel = Math.max(floor, Math.min(1, scene.room.level));

  const k = new Float32Array(cols * rows);
  const multiply = new Uint8ClampedArray(cols * rows * 4);
  const g = scene.glow ? new Float32Array(cols * rows) : null;
  const lightTint = scene.sources[0]?.tint ?? [1, 1, 1];

  let brightestK = 0;
  for (let row = 0; row < rows; row++) {
    const y = ((row + 0.5) / rows) * height;
    for (let col = 0; col < cols; col++) {
      const x = ((col + 0.5) / cols) * width;
      let radiance = 0;
      let ambientCut = 1;
      for (const source of scene.sources) {
        let pass = 1;
        for (const occluder of source.occluders ?? []) {
          const { inside, open } = occluderOpen(occluder, width, height, x, y);
          // 透过率 = 覆盖范围 × （全遮 + 让过的部分 × 开阔度）
          // 少了 inside 这个乘子，窗口以外的整片房间会被当成"格心"，太阳就照满全屏。
          pass *= inside * (clamp01(occluder.pass) + (1 - clamp01(occluder.pass)) * open);
          const shade = clamp01(occluder.shade ?? 0);
          // 影子只在遮光物覆盖范围内变沉（窗外没有影子）
          if (shade > 0) ambientCut *= 1 - shade * inside * (1 - open);
        }
        const falloff = source.kind === 'spot' ? spotFalloff(source, width, height, x, y) : 1;
        radiance += source.strength * pass * falloff;
      }
      radiance = clamp01(radiance);
      // 影子也挡环境光（ambientCut）——这是"影子比房间更沉"的那一项
      const kk = Math.max(floor, (roomLevel + (1 - roomLevel) * radiance) * ambientCut);
      const i = row * cols + col;
      k[i] = kk;
      if (kk > brightestK) brightestK = kk;

      // 色温：光强的地方落光源色，暗处落房间色
      const t = radiance;
      const rr = scene.room.tint[0] + (lightTint[0] - scene.room.tint[0]) * t;
      const gg = scene.room.tint[1] + (lightTint[1] - scene.room.tint[1]) * t;
      const bb = scene.room.tint[2] + (lightTint[2] - scene.room.tint[2]) * t;
      const o = i * 4;
      multiply[o] = 255 * Math.min(1, kk * rr);
      multiply[o + 1] = 255 * Math.min(1, kk * gg);
      multiply[o + 2] = 255 * Math.min(1, kk * bb);
      multiply[o + 3] = 255;

      if (g) g[i] = scene.glow ? scene.glow.level * radiance : 0;
    }
  }

  const glowTint = scene.glow?.tint ?? [1, 1, 1];
  const glowCap = scene.glow ? glowCeiling(paper, ink, brightestK, glowTint, minContrast) : 0;
  let glow: Uint8ClampedArray | null = null;
  if (g) {
    const scale = Math.min(1, glowCap);
    glow = new Uint8ClampedArray(cols * rows * 4);
    for (let i = 0; i < g.length; i++) {
      const level = clamp01(g[i]) * scale;
      const o = i * 4;
      glow[o] = 255 * Math.min(1, level * glowTint[0]);
      glow[o + 1] = 255 * Math.min(1, level * glowTint[1]);
      glow[o + 2] = 255 * Math.min(1, level * glowTint[2]);
      glow[o + 3] = 255;
      g[i] = level;
    }
  }

  return { cols, rows, multiply, glow, k, g, dark: roomLevel, floor, glowCap };
}
