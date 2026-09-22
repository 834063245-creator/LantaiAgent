// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// token-meter 词汇表 — 兰台对 DSH `@deepseek-ai/dsh-token-meter` 的投影。
//
// 语义来源（逐条对齐 DSH，不发明新口径）：
//   - 分桶计量：输入四桶互不重叠（未缓存输入 / 缓存读 / 缓存写 / 输出），
//     DSH TokenUsageProjection 的四字段同形；
//   - 请求压力（pressure）只算 prompt 侧（输入 + 缓存读写），**不含输出**——
//     「上下文占用」问的是下一次请求的提示词有多大，不是上一次账单有多大
//     （DSH `pressureFrom` 注释原文：input plus cache traffic, no output）；
//   - 投影占用（projected）：采样后表面又长了多少 → 压力 + 表面带符号增量；
//   - 上下文构成（breakdown）：系统提示 / 工具 schema / 对话三段，**估算值**，
//     描述构成而非计费规模（DSH contextBreakdown 同判）；
//   - 每轮用量：一次用户输入 → 若干步请求，逐轮汇总（DSH deriveTurnTokenUsage）。

import type { Usage } from '../../provider/types';

/** 计费分桶 — 四个互不重叠的桶（加总 = 该次请求的计费输入 + 输出）。 */
export interface TokenBuckets {
  /** 未命中缓存的输入（按全价计费的 prompt 部分）。 */
  uncachedInputTokens: number;
  /** 命中前缀缓存的输入（读取价）。 */
  cacheReadTokens: number;
  /** 写缓存的输入（创建价；Anthropic 独有，OpenAI 兼容协议恒 0）。 */
  cacheWriteTokens: number;
  /** 输出（含思考 token）。 */
  outputTokens: number;
}

/** 上下文构成（启发式估算，三项之和 = 请求载荷估算量）。
 *  ⚡ 2026-09-22：对话段**含附图**的视觉 token（按提供方发布的像素网格计价，
 *  见 image-tokens.ts）——图是对话内容的一部分，不新开第四段（纸墨三阶，见
 *  design-spec §9.1）；细目在 EnvelopeMeasure.imageTokens / TokenRequestRecord
 *  的诊断行。 */
export interface ContextBreakdown {
  /** 系统提示（含随会话重建的 persona/规则/记忆段）。 */
  systemTokens: number;
  /** 工具 schema（每次请求全量重发的那一份）。 */
  toolsTokens: number;
  /** 对话消息（含临时提醒、工具结果与**附图视觉 token**）。 */
  messageTokens: number;
}

/** 一次请求的计量记录 — Agent 侧产出（事实面），UI 侧存档（账本面）。 */
export interface TokenRequestRecord {
  /** 第几轮（一次用户输入 = 一轮，Agent 侧计数）。 */
  turn: number;
  /** 轮内第几步（人读序，从 1 起）。 */
  step: number;
  /** 请求信封构成（发出时刻测量）。 */
  breakdown: ContextBreakdown;
  /** 载荷估算总量（= breakdown 三项之和）。 */
  surfaceTokens: number;
  /** 提供方回报的用量；错误路径（无回报）为 undefined。 */
  usage?: Usage;
  /** 记录时刻的上下文窗口（0 = 未知）。 */
  contextWindow: number;
}

/** 逐轮用量（DSH TurnTokenUsage 的兰台版：分桶 + 轮内步数 + 压力峰值）。 */
export interface TurnTokens extends TokenBuckets {
  turn: number;
  /** 本轮发出的请求数（含重试）。 */
  steps: number;
  /** 本轮 prompt 侧压力峰值（= 本轮上下文水位）。 */
  peakPressureTokens: number;
  /** 本轮计费总量（输入三桶 + 输出）。 */
  totalTokens: number;
}

/** 可序列化账本快照 — 随卷落盘 / 跨重启恢复的单元。 */
export interface TokenLedgerSnapshot {
  version: 1;
  totals: TokenBuckets;
  /** 累计请求次数（含重试与失败尝试）。 */
  attempts: number;
  turns: TurnTokens[];
  /** 最近一次采样（turn/step + 分桶）。 */
  last?: { turn: number; step: number; buckets: TokenBuckets };
  /** 最近一次提供方回报的 prompt 侧压力。 */
  pressureTokens?: number;
  /** 采样时刻的载荷估算（projected 的基准点）。 */
  sampledSurfaceTokens?: number;
  /** 当前载荷估算（每步边界刷新）。 */
  surfaceTokens: number;
  /** 最近一次请求的构成。 */
  breakdown?: ContextBreakdown;
  /** 上下文窗口（0 = 未知）。 */
  contextWindow: number;
}

/** 计量读数 — UI 消费面（单一 measure() 出口）。 */
export interface TokenMeasurement {
  /** 提供方回报的最新 prompt 侧压力；无回报时 undefined。 */
  pressureTokens?: number;
  /** 压力 + 采样后表面增量 = 下一次请求的提示词规模。 */
  projectedTokens?: number;
  /** 当前载荷估算（启发式）。 */
  surfaceTokens: number;
  /** 上下文窗口；未知时 undefined。 */
  contextWindow?: number;
  /** 占用分子：projected ?? pressure ?? surface。 */
  usedTokens?: number;
  /** 分子来源（诚实标注：provider 精确 vs 本地估算）。 */
  usedSource: 'projected' | 'pressure' | 'surface' | 'none';
  /** 占用百分比（0-100 整数）；窗口未知时 undefined。 */
  percent?: number;
  /** 上下文构成（估算）。 */
  breakdown?: ContextBreakdown;
  /** 本卷累计计费分桶。 */
  totals: TokenBuckets;
  /** 累计请求次数。 */
  attempts: number;
  /** 逐轮用量（旧 → 新）。 */
  turns: TurnTokens[];
  /** 缓存命中率文本（如 '92.5'）；无计费输入时 null。 */
  cacheHitPercent: string | null;
  /** 最近一次采样。 */
  last?: { turn: number; step: number; buckets: TokenBuckets };
}
