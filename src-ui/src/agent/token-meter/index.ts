// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// token-meter — 兰台的 token / 上下文计量层（DSH `@deepseek-ai/dsh-token-meter`
// 语义移植：分桶用量、prompt 侧压力、投影占用、上下文构成、逐轮用量、缓存命中）。
//
// 消费面：
//   - Agent 侧：streamOnce 每请求落一条 TokenRequestRecord（构成 + 用量）；
//   - UI 侧：state/token-store.ts 持有每卷计量器 + 账本快照落盘。

export type { EnvelopeMeasure } from './estimate';
export { estimatePayloadTokens, measureEnvelope } from './estimate';
export { countImageTokens, deepSeekImageTokens } from './image-tokens';
export { SessionTokenMeter } from './meter';
export type {
  ContextBreakdown,
  TokenBuckets,
  TokenLedgerSnapshot,
  TokenMeasurement,
  TokenRequestRecord,
  TurnTokens,
} from './types';
export {
  addBuckets,
  billedInputTokens,
  bucketsEqual,
  bucketsFrom,
  cacheHitPercentText,
  formatExactTokens,
  formatTokens,
  isZeroBuckets,
  pressureTokens,
  totalTokens,
  ZERO_BUCKETS,
} from './usage';
