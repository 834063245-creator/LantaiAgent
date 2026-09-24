// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 压缩**记账面**（批 6d-1，2026-09-24 从 compaction-model.ts 切出）——留内核。
//
// 为什么留内核：它是 **Agent 私有账本**（每 Agent 一份）+ loop 契约只读面
// （`agent/agent-loop/types.ts` 的 `compactionTracker`），且被 $HOME 卷级持久化
// （serializeState/deserializeState）——策略（成本模型/触发阈值/摘要提示）归产物包，
// 记账与状态归内核。切分先于搬家（批 6d-2 只搬策略与管线，不再动本文件）。

import { log } from './logger';

// ── 成本常量（Claude Sonnet，每 1M tokens）——记账面与策略面共读（策略侧经本文件 import）──

export const DEFAULT_C_IN = 3.0; // $3/1M 输入
export const DEFAULT_C_OUT = 15.0; // $15/1M 输出
/** ponytail: 每次重读或压缩后重复工具调用计为
 *  0.25 个额外轮次 — agent 通常恢复很快，不到一整轮。 */
export const LOSS_FACTOR_PER_EVENT = 0.25;

// ── 收集的指标 ──

export interface SummaryUsageTotals {
  /** 入账的调用数（< CompactionEvent.summaryCalls ⇒ 有调用未回报 usage） */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** 思考吃掉的输出预算 —— 「摘要为什么空」的答案就在这个数里 */
  reasoningTokens: number;
  cacheHitTokens: number;
}

export interface CompactionEvent {
  ts: number;
  /** 被压缩区域的消息数 */
  regionMsgCount: number;
  /** 压缩前区域的估算 token 数 */
  regionTokensEst: number;
  /** 摘要 LLM 调用实际消耗的 token 数（输入） */
  summaryInputTokens: number;
  /** 生成摘要的 token 数（输出） */
  summaryOutputTokens: number;
  /** 尾部保留的消息数（完整保留） */
  tailMsgCount: number;
  /** 压缩前估算的会话 token 数 */
  preTokens: number;
  /** 压缩后估算的会话 token 数 */
  postTokens: number;
  /** 结果: 'summary' = LLM 摘要 | 'digest' = 机械提取（LLM 降级） | 'truncated' | 'stuck' */
  outcome: 'summary' | 'truncated' | 'stuck' | 'digest';
  /** 本次压缩发出的摘要调用数（分块 map-reduce 时 > 1；含失败那次） */
  summaryCalls?: number;
  /** 写给提供方的输出上限（摘要 cap）—— 判定「吃满 cap」的分母 */
  summaryMaxTokens?: number;
  /** 提供方回报的摘要 usage 求和（真账；缺省 = 一次都没回报） */
  summaryUsage?: SummaryUsageTotals;
  /** 降级原因（截断到 cap / 空文本 / 提供方错误…）—— 「为什么退化」的落账面 */
  summaryError?: string;
}

export interface CompactionSessionStats {
  events: CompactionEvent[];
  /** 估算的跨所有剩余轮次节省的总 token 数 */
  estimatedTokensSaved: number;
  /** 压缩前读取的文件（用于检测重读） */
  filesReadPreCompact: Set<string>;
  /** 压缩后重读压缩前文件次数 */
  reReadCount: number;
  /** 压缩后重复的工具调用（同名 + 同参数签名） */
  duplicateToolCalls: number;
  /** 本会话总轮次 */
  totalTurns: number;
  /** 每次压缩后发生的轮次 */
  turnsAfterCompaction: number[];
}

export class CompactionTracker {
  private filesRead = new Set<string>();
  private toolSigs = new Set<string>();
  private totalTurns = 0;
  private events: CompactionEvent[] = [];
  private turnsAfter: number[] = [];
  private reReads = 0;
  private dupTools = 0;
  private currentPostCompactCounter = -1; // -1 = not post-compaction

  /** 每次 API stream 前调用。 */
  recordTurn(): void {
    this.totalTurns++;
    if (this.currentPostCompactCounter >= 0) {
      this.currentPostCompactCounter++;
    }
  }

  /** read_file_content 或 read_file 工具执行时调用。 */
  recordFileRead(filePath: string): void {
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    if (this.currentPostCompactCounter >= 0 && this.filesRead.has(norm)) {
      this.reReads++;
      log.info('compaction-tracker', 're-read detected', {
        file: norm,
        turnsAfterCompact: this.currentPostCompactCounter,
      });
    }
    this.filesRead.add(norm);
  }

  /** 任意工具执行时调用。追踪签名用于重复检测。 */
  recordToolCall(name: string, args: string): void {
    const sig = `${name}:${args.slice(0, 200)}`;
    if (this.currentPostCompactCounter >= 0 && this.toolSigs.has(sig)) {
      this.dupTools++;
      log.info('compaction-tracker', 'duplicate tool call detected', {
        tool: name,
        turnsAfterCompact: this.currentPostCompactCounter,
      });
    }
    this.toolSigs.add(sig);
  }

  /** 压缩完成后调用。 */
  recordCompaction(event: CompactionEvent): void {
    this.events.push(event);
    this.turnsAfter.push(0);
    this.currentPostCompactCounter = 0;
  }

  /** 计算会话级统计。 */
  getStats(): CompactionSessionStats {
    let totalTokensSaved = 0;
    for (const e of this.events) {
      totalTokensSaved += e.regionTokensEst - e.summaryOutputTokens;
    }

    return {
      events: this.events,
      estimatedTokensSaved: totalTokensSaved,
      filesReadPreCompact: this.filesRead,
      reReadCount: this.reReads,
      duplicateToolCalls: this.dupTools,
      totalTurns: this.totalTurns,
      turnsAfterCompaction: this.turnsAfter,
    };
  }

  /** 从收集的数据估算信息丢失因子 L。
   *  ponytail: 启发式 — 每次重读或重复工具调用计为
   *  0.25 个额外轮次（不到一整轮，因为 agent 通常恢复很快）。 */
  estimateLossFactor(): number {
    return (this.reReads + this.dupTools) * LOSS_FACTOR_PER_EVENT;
  }

  /** 从固定费率与 token 估算值计算平均轮次成本。 */
  estimateAvgTurnCost(avgInputTokens: number, avgOutputTokens: number): number {
    const cIn = DEFAULT_C_IN;
    const cOut = DEFAULT_C_OUT;
    return (avgInputTokens * cIn + avgOutputTokens * cOut) / 1_000_000;
  }

  reset(): void {
    // E5: 跨会话保留 events、turnsAfter 和 filesRead，
    // 使压缩调优不会在重启后从零开始。
    // 仅重置每会话的临时计数器。
    this.toolSigs.clear();
    this.totalTurns = 0;
    this.reReads = 0;
    this.dupTools = 0;
    this.currentPostCompactCounter = -1;
  }

  // ── E5: 跨会话持久化 ──

  /** 序列化持久状态用于跨会话存活。
   *  仅持久化 events、turnsAfter 和 filesRead — 每会话
   *  计数器（totalTurns、reReads、dupTools 等）每次会话重新开始。 */
  serializeState(): string {
    return JSON.stringify({
      events: this.events,
      turnsAfter: this.turnsAfter,
      filesRead: Array.from(this.filesRead),
    });
  }

  /** 从序列化字符串恢复状态。替换现有数据（非追加）。 */
  deserializeState(json: string): void {
    try {
      const data = JSON.parse(json) as {
        events?: CompactionEvent[];
        turnsAfter?: number[];
        filesRead?: string[];
      };
      // 替换而非追加 — 防止重复加载时累积重复数据
      if (Array.isArray(data.events)) {
        this.events = [...data.events];
      }
      if (Array.isArray(data.turnsAfter)) {
        this.turnsAfter = [...data.turnsAfter];
      }
      if (Array.isArray(data.filesRead)) {
        this.filesRead = new Set(data.filesRead);
      }
    } catch {
      /* 文件损坏 — 从零开始 */
    }
  }
}
