// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 压缩**成本策略面**（批 6d-1 收缩；2026-09-24）——用可度量的数学替代硬编码的魔法数字。
// 记账/状态面（`CompactionTracker` 与三个账类型 + 费率常量）已切到 `./compaction-tracker`；
// 本文件只剩策略：经济参数 · 最优保留/触发点 · 自动调优 · 报告 · 压缩工具面。
//
// 决策变量（默认值见 agent.ts；2026-09 迭代对齐 DSH 经济模型）：
//   r = compactRatio  (0.8) — 触发阈值，占 contextWindow 的比例
//   k = recentKeep    (消息数下限，默认 4) — 尾部保留的完整消息数下限
//   retainRatio (0.16) — 尾部保留的 token 预算，占 contextWindow 的比例；
//       computeCompactRegionImpl 从尾部往回累计 token 到 ≥ retainRatio×窗口
//       （同时至少 recentKeep 条完整消息 + 完整回合边界）。
//
// 模型：
//   NetBenefit = |R|·c_in·(T-1) - |S|·c_out - L·avg_turn_cost

import { z } from 'zod';
import type { CompactionSessionStats, CompactionTracker } from './compaction-tracker';
import { DEFAULT_C_IN, DEFAULT_C_OUT, LOSS_FACTOR_PER_EVENT } from './compaction-tracker';
import type { Tool } from './tool';
import { defineTool } from './tools/define-tool';

// ── 压缩经济参数（2026-09 迭代真源；消费方 agent.ts / agent-compaction.ts）──

/** 尾部保留的 token 预算，占 contextWindow 的比例（对齐 DSH retainRatio 0.16）。
 *  computeCompactRegionImpl 从尾部往回累计 token 到 ≥ 此比例×窗口，
 *  再钳制到完整回合边界 — 工具密集会话里保证模型手里有足够近期工作现场，
 *  而不是旧实现 max(4, recentKeep) 那样只留几条消息。 */
export const DEFAULT_RETAIN_RATIO = 0.16;

/** 正常触发水位（占 contextWindow 比例；agent.ts 构造缺省同源）。 */
export const DEFAULT_COMPACT_RATIO = 0.8;

// ── 压缩成本模型 ──

export interface CompactionParams {
  regionTokens: number; // |R|
  summaryTokens: number; // |S|
  turnsRemaining: number; // T
  extraTurnsFromLoss: number; // L
  avgTurnCost: number; // avg_turn_cost（美元）
  cIn?: number; // 默认 $3
  cOut?: number; // 默认 $15
}

/** 计算单次压缩的净收益。
 *  正值 = 压缩省钱。负值 = 成本大于节省。 */
export function netBenefit(p: CompactionParams): number {
  const cIn = p.cIn ?? DEFAULT_C_IN;
  const cOut = p.cOut ?? DEFAULT_C_OUT;

  const savedTokens = p.regionTokens * (p.turnsRemaining - 1);
  const savedCost = (savedTokens * cIn) / 1_000_000;

  const summaryCost = (p.regionTokens * cIn + p.summaryTokens * cOut) / 1_000_000;

  const lossCost = p.extraTurnsFromLoss * p.avgTurnCost;

  return savedCost - summaryCost - lossCost;
}

/** 盈亏平衡轮次：压缩回本需要多少剩余轮次。
 *  忽略信息丢失（L=0）。如果摘要大于区域则返回 Infinity。 */
export function breakevenTurns(p: CompactionParams): number {
  const cIn = p.cIn ?? DEFAULT_C_IN;
  const cOut = p.cOut ?? DEFAULT_C_OUT;

  if (p.regionTokens <= 0) return Infinity;

  // 求解: |R|·c_in·(T-1) - |S|·c_out - L·avg = 0 中的 T
  // → T = 1 + (|S|·c_out + L·avg) / (|R|·c_in)
  const numerator = p.summaryTokens * cOut + p.extraTurnsFromLoss * p.avgTurnCost * 1_000_000;
  const denominator = p.regionTokens * cIn;

  return 1 + numerator / denominator;
}

// ── 最优 recentKeep 估算器 ──

/** 估算保留 k 条尾部消息的信息丢失。
 *  ponytail: 指数衰减模型 — 离当前轮次越远的消息
 *  相关性几何级递减。保留更多消息能减少丢失
 *  但增加每轮 token 成本。
 *
 *  loss(k) = base_loss * exp(-λ * k)
 *    其中 λ 控制相关性衰减速度（越大 = 衰减越快）
 *
 *  默认 λ ≈ 0.3 意味着每条消息的相关性约为前一条的 74%。
 */
export function estimateLoss(k: number, totalRegionMsgs: number, lambda = 0.3): number {
  // 尾部省略的每条消息都有一定概率后续需要。
  // 越早的消息被需要的概率越低。
  let cumulativeLoss = 0;
  for (let i = 0; i < totalRegionMsgs - k; i++) {
    // 距当前轮次 i 步的消息相关性
    cumulativeLoss += Math.exp(-lambda * (i + k));
  }
  // 缩放: 最大丢失约为每 50 条丢失消息 1 个额外轮次
  return cumulativeLoss * 0.02;
}

/** 保留 k 条尾部消息的预期每轮成本。
 *  avgMsgTokens = 每条消息的平均 token 数。 */
export function tailCost(k: number, avgMsgTokens: number, cIn?: number): number {
  const c = cIn ?? DEFAULT_C_IN;
  return (k * avgMsgTokens * c) / 1_000_000;
}

/** 找到使总成本最小的最优 k（recentKeep）。
 *  总成本 = 尾部存储成本 (k·|m̄|·c_in) + 预期丢失成本。 */
export function optimalRecentKeep(
  totalRegionMsgs: number,
  avgMsgTokens: number,
  avgTurnCost: number,
  lambda = 0.3,
  cIn?: number,
): { k: number; cost: number } {
  let bestK = 1;
  let bestCost = Infinity;

  for (let k = 1; k <= Math.min(totalRegionMsgs, 20); k++) {
    const storageCost = tailCost(k, avgMsgTokens, cIn) * 10; // 假设还有约 10 轮
    const loss = estimateLoss(k, totalRegionMsgs, lambda);
    const lossCost = loss * avgTurnCost;
    const totalCost = storageCost + lossCost;

    if (totalCost < bestCost) {
      bestCost = totalCost;
      bestK = k;
    }
  }

  return { k: bestK, cost: bestCost };
}

// ── 最优 compactRatio 估算器 ──

/** 根据预期会话长度找到最优 r（compactRatio）。
 *
 *  如果压缩太早（低 r），为较少的收益支付摘要成本，
 *  因为没有多少 token 可压缩。
 *  如果压缩太晚（高 r），压缩前每轮成本更高。
 *
 *  对于 N 条总消息的会话：
 *    - 不压缩：总成本 ∝ N²（每轮发送所有之前的消息）
 *    - 在 r 处压缩：压缩成本 + 之后线性增长
 *
 *  ponytail: 这是简化模型。真正的最优值取决于消息大小
 *  分布以及会话主要是工具密集型还是对话密集型。
 */
export function optimalCompactRatio(
  contextWindow: number,
  avgMsgTokens: number,
  expectedTurns: number,
  avgTurnCost: number,
): { r: number; estimatedSaving: number } {
  let bestR = 0.7;
  let bestSaving = 0;

  for (let r = 0.3; r <= 0.95; r += 0.05) {
    const triggerTokens = r * contextWindow;
    const triggerMsgs = Math.floor(triggerTokens / avgMsgTokens);

    if (triggerMsgs >= expectedTurns) continue; // 永不触发

    const regionTokens = triggerTokens - avgMsgTokens * 4; // 减去尾部
    const summaryTokens = regionTokens * 0.05; // ~5% 压缩比
    const turnsRemaining = expectedTurns - triggerMsgs;

    if (turnsRemaining <= 1) continue;

    const benefit = netBenefit({
      regionTokens,
      summaryTokens,
      turnsRemaining,
      extraTurnsFromLoss: 0, // 乐观估计
      avgTurnCost,
    });

    const savingsPerSession = benefit * turnsRemaining;
    if (savingsPerSession > bestSaving) {
      bestSaving = savingsPerSession;
      bestR = r;
    }
  }

  return { r: bestR, estimatedSaving: bestSaving };
}

// ── CompactionTracker — 监测 agent.ts ──

// ── 自动调优：跨会话持久化最优参数 ──

export interface CompactionConfig {
  compactRatio: number;
  recentKeep: number;
  /** 摘要调用的输出上限（token）——缺省 = SUMMARY_OUTPUT_BUDGET（8192，对齐 DSH）。
   *  手写此文件即可改；自动调优只透传，不改写它。 */
  summaryMaxTokens?: number;
  tunedAt: number; // 上次调优时间戳
  sampleCount: number; // 使用的压缩事件数量
  avgCompressionRatio: number;
  avgLossFactor: number;
  reasoning: string; // 人类可读的说明
}

const MIN_SAMPLES_FOR_TUNE = 5;

/** 从追踪器数据计算最优参数。数据不足时返回 null。
 *  ponytail: 只统计 outcome === 'summary' 的事件 — stuck/truncated
 *  是失败样本（区域 0 token），混入会污染平均区域大小和压缩比。 */
export function tuneCompactionParams(tracker: CompactionTracker, contextWindow?: number): CompactionConfig | null {
  const stats = tracker.getStats();
  const summaryEvents = stats.events.filter((e) => e.outcome === 'summary');
  if (summaryEvents.length < MIN_SAMPLES_FOR_TUNE) return null;

  // 所有 summary 事件的平均压缩比
  const avgCompressionRatio =
    summaryEvents.reduce((sum, e) => {
      if (e.regionTokensEst === 0) return sum;
      return sum + e.summaryOutputTokens / e.regionTokensEst;
    }, 0) / summaryEvents.length;

  // 平均区域大小（仅 summary 事件）
  const avgRegionMsgs = summaryEvents.reduce((sum, e) => sum + e.regionMsgCount, 0) / summaryEvents.length;
  const avgRegionTokens = summaryEvents.reduce((sum, e) => sum + e.regionTokensEst, 0) / summaryEvents.length;

  // 平均消息 token 数
  const avgMsgTokens = avgRegionMsgs > 0 ? avgRegionTokens / avgRegionMsgs : 500;

  // 从观测到的重读/重复工具计算丢失因子
  const lossFactor = tracker.estimateLossFactor();
  const avgLossPerEvent = summaryEvents.length > 0 ? lossFactor / summaryEvents.length : 0;

  // 平均轮次成本（固定费率）
  const avgTurnCost = tracker.estimateAvgTurnCost(avgRegionTokens, avgRegionTokens * 0.15);

  // 计算最优 recentKeep
  const { k: optimalK } = optimalRecentKeep(Math.round(avgRegionMsgs), avgMsgTokens, avgTurnCost, 0.3);

  // 根据预期会话长度计算最优 compactRatio — 用真实窗口而非硬编码 1M
  const win = contextWindow && contextWindow > 0 ? contextWindow : 1_000_000;
  const { r: optimalR } = optimalCompactRatio(win, avgMsgTokens, stats.totalTurns, avgTurnCost);
  // 限制到合理范围 — 对齐 0.8 默认触发线（2026-09 迭代，DSH 对照）：
  // 过早压缩把仍会反复读取的活跃中段换成摘要，在前缀缓存计价下净亏；
  // 下限 0.7 保证只在压力真的高时动手，上限 0.85 防止阈值顶到溢出区。
  const tunedR = Math.max(0.7, Math.min(0.85, optimalR));

  // 构建说明
  const parts: string[] = [];
  parts.push(
    `${summaryEvents.length}次压缩, 平均压缩比 ${(avgCompressionRatio * 100).toFixed(1)}%, 每次平均信息丢失 ${avgLossPerEvent.toFixed(2)} 轮`,
  );
  parts.push(`compactRatio: ${(optimalR * 100).toFixed(0)}% → 夹到 ${(tunedR * 100).toFixed(0)}%`);
  parts.push(`recentKeep: ${optimalK}`);

  return {
    compactRatio: tunedR,
    recentKeep: optimalK,
    tunedAt: Date.now(),
    sampleCount: summaryEvents.length,
    avgCompressionRatio,
    avgLossFactor: avgLossPerEvent,
    reasoning: parts.join(' | '),
  };
}

/** 尝试自动调优并返回推荐。由调用方决定是否应用。 */
export function maybeTune(
  tracker: CompactionTracker,
  currentR: number,
  currentK: number,
  contextWindow?: number,
): { config: CompactionConfig; changed: boolean } | null {
  const config = tuneCompactionParams(tracker, contextWindow);
  if (!config) return null;
  const changed = Math.abs(config.compactRatio - currentR) > 0.05 || config.recentKeep !== currentK;
  return { config, changed };
}

// ── 诊断报告（用于 /compact-stats 或 MCP 工具）──

export function formatCompactionReport(stats: CompactionSessionStats): string {
  const lines: string[] = [
    `# 压缩成本分析报告`,
    ``,
    `| 指标 | 值 |`,
    `|------|-----|`,
    `| 压缩次数 | ${stats.events.length} |`,
    `| 估算省 token | ${stats.estimatedTokensSaved.toLocaleString()} |`,
    `| 重读文件次数 | ${stats.reReadCount} |`,
    `| 重复工具调用 | ${stats.duplicateToolCalls} |`,
    `| 估算信息丢失轮次 | ${(stats.reReadCount + stats.duplicateToolCalls) * LOSS_FACTOR_PER_EVENT} |`,
    `| 总会话轮次 | ${stats.totalTurns} |`,
  ];

  if (stats.events.length > 0) {
    lines.push('');
    lines.push('## 各次压缩明细');
    lines.push('');
    for (let i = 0; i < stats.events.length; i++) {
      const e = stats.events[i];
      const turnsAfter = stats.turnsAfterCompaction[i] || 0;
      const compressionRatio = ((1 - e.postTokens / e.preTokens) * 100).toFixed(1);
      lines.push(`### 压缩 #${i + 1}`);
      lines.push(`- 时间: ${new Date(e.ts).toLocaleTimeString()}`);
      lines.push(`- 方式: ${e.outcome}`);
      lines.push(`- 压缩区域: ${e.regionMsgCount} 条消息, ~${e.regionTokensEst.toLocaleString()} tokens`);
      lines.push(`- 摘要大小: ~${e.summaryOutputTokens.toLocaleString()} tokens`);
      lines.push(
        `- 压缩比: ${compressionRatio}% (${e.preTokens.toLocaleString()} → ${e.postTokens.toLocaleString()} tokens)`,
      );
      lines.push(`- 压缩后继续: ${turnsAfter} 轮`);
    }
  }

  return lines.join('\n');
}

// ── Agent 工具：hologram_compaction_stats ──

/** 创建只读工具，让 agent（和用户）检查压缩健康状态。
 *  ponytail: 不做修改 — 仅格式化追踪器的当前状态。 */
export function createCompactionTools(
  getTracker: () => CompactionTracker | null,
  getCurrentParams: () => {
    compactRatio: number;
    recentKeep: number;
    retainRatio: number;
    contextWindow: number;
    summaryMaxTokens: number;
  },
  loadConfig: () => Promise<CompactionConfig | null>,
): Tool[] {
  return [
    defineTool({
      name: 'hologram_compaction_stats',
      description:
        '查看上下文压缩的运行状态和数据。包括：已记录的压缩次数、压缩比、信息丢失估计、自动调优状态、当前参数 vs 推荐参数。' +
        '用户问"压缩调得怎么样"或"压缩数据够不够"时调用。',
      schema: z.object({}),
      readOnly: true,
      execute: async () => {
        const tracker = getTracker();
        const current = getCurrentParams();
        const persisted = await loadConfig();

        const stats = tracker?.getStats();
        const lines: string[] = [
          '# 上下文压缩运行状态',
          '',
          '## 当前参数',
          `- contextWindow: ${current.contextWindow.toLocaleString()} tokens`,
          `- compactRatio: ${(current.compactRatio * 100).toFixed(0)}% (触发阈值 ${((current.contextWindow * current.compactRatio) / 1000).toFixed(0)}K tokens)`,
          `- retainRatio: ${(current.retainRatio * 100).toFixed(0)}% (自动压缩保留尾部 ${((current.contextWindow * current.retainRatio) / 1000).toFixed(0)}K tokens)`,
          `- recentKeep: ${current.recentKeep} 条 (手动 /compact 尾部消息数下限)`,
          `- 摘要输出上限: ${current.summaryMaxTokens.toLocaleString()} tokens (配置面 .lantai/compaction-config.json 的 summaryMaxTokens)`,
          '',
        ];

        if (persisted) {
          lines.push('## 已持久化的调优结果');
          lines.push(`- compactRatio: ${(persisted.compactRatio * 100).toFixed(0)}%`);
          lines.push(`- recentKeep: ${persisted.recentKeep} 条`);
          if (persisted.summaryMaxTokens !== undefined) {
            lines.push(`- 摘要输出上限: ${persisted.summaryMaxTokens.toLocaleString()} tokens`);
          }
          lines.push(`- 基于 ${persisted.sampleCount} 次压缩样本`);
          lines.push(`- 调优时间: ${new Date(persisted.tunedAt).toLocaleString()}`);
          lines.push(`- 依据: ${persisted.reasoning}`);
          lines.push('');
        }

        if (!stats) {
          lines.push('## 数据收集');
          lines.push('Tracker 未初始化。压缩数据将在压缩触发后自动记录。');
          return lines.join('\n');
        }

        lines.push('## 数据收集');
        lines.push(`- 已记录压缩: ${stats.events.length} 次 (需 ≥5 次才能自动调优)`);
        lines.push(`- 当前会话轮次: ${stats.totalTurns}`);
        lines.push(`- 重读文件: ${stats.reReadCount} 次`);
        lines.push(`- 重复工具调用: ${stats.duplicateToolCalls} 次`);
        lines.push(
          `- 估算信息丢失: ${((stats.reReadCount + stats.duplicateToolCalls) * LOSS_FACTOR_PER_EVENT).toFixed(1)} 轮`,
        );

        if (stats.events.length >= 5) {
          lines.push('');
          lines.push('✅ 样本充足，已触发自动调优。');
        } else if (stats.events.length > 0) {
          lines.push('');
          lines.push(`⏳ 还需 ${5 - stats.events.length} 次压缩才能自动调优。`);
        } else {
          lines.push('');
          lines.push('🆕 尚未触发压缩。会话 token 数达到阈值时将自动触发。');
        }

        if (stats.events.length > 0) {
          lines.push('');
          lines.push('## 压缩明细');
          lines.push('');
          for (let i = 0; i < stats.events.length; i++) {
            const e = stats.events[i];
            const turnsAfter = stats.turnsAfterCompaction[i] || 0;
            const ratio = e.regionTokensEst > 0 ? ((1 - e.postTokens / e.preTokens) * 100).toFixed(1) : '0';
            lines.push(
              `### #${i + 1} ${e.outcome === 'summary' ? '✅ 总结' : e.outcome === 'digest' ? '📋 机械提取' : e.outcome === 'truncated' ? '✂️ 截断' : '⏸️ 卡住'}`,
            );
            lines.push(`- 压缩 ${e.regionMsgCount} 条消息 → 摘要 ${e.summaryOutputTokens.toLocaleString()} tokens`);
            // 摘要调用账（2026-09-23）：发出的 cap + 提供方回报的 usage ——
            // 「空返回 = 思考吃满 cap」这类归因此前只能猜（usage 被整条丢弃）。
            if (e.summaryUsage) {
              lines.push(
                `- 摘要调用: ${e.summaryCalls ?? e.summaryUsage.calls} 次（${e.summaryUsage.calls} 次回报 usage）/ cap ${(e.summaryMaxTokens ?? 0).toLocaleString()} tokens · 输出 ${e.summaryUsage.completionTokens.toLocaleString()}（含思考 ${e.summaryUsage.reasoningTokens.toLocaleString()}）· 输入 ${e.summaryUsage.promptTokens.toLocaleString()}`,
              );
            } else if (e.summaryCalls !== undefined) {
              lines.push(
                `- 摘要调用: ${e.summaryCalls} 次 / cap ${(e.summaryMaxTokens ?? 0).toLocaleString()} tokens（提供方未回报 usage）`,
              );
            }
            if (e.summaryError) lines.push(`- 降级原因: ${e.summaryError}`);
            lines.push(
              `- 上下文: ${e.preTokens.toLocaleString()} → ${e.postTokens.toLocaleString()} tokens (${ratio}%)`,
            );
            lines.push(`- 压缩后继续: ${turnsAfter} 轮`);
          }
        }

        lines.push('');
        lines.push('---');
        lines.push('*数据由 CompactionTracker 自动记录，存储于 compaction-model.ts。*');

        return lines.join('\n');
      },
    }),
  ];
}
