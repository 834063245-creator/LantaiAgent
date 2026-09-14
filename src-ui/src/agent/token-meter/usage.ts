// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 分桶代数 — 提供方 Usage → 四桶，以及桶上的全部读数。
//
// 归一不变式（唯一权威口径）：**billedInputTokens === usage.prompt_tokens**。
// 两家适配器的 Usage 已在上线前归一（provider/openai.ts / anthropic.ts）：
//   prompt_tokens        全部 prompt 侧输入（含缓存命中部分）
//   cache_hit_tokens     命中前缀缓存的输入
//   cache_creation_tokens 写缓存的输入（Anthropic 独有；OpenAI 兼容恒 0）
//   cache_miss_tokens    未命中缓存的输入
// 四桶按「读 → 写 → 余量为未缓存」的顺序切分（残差法），因此四桶恒为
// 非负且加总恒等于 prompt_tokens —— 不信任各家的 miss 口径是否自洽，
// 只信任总量（DSH 对「矛盾的精确分桶」的处理同样是丢掉不可信的精确值：
// turn-usage.ts normalizeUsage 对越界分桶整条拒绝，宁可回落总量）。

import type { Usage } from '../../provider/types';
import type { TokenBuckets } from './types';

export const ZERO_BUCKETS: TokenBuckets = Object.freeze({
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
});

/** 提供方 Usage → 四桶（见文件头归一不变式）。 */
export function bucketsFrom(usage: Usage): TokenBuckets {
  const prompt = Math.max(0, num(usage.prompt_tokens));
  const cacheRead = clamp(Math.max(0, num(usage.cache_hit_tokens)), prompt);
  const cacheWrite = clamp(Math.max(0, num(usage.cache_creation_tokens)), prompt - cacheRead);
  return {
    uncachedInputTokens: prompt - cacheRead - cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: Math.max(0, num(usage.completion_tokens)),
  };
}

/** prompt 侧计费输入 = 三个输入桶之和（= 提供方 prompt_tokens）。 */
export function billedInputTokens(b: TokenBuckets): number {
  return b.uncachedInputTokens + b.cacheReadTokens + b.cacheWriteTokens;
}

/** 请求压力（prompt 侧，不含输出）——「上下文占用」的分子。 */
export function pressureTokens(b: TokenBuckets): number {
  return billedInputTokens(b);
}

/** 计费总量 = 输入三桶 + 输出。 */
export function totalTokens(b: TokenBuckets): number {
  return billedInputTokens(b) + b.outputTokens;
}

export function addBuckets(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export function bucketsEqual(a: TokenBuckets, b: TokenBuckets): boolean {
  return (
    a.uncachedInputTokens === b.uncachedInputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens &&
    a.outputTokens === b.outputTokens
  );
}

/** 判定一个桶是否全零（空账本快照不落盘的依据）。 */
export function isZeroBuckets(b: TokenBuckets): boolean {
  return bucketsEqual(b, ZERO_BUCKETS);
}

/** 缓存命中率文本（如 '92.5'）；无计费输入时 null。
 *
 *  移植 DSH `formatCacheHitPercent`（client/ui-chat/chat/token-format.ts）——
 *  核心纪律：**部分命中不得四舍五入成 100%**。整数量级舍入会撞 100 时，
 *  自动加精度到能区分「几乎全中」与「全中」为止（99.5 → '99.5'，
 *  99.95 → '99.95'，全中 → '100'）。 */
export function cacheHitPercentText(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens <= 0) return null;
  const missed = promptTokens - cacheReadTokens;
  if (missed <= 0) return '100';
  const units = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000;
  if (units < fullHitUnits) return displayPercentUnits(units, decimalPlaces);
  let places = 1;
  let gap = missed * 200;
  const denominatorTens = Math.floor(promptTokens / 10);
  while (gap <= denominatorTens) {
    gap *= 10;
    places += 1;
  }
  const denominatorOnes = promptTokens % 10;
  let loss = 5;
  for (let candidate = 1; candidate < 5; candidate += 1) {
    const factor = candidate * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10);
    if (gap <= threshold) {
      loss = candidate;
      break;
    }
  }
  return `99.${'9'.repeat(places - 1)}${10 - loss}`;
}

/** 紧凑 token 数：517 / 12.2k / 517k / 1.2M（DSH formatTokens 同阈值）。 */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1_000) return String(n);
  const scaled = (v: number): string => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (n < 1_000_000) return `${scaled(n / 1_000)}k`;
  return `${scaled(n / 1_000_000)}M`;
}

/** 精确千分位（面板明细行用；不缩写）。 */
export function formatExactTokens(value: number): string {
  return Math.max(0, Math.round(value))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: 0 | 1): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10;
  const scale = unitsPerPercent * 100;
  const doubledScale = scale * 2;
  const quotient = Math.floor(denominator / doubledScale);
  const remainder = denominator % doubledScale;
  let lower = 0;
  let upper = scale;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    const threshold = factor * quotient + Math.ceil((factor * remainder) / doubledScale);
    if (cacheReadTokens >= threshold) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units);
  const whole = Math.floor(units / 10);
  const tenths = units % 10;
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clamp(v: number, max: number): number {
  return Math.max(0, Math.min(v, Math.max(0, max)));
}
