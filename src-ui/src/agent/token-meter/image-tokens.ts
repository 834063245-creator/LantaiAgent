// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DeepSeek 视觉 token 记账 — 提供方**发布**的图片 token 计算器，逐字移植自
// DSH `packages/llm/llm-deepseek/src/common/image-tokens.ts`（DSH 自陈
// 「ported verbatim in its current `v41` configuration」，源 api-docs.deepseek.com
// 的 Token & Token Usage）。口径纪律「沿 DSH token-meter，禁漂移」在这里的落点：
// 常数、投影次序、封顶解都照抄，不自己调参。
//
// 算法（发布版）：总像素低于 544×544 的图先放大 → 对齐 14px patch 网格 →
// 每轴 3:1 降采样成 token 单元（单元 42px）→ 单图**封顶 1024 token**（按保比
// 求解最大的在预算内网格）；计数 = 行数 ×(列数+1) + 2（每行带一个分隔符 + 两颗框定 token）。
//
// 为什么兰台需要它（2026-09-22 补账）：在此之前构成测量只走文本分词器，**图完全
// 不计**——有图时本地估算系统性小于提供方回报（实测会话 20：四桶估算 20,457 vs
// `api_reported.prompt` 22,404），于是「占用」读数与压缩压力判定在有图时都少算。
//
// 口径边界（如实记）：
//   - 这是**估算**，提供方回报始终是权威（DSH 同判："Actual usage remains authoritative"）；
//   - 兰台报价用 ref 声明的宽高，而 DSH 报价用**发出尺寸**（它自己做请求投影）。
//     差异只在被 wire 规整降过采样的图上，且方向恒为「估高」——两张都可能已过
//     1024 封顶，实际误差通常为 0（见 tests/image-token-pricing.test.ts 的边界用例）；
//   - 换非 DeepSeek 血统的路由时，网格系数未必成立（DSH 的做法是路由侧注入
//     `LlmImageRequestPricing`；兰台 provider 面是薄适配器，暂不引入该注册表——
//     诊断日志的 `api_delta` 就是这条边界的探针：差额持续非零即说明口径该换了）。

import type { ChatImageRef, Message } from '../../provider/types';

/** 视觉 patch 边长（px）。 */
const PATCH_SIZE = 14;
/** 每轴 patch → token 的降采样比。 */
const DOWNSAMPLE_RATIO = 3;
/** 提供方对**单张**请求图的 token 封顶。 */
const MAX_IMAGE_TOKENS = 1024;
/** 总像素下限；更小的图先放大再投影。 */
const MIN_PIXELS = 544 * 544;
/** 一个 token 单元覆盖的像素数（两轴同值）。 */
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO;

const intDiv = (value: number, divisor: number): number => Math.floor(value / divisor);
const ceilDiv = (value: number, divisor: number): number => Math.floor((value + divisor - 1) / divisor);

interface GridResize {
  readonly gridHeight: number;
  readonly gridWidth: number;
  readonly bestHeight: number;
  readonly bestWidth: number;
  readonly numTokens: number;
}

/** 一个网格的 token 数：每行带一个分隔符，另加两颗框定 token。 */
function gridTokens(gridHeight: number, gridWidth: number): number {
  return gridHeight * (gridWidth + 1) + 2;
}

/** 单轴 padding 后的像素长度 → token 单元数。 */
function gridCells(paddedLength: number): number {
  return ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO);
}

/** 在 `budget` token 内解出保比的最大网格（发布版解法的闭式）。 */
function solveResizeRatio(height: number, width: number, budget: number): GridResize {
  const aspect = height / width;
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5;
  const idealGridHeight = idealGridWidth * aspect;
  let bestHeight: number;
  let bestWidth: number;
  if (idealGridWidth < 1) {
    const solvedGridWidth = 1;
    const solvedGridHeight = intDiv(budget - 2, solvedGridWidth + 1);
    bestWidth = solvedGridWidth * CELL_SIZE;
    bestHeight = solvedGridHeight * CELL_SIZE;
  } else if (idealGridHeight < 1) {
    const solvedGridHeight = 1;
    const solvedGridWidth = intDiv(budget - 2, solvedGridHeight) - 1;
    bestWidth = solvedGridWidth * CELL_SIZE;
    bestHeight = solvedGridHeight * CELL_SIZE;
  } else {
    const solvedGridWidth = Math.trunc(idealGridWidth);
    const solvedGridHeight = Math.trunc(idealGridHeight);
    const scale = Math.min((solvedGridWidth * CELL_SIZE) / width, (solvedGridHeight * CELL_SIZE) / height);
    bestWidth = Math.trunc((width * scale) / PATCH_SIZE) * PATCH_SIZE;
    bestHeight = Math.trunc((height * scale) / PATCH_SIZE) * PATCH_SIZE;
  }
  const gridHeight = gridCells(bestHeight);
  const gridWidth = gridCells(bestWidth);
  return { gridHeight, gridWidth, bestHeight, bestWidth, numTokens: gridTokens(gridHeight, gridWidth) };
}

/** padding 后像素投影到预算内最大 token 网格。 */
function safeResize(height: number, width: number, paddedHeight: number, paddedWidth: number): GridResize {
  const gridHeight = gridCells(paddedHeight);
  const gridWidth = gridCells(paddedWidth);
  const direct: GridResize = {
    gridHeight,
    gridWidth,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridHeight, gridWidth),
  };
  if (direct.numTokens <= MAX_IMAGE_TOKENS) return direct;
  const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS);
  if (solved.numTokens > MAX_IMAGE_TOKENS) {
    throw new Error(`deepseek image tokens: no grid fits the token budget for ${width}x${height}`);
  }
  return solved;
}

/** 一次「放大 → padding → 投影」；调用方迭代到不动点。 */
function resizeOnce(width: number, height: number): GridResize {
  let scaledWidth = width;
  let scaledHeight = height;
  const pixels = scaledWidth * scaledHeight;
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels);
    scaledWidth = Math.trunc(scaledWidth * scale);
    scaledHeight = Math.trunc(scaledHeight * scale);
  }
  const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE;
  const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE;
  return safeResize(scaledHeight, scaledWidth, paddedHeight, paddedWidth);
}

function sameResize(a: GridResize, b: GridResize): boolean {
  return (
    a.gridHeight === b.gridHeight &&
    a.gridWidth === b.gridWidth &&
    a.bestHeight === b.bestHeight &&
    a.bestWidth === b.bestWidth &&
    a.numTokens === b.numTokens
  );
}

/**
 * 一张请求图的视觉 token 价（提供方发布算法）。
 * @param width 正整数像素宽
 * @param height 正整数像素高
 * @returns 单图视觉 token 数，**至多 1024**
 */
export function deepSeekImageTokens(width: number, height: number): number {
  let result = resizeOnce(width, height);
  for (let iteration = 1; iteration < 10; iteration += 1) {
    const next = resizeOnce(result.bestWidth, result.bestHeight);
    if (sameResize(next, result)) return result.numTokens;
    result = next;
  }
  // 发布版解法的非收敛护栏：每趟都是投影，第二趟同形即不动点。
  throw new Error(`deepseek image tokens: resize did not converge for ${width}x${height}`);
}

/** 载荷里可携带附图的角色（契约 v40：user + tool；真源同 request-images.carriedImages）。 */
function carriedImages(m: Message): readonly ChatImageRef[] | undefined {
  return m.role === 'user' || m.role === 'tool' ? m.images : undefined;
}

/**
 * 一组消息里附图的视觉 token 合计与张数（按**出现次数**计价，与 DSH
 * "prices every retained surface occurrence" 同判）。
 * @param messages 要计价的载荷消息
 * @param price 单图定价（缺省 = 提供方发布算法；换非 DeepSeek 路由时由此注入）
 */
export function countImageTokens(
  messages: readonly Message[],
  price: (width: number, height: number) => number = deepSeekImageTokens,
): { tokens: number; images: number } {
  let tokens = 0;
  let images = 0;
  for (const m of messages) {
    for (const ref of carriedImages(m) ?? []) {
      tokens += price(ref.width, ref.height);
      images += 1;
    }
  }
  return { tokens, images };
}
